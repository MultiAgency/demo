/**
 * Offline verification of the npm-published SDK against the qualified SDK/gateway pair. The registry archive is
 * byte-identical to the retained candidate archive, so the lockfile's integrity, the retained archive and the
 * installed provenance must all name the same bytes and the same clean platform source/candidate.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GatewayPin = {
  runDigest: string; sourceHead: string; dependencyTree: string; snapshot: string;
  sdkVersion: string; sdkIntegrity: string; sdkTarball: string; sdkTarballSha256: string;
};

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sri = (bytes: Uint8Array) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function verifiedSdkPin() {
  const pin = JSON.parse(read("vendor/multiagency-sdk/gateway-pin.json").toString()) as GatewayPin;
  const declared = JSON.parse(read("package.json").toString()).dependencies["@multiagency/sdk"];
  if (declared !== pin.sdkVersion) throw new Error(`package.json must pin @multiagency/sdk exactly to ${pin.sdkVersion}`);
  const lock = read("bun.lock").toString();
  const entry = new RegExp(`"@multiagency/sdk": \\["@multiagency/sdk@${escape(pin.sdkVersion)}", "", \\{[^\\n]*\\}, "(sha512-[A-Za-z0-9+/=]+)"\\]`).exec(lock);
  if (!entry) throw new Error("bun.lock does not resolve the pinned registry SDK version");
  if (entry[1] !== pin.sdkIntegrity) throw new Error("bun.lock SDK integrity differs from the gateway pin");
  const retained = read(`vendor/multiagency-sdk/${pin.sdkTarball}`);
  if (sha256(retained) !== pin.sdkTarballSha256 || sri(retained) !== pin.sdkIntegrity)
    throw new Error("Retained qualified SDK archive differs from the pinned registry bytes");
  const installed = JSON.parse(read("node_modules/@multiagency/sdk/package.json").toString());
  if (installed.version !== pin.sdkVersion) throw new Error("Installed SDK version differs from the pin");
  const sidecar = read(`vendor/multiagency-sdk/${pin.sdkTarball.replace(/\.tgz$/, ".provenance.json")}`);
  const provenanceBytes = read("node_modules/@multiagency/sdk/provenance.json");
  if (!sidecar.equals(provenanceBytes)) throw new Error("Installed SDK provenance differs from the qualified artifact");
  const provenance = JSON.parse(provenanceBytes.toString());
  if (provenance.sourceHead !== pin.sourceHead || provenance.snapshot?.runDigest !== pin.runDigest || provenance.dirtyPaths.length !== 0)
    throw new Error("SDK/gateway source bindings differ");
  return { pin, provenanceSha256: sha256(provenanceBytes) };
}
