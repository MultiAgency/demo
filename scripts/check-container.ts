/** Isolated Linux packaging smoke test. No network, real credentials or payment actions. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const image = process.argv[2];
if (!image) throw new Error("Usage: bun --no-env-file scripts/check-container.ts <local-image> [artifact-directory]");
const artifacts = resolve(process.argv[3] ?? `/tmp/paperwork-container-${randomUUID()}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const name = `paperwork-smoke-${randomUUID()}`;
const volume = `${name}-data`;
const credential = "tap_container_smoke_fixture_only";
const secret = "container-smoke-auth-secret-fixture-only-123456789";
const sdkVersion = JSON.parse(readFileSync(new URL("../node_modules/@multiagency/sdk/package.json", import.meta.url), "utf8")).version;
const pin = JSON.parse(readFileSync(new URL("../vendor/multiagency-sdk/gateway-pin.json", import.meta.url), "utf8"));
const env: Record<string, string> = {
  PLATFORM: "remote", PLATFORM_URL: "https://platform.invalid", PLATFORM_DEPLOYMENT: "multiagency-paperwork",
  PLATFORM_CREDENTIAL: credential, BETTER_AUTH_SECRET: secret, PUBLIC_URL: "https://paperwork.invalid",
  DB_PATH: "/data/paperwork.sqlite", REQUIRED_MOUNT: "/data", RAILWAY_VOLUME_MOUNT_PATH: "/data",
  GITHUB: "fake", JUDGE: "rules", AGENT_POLL_MS: "0", PORT: "8080",
};
let volumeCreated = false, containerCreated = false;
const checks: string[] = [];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function docker(args: string[], allowFailure = false) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (!allowFailure) check(code === 0, `docker ${args[0]} failed: ${stderr || stdout}`);
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}
const vars = (values: Record<string, string>) => Object.entries(values).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
async function evaluate<T>(source: string): Promise<T> {
  return JSON.parse((await docker(["exec", name, "bun", "--no-env-file", "-e", source])).stdout);
}
async function request(path: string, method = "GET") {
  return evaluate<{ status: number; body: string; cache: string | null }>(`const r=await fetch(${JSON.stringify(`http://127.0.0.1:8080${path}`)},{method:${JSON.stringify(method)},headers:{host:'paperwork.invalid'}});console.log(JSON.stringify({status:r.status,body:await r.text(),cache:r.headers.get('cache-control')}));`);
}
async function ready() {
  for (const until = Date.now() + 30_000; Date.now() < until; await Bun.sleep(250)) {
    try { if ((await request("/api/health")).status === 200) return; } catch {}
  }
  throw new Error("Container did not become healthy");
}
try {
  const inspect = JSON.parse((await docker(["image", "inspect", image])).stdout)[0];
  check(inspect.Os === "linux", "Expected a Linux image");
  writeFileSync(join(artifacts, "image.json"), JSON.stringify({ id: inspect.Id, os: inspect.Os, architecture: inspect.Architecture }, null, 2));
  const sdkCheck = await docker(["run", "--rm", "--network", "none", "--entrypoint", "bun", image, "--no-env-file", "-e",
    `import{readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';const files=readdirSync('vendor/multiagency-sdk');const sdk=JSON.parse(readFileSync('node_modules/@multiagency/sdk/package.json','utf8'));const p=JSON.parse(readFileSync('node_modules/@multiagency/sdk/provenance.json','utf8'));const tar=JSON.parse(readFileSync('package.json','utf8')).dependencies['@multiagency/sdk'];console.log(JSON.stringify({files,version:sdk.version,source:p.sourceHead,sha256:createHash('sha256').update(readFileSync(tar)).digest('hex')}));`]);
  const sdk = JSON.parse(sdkCheck.stdout);
  check(sdk.version === sdkVersion && sdk.source === pin.sourceHead && sdk.sha256 === pin.sdkTarballSha256, "Image SDK does not match validated pins");
  check(sdk.files.length === 1 && sdk.files[0] === pin.sdkTarball, "Image contains inactive SDK artifacts");
  checks.push("Linux image contains exact SDK and no inactive vendor artifacts");
  for (const [label, values, expected] of [
    ["missing platform", {}, "Set PLATFORM"],
    ["missing volume declaration", { ...env, RAILWAY_VOLUME_MOUNT_PATH: "" }, "No volume is mounted"],
    ["off-volume database", { ...env, DB_PATH: "/tmp/off-volume.sqlite" }, "DB_PATH must be on the volume"],
    ["insecure public origin", { ...env, PUBLIC_URL: "http://paperwork.invalid" }, "https origin"],
    ["production stack injection", { ...env, PLATFORM_STACK_DIR: "/tmp/not-a-stack" }, "refused when NODE_ENV=production"],
  ] as const) {
    const result = await docker(["run", "--rm", "--network", "none", ...vars(values), image], true);
    writeFileSync(join(artifacts, `refused-${label.replaceAll(" ", "-")}.log`), result.stdout + result.stderr);
    check(result.code !== 0 && (result.stdout + result.stderr).includes(expected), `Startup did not refuse ${label}`);
  }
  checks.push("Production startup refuses missing platform/mount, off-volume DB, insecure origin and local stack injection");
  await docker(["volume", "create", volume]); volumeCreated = true;
  await docker(["run", "--detach", "--name", name, "--network", "none", "--mount", `type=volume,source=${volume},target=/data`, ...vars(env), image]); containerCreated = true;
  await ready();
  const container = JSON.parse((await docker(["inspect", name])).stdout)[0];
  check(container.HostConfig.NetworkMode === "none", "Smoke container has network access");
  const config = await request("/api/config");
  check(config.status === 200 && !config.body.includes(credential) && !config.body.includes(secret), "Config exposed fixture secrets or failed");
  const cfg = JSON.parse(config.body);
  check(cfg.platform === "remote" && cfg.demo_controls === false && cfg.auth.required === true && cfg.judge.kind === "rules" && !cfg.review?.enabled, "Image enabled demo or paid review behavior");
  check((await request("/api/sim/sign", "POST")).status === 404, "Production enabled simulator routes");
  check((await request("/api/contracts")).status === 200 && (await request("/api/contracts")).body === "[]", "Signed-out listing exposed jobs");
  checks.push("Production has auth required, no demo routes, no paid review and no credential disclosure");
  const seed = `import{Database}from'bun:sqlite';import{DEMO_TERMS}from'./src/shared/demo';import{canonicalJson,sha256Hex}from'./src/shared/canonical';import{termsHash,TERMS_RECIPIENT}from'./src/shared/terms';const d=new Database('/data/paperwork.sqlite');d.query('INSERT INTO contracts (id,terms,hash,created_at,contractor_link_hash,organization,signing_recipient) VALUES (?,?,?,?,?,?,?)').run('c_container_smoke',canonicalJson(DEMO_TERMS),termsHash(DEMO_TERMS),'2026-11-12T00:00:00Z',sha256Hex('fixture-invitation-only'),'container-smoke-org',TERMS_RECIPIENT);console.log(JSON.stringify(d.query('SELECT id,hash,organization,signing_recipient FROM contracts WHERE id=?').get('c_container_smoke')));d.close();`;
  const before = await evaluate(seed);
  for (const path of ["/api/contracts/c_container_smoke", "/api/contracts/c_container_smoke/verify", "/api/contracts/c_container_smoke/signing-request?role=contractor"]) {
    const response = await request(path); check(response.status === 401 && response.cache === "no-store", `Private route/cache not protected: ${path}`);
  }
  const publicStatus = await request("/api/contracts/c_container_smoke/verify/public");
  check(publicStatus.status === 200, "Public verification unavailable");
  check(Object.keys(JSON.parse(publicStatus.body)).sort().join(",") === "checked_at,checks,overall,terms_hash,workflow_version", "Public verification leaked detailed fields");
  checks.push("Known v2 fixture remains private; public verification is minimal");
  const page = await request("/"); check(page.status === 200 && page.body.includes("Paperwork"), "Production frontend did not serve");
  writeFileSync(join(artifacts, "index.html"), page.body);
  const assets = [...page.body.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(match => match[1]!);
  check(assets.some(path => path.includes(".js")), "Frontend has no JavaScript asset");
  const assetHashes: Record<string, string> = {};
  for (const [i, path] of assets.entries()) {
    const url = new URL(path, "http://paperwork.invalid"); check(url.host === "paperwork.invalid", "Frontend asset leaves app origin");
    const response = await request(url.pathname + url.search); check(response.status === 200, "Frontend asset failed");
    writeFileSync(join(artifacts, `asset-${i}.${path.includes(".css") ? "css" : "js"}`), response.body);
    assetHashes[path] = createHash("sha256").update(response.body).digest("hex");
  }
  await docker(["restart", name]); await ready();
  const after = await evaluate(`import{Database}from'bun:sqlite';const d=new Database('/data/paperwork.sqlite',{readonly:true});console.log(JSON.stringify(d.query('SELECT id,hash,organization,signing_recipient FROM contracts WHERE id=?').get('c_container_smoke')));d.close();`);
  check(JSON.stringify(before) === JSON.stringify(after), "Restart lost or rewrote durable job identity");
  check((await request("/api/contracts/c_container_smoke")).status === 401, "Restart removed private-read protection");
  for (const path of assets) {
    const url = new URL(path, "http://paperwork.invalid"); const response = await request(url.pathname + url.search);
    writeFileSync(join(artifacts, "restart-asset-observation.json"), JSON.stringify({ path, status: response.status, expected: assetHashes[path], observed: createHash("sha256").update(response.body).digest("hex") }, null, 2));
    check(response.status === 200 && createHash("sha256").update(response.body).digest("hex") === assetHashes[path], "Restart changed frontend artifact bytes");
  }
  checks.push("Named volume preserves original job identity and frontend bytes across local container restart");
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ passed: true, scope: "Linux production packaging, network disabled; synthetic SQLite fixture, no wallet/provider/payment", image: inspect.Id, os: inspect.Os, architecture: inspect.Architecture, sdk, checks, assetHashes, pins: pin }, null, 2));
  console.log(`PASS container packaging; receipt ${join(artifacts, "receipt.json")}`);
} catch (error) {
  if (containerCreated) { const logs = await docker(["logs", name], true); writeFileSync(join(artifacts, "container.log"), logs.stdout + logs.stderr); }
  writeFileSync(join(artifacts, "failure.txt"), String(error)); throw error;
} finally {
  if (containerCreated) await docker(["rm", "--force", name]);
  if (volumeCreated) await docker(["volume", "rm", volume]);
}
