/** Check the installed SDK against the retained, byte-verified release artifact without registry access. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path));
const pin = JSON.parse(read("vendor/multiagency-sdk/gateway-pin.json").toString());
const artifact = JSON.parse(read("package.json").toString()).dependencies["@multiagency/sdk"] as string;
if (!artifact.startsWith("./vendor/multiagency-sdk/") || artifact.includes("..")) throw new Error("Expected the retained repository-local SDK artifact");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (sha(read(artifact)) !== pin.sdkTarballSha256) throw new Error("SDK archive differs from gateway pin");
const sidecar = read(artifact.replace(/\.tgz$/, ".provenance.json"));
const installed = read("node_modules/@multiagency/sdk/provenance.json");
if (!sidecar.equals(installed)) throw new Error("Installed SDK provenance differs from verified artifact");
const provenance = JSON.parse(installed.toString());
if (provenance.sourceHead !== pin.sourceHead || provenance.snapshot.runDigest !== pin.runDigest || provenance.dirtyPaths.length !== 0)
  throw new Error("SDK/gateway source bindings differ");
console.log(JSON.stringify({ sdk_sha256: pin.sdkTarballSha256, source: pin.sourceHead, gateway: pin.runDigest, provenance_sha256: sha(installed) }, null, 2));
