import { contractPackage } from "@multiagency/sdk";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryLedger } from "./support/recovery-ledger";
import { USDC_NEAR } from "../src/shared/terms";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const script = new URL("../scripts/collect-ledger-evidence.ts", import.meta.url).pathname;
const credential = `tap_00000000-0000-0000-0000-000000000001.${"a".repeat(43)}`;

type Scenario = "base" | "clean_success" | "refunded_success" | "refunded" | "failed_unknown_status" | "succeeded_unknown_status" | "unknown_payment_status";
function fixture(changeSnapshot = false, scenario: Scenario = "base") {
  const f = recoveryLedger();
  directories.push(f.directory);
  const manifest = join(f.directory, "binding.json"), credentialFile = join(f.directory, "credential"), preload = join(f.directory, "http-fixture.ts");
  writeFileSync(manifest, JSON.stringify(f.binding));
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(join(f.directory, ".env"), "PLATFORM=remote\nPUBLIC_URL=invalid-private-fixture-origin\nDB_PATH=must-not-exist.sqlite\n");
  // The CLI itself has no fixture/network bypass. Bun's test-only preload replaces fetch before SDK import.
  writeFileSync(preload, `import {appendFileSync,writeFileSync} from "node:fs";
const scenario = ${JSON.stringify(scenario)};
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://platform.invalid" || init.method !== "POST") throw new Error("Unexpected fixture request");
  const name = url.pathname.split("/rpc/")[1];
  if (!["payouts/status","paymentStatus","held","owner/status"].includes(name)) throw new Error("Mutation forbidden");
  appendFileSync("calls.jsonl", JSON.stringify({path:url.pathname,method:init.method})+"\\n");
  ${changeSnapshot ? 'if(name==="payouts/status")writeFileSync("snapshot.sqlite","external-fixture-writer-changed-snapshot");' : ""}
  const request = {recipient:"builder.demo",asset:"${USDC_NEAR}",amount:"300000000",chain:"near",confidential:true,private_notes:"PRIVATE-REQUEST-NOTES"};
  const values = {
    "payouts/status":{requestId:"fixture-request",state:"failed",status:"FAILED",correlationId:"fixture-payment",code:null,neverExecuted:true,private_report:"PRIVATE-REPORT"},
    "paymentStatus":{status:"FAILED",failureCode:null,createdAt:null,updatedAt:null,request,approvalId:"fixture-approval",expiresAt:null,detailError:"PRIVATE-ERROR",evidence:{txHash:null,destinationTxHash:null,refundTxHash:null,refundTo:null,refundedAmount:null},confirm:{url:"PRIVATE-CONFIRMATION"}},
    "held":[{correlationId:"PRIVATE-UNRELATED-PAYMENT",approvalId:"PRIVATE-UNRELATED-APPROVAL",kind:"local",request,at:"2026-11-11T12:00:00Z"}],
    "owner/status":{stage:"expired",phase:"expired",error:"PRIVATE-OWNER-ERROR",intent:{payload:"PRIVATE-SIGNING-MATERIAL"}}
  };
  if(scenario!=="base") {
    values.held=[];
    values["payouts/status"].neverExecuted=false;
    if(["clean_success","refunded_success","succeeded_unknown_status"].includes(scenario)) {
      values["payouts/status"].state="succeeded";
      values["payouts/status"].status="SUCCESS";
      values["paymentStatus"].status="SUCCESS";
      values["paymentStatus"].evidence.txHash="fixture-success-tx";
      values["paymentStatus"].evidence.destinationTxHash="fixture-destination-tx";
    }
    if(scenario==="refunded_success") values["paymentStatus"].evidence.refundedAmount="300000000";
    if(scenario==="refunded") {
      values["payouts/status"].status="REFUNDED";
      values["paymentStatus"].status="REFUNDED";
      values["paymentStatus"].evidence.refundedAmount="300000000";
    }
    if(scenario.endsWith("unknown_status")) values["payouts/status"].status=null;
    if(scenario==="unknown_payment_status") {
      values["payouts/status"].neverExecuted=true;
      values["paymentStatus"].status="NEEDS_REVIEW";
    }
  }
  return Response.json({json:values[name]});
};
`);
  return { ...f, manifest, credentialFile, preload };
}

