/** Check the npm-pinned SDK against the qualified SDK/gateway pair without registry access. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifiedSdkPin } from "./sdk-pin";
const root = resolve(import.meta.dir, "..");
const { pin, provenanceSha256 } = verifiedSdkPin();
// Keep active release guidance bound to the actual pinned artifact, including in CI.
const release = JSON.parse(readFileSync(resolve(root, "docs/release-status.json"), "utf8"));
if (release.pins.sdk_version !== pin.sdkVersion)
  throw new Error("Release status SDK version differs from the pinned SDK");
if (release.pins.sdk_sha256 !== pin.sdkTarballSha256 || release.pins.platform_source !== pin.sourceHead || release.pins.gateway_candidate !== pin.runDigest)
  throw new Error("Release status differs from active SDK/gateway pins");
for (const [name, actual] of [["PAPERWORK_PLATFORM_SOURCE", pin.sourceHead],
  ["PAPERWORK_PLATFORM_CANDIDATE", pin.runDigest], ["PAPERWORK_SDK_SHA256", pin.sdkTarballSha256]] as const) {
  const expected = process.env[name];
  if (expected && expected !== actual) throw new Error(`${name} differs from the pinned SDK/platform pair`);
}
console.log(JSON.stringify({ sdk_version: pin.sdkVersion, sdk_integrity: pin.sdkIntegrity, sdk_sha256: pin.sdkTarballSha256, source: pin.sourceHead, gateway: pin.runDigest, provenance_sha256: provenanceSha256 }, null, 2));
