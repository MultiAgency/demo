import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { frontendRoutes } from "../src/server/frontend";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "paperwork-frontend-")); dirs.push(dir);
  const files = [["index.html", '<script src="/index-fixed.js"></script>'], ["index-fixed.js", "console.log('fixture');"]].map(([path, text]) => {
    writeFileSync(join(dir, path!), text!);
    return { path: path!, bytes: Buffer.byteLength(text!), sha256: createHash("sha256").update(text!).digest("hex") };
  });
  const save = (entries = files) => writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, entry: "index.html", files: entries }));
  save(); return { dir, files, save };
}
test("production assets are available before HTML and keep immutable bytes across loader restarts", async () => {
  const { dir } = fixture();
  const first = frontendRoutes(dir), second = frontendRoutes(dir);
  expect(await first["/index-fixed.js"]!.text()).toBe(await second["/index-fixed.js"]!.text());
  expect(first["/index-fixed.js"]!.headers.get("Cache-Control")).toContain("immutable");
  expect(first["/"]!.headers.get("Cache-Control")).toBe("no-cache");
});
test("production startup refuses corrupt, duplicate or missing-entry frontend artifacts", () => {
  const { dir, files, save } = fixture();
  writeFileSync(join(dir, "index-fixed.js"), "corrupt");
  expect(() => frontendRoutes(dir)).toThrow("manifest");
  save([files[0]!, files[0]!]); expect(() => frontendRoutes(dir)).toThrow("duplicate");
  save([]); expect(() => frontendRoutes(dir)).toThrow();
});
test("frontend manifests cannot serve a parent path or an outside symlink", () => {
  const { dir, files, save } = fixture();
  save([{ ...files[0]!, path: "../escape.js" }]); expect(() => frontendRoutes(dir)).toThrow("path");
  symlinkSync("/dev/null", join(dir, "outside.js"));
  save([{ ...files[0]!, path: "outside.js" }]); expect(() => frontendRoutes(dir)).toThrow("directory");
});