async function run(f: ReturnType<typeof fixture>, args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", f.preload, script, ...args], {
    cwd: f.directory, env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test("collector help and unsupported options cannot load credentials, application state or network", async () => {
  const f = fixture(), files = readdirSync(f.directory);
  const help = await run(f, ["--help"]);
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain("never clearance");
  expect(help.stderr).toBe("");
  for (const args of [[], ["--repair"], [f.path, f.manifest], [f.path, f.manifest, f.credentialFile, "--force"]]) {
    const result = await run(f, args);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid_arguments");
  }
  expect(readdirSync(f.directory)).toEqual(files);
});

test("actual CLI/installed SDK emits only an advisory report without touching source or loading dotenv", async () => {
  const f = fixture(), bytes = readFileSync(f.path), bindingBytes = readFileSync(f.manifest), secretBytes = readFileSync(f.credentialFile);
  const result = await run(f, [f.path, f.manifest, f.credentialFile]);
  expect(result.exit).toBe(2);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.collection).toMatchObject({ clearance: "none", complete: true, unmatched_held_count: 1, snapshot: f.inspection.snapshot, sdk_version: contractPackage.version });
  expect(report.preview).toMatchObject({ clearance: "none", requires_review: true });
  for (const privateValue of [credential, "PRIVATE-REQUEST-NOTES", "PRIVATE-REPORT", "PRIVATE-ERROR", "PRIVATE-CONFIRMATION", "PRIVATE-UNRELATED", "PRIVATE-OWNER-ERROR", "PRIVATE-SIGNING-MATERIAL"])
    expect(result.stdout + result.stderr).not.toContain(privateValue);
  const calls = readFileSync(join(f.directory, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.path.split("/rpc/")[1])).toEqual(["payouts/status", "paymentStatus", "owner/status", "held"]);
  expect(calls.every(call => call.method === "POST")).toBe(true);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(readFileSync(f.manifest)).toEqual(bindingBytes);
  expect(readFileSync(f.credentialFile)).toEqual(secretBytes);
  expect(readdirSync(f.directory).some(name => name.endsWith("-wal") || name.endsWith("-shm") || name === "must-not-exist.sqlite")).toBe(false);
});

test("wrong binding fails before credential loading or any SDK read and never echoes private values", async () => {
  const f = fixture();
  writeFileSync(f.manifest, JSON.stringify({ ...f.binding, organization: "PRIVATE-WRONG-ORGANIZATION" }));
  const result = await run(f, [f.path, f.manifest, join(f.directory, "PRIVATE-MISSING-CREDENTIAL")]);
  expect(result).toEqual({ exit: 1, stdout: "", stderr: "Evidence collection could not produce a report. (collection_failed)\n" });
  expect(readdirSync(f.directory)).not.toContain("calls.jsonl");
});

test("an unsafe credential header is refused before any SDK read without echoing its contents", async () => {
  const f = fixture();
  writeFileSync(f.credentialFile, "tap_PRIVATE-FIXTURE\r\nInjected: PRIVATE-HEADER");
  const result = await run(f, [f.path, f.manifest, f.credentialFile]);
  expect(result).toEqual({ exit: 1, stdout: "", stderr: "Evidence collection could not produce a report. (collection_failed)\n" });
  expect(readdirSync(f.directory)).not.toContain("calls.jsonl");
});

test("an external snapshot change during collection prevents every partial report", async () => {
  const f = fixture(true);
  const result = await run(f, [f.path, f.manifest, f.credentialFile]);
  expect(result).toEqual({ exit: 1, stdout: "", stderr: "Evidence collection could not produce a report. (collection_failed)\n" });
  expect(readFileSync(f.path, "utf8")).toBe("external-fixture-writer-changed-snapshot");
});

for (const [scenario, category, subtotal, successes, excluded] of [
  ["clean_success", "payment_reported", "300000000", ["fixture-request"], []],
  ["refunded_success", "contradictory", "0", ["fixture-request"], ["fixture-request"]],
  ["refunded", "retain_commitment", "0", [], []],
  ["failed_unknown_status", "retain_commitment", "0", [], []],
  ["succeeded_unknown_status", "retain_commitment", "0", ["fixture-request"], ["fixture-request"]],
  ["unknown_payment_status", "retain_commitment", "0", [], []],
] as const) test(`SDK parsing through the CLI preserves ${scenario} semantics and review-only subtotals`, async () => {
  const f = fixture(false, scenario), bytes = readFileSync(f.path);
  const result = await run(f, [f.path, f.manifest, f.credentialFile]);
  expect(result.exit).toBe(2);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.collection.complete).toBe(true);
  expect(report.preview).toMatchObject({ clearance: "none", requires_review: true });
  expect(report.preview.items[0].category).toBe(category);
  expect(report.preview.accounting).toMatchObject({ matched_status_report_subtotal_atomic: subtotal,
    all_reported_success_request_ids: [...successes], excluded_success_request_ids: [...excluded] });
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(result.stdout + result.stderr).not.toContain(credential);
});
