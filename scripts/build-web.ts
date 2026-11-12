/** Build once; retain the complete directory and manifest as an immutable frontend artifact. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
const directory = resolve(process.argv[2] ?? "web-dist");
if (existsSync(directory)) throw new Error("Frontend destination already exists; preserve it and choose a new directory");
const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/web/index.html")], outdir: directory, target: "browser", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Frontend build failed; retained partial artifact is not publishable");
const files = result.outputs.map(output => {
  const path = relative(directory, output.path);
  const bytes = readFileSync(output.path);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}).sort((a, b) => a.path.localeCompare(b.path));
if (!files.some(file => file.path === "index.html")) throw new Error("Frontend build has no entry HTML");
writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version: 1, entry: "index.html", files }, null, 2) + "\n");
console.log(`Built ${files.length} frontend files: ${directory}`);
