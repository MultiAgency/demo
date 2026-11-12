/** Production serves a verified build eagerly, including assets requested before the HTML after restart. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";

export function frontendRoutes(directory: string): Record<string, Response> {
  const root = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")) as {
    version: number; entry: string; files: { path: string; bytes: number; sha256: string }[];
  };
  if (manifest.version !== 1 || manifest.entry !== "index.html" || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error("Invalid frontend artifact manifest");
  const routes: Record<string, Response> = {};
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(?:html|js|css|svg|png|jpg|jpeg|webp|woff2?)$/.test(file.path) || file.path.split("/").some(part => part === "." || part === "..") || file.path.startsWith("api/") || routes[`/${file.path}`])
      throw new Error("Unsafe or duplicate frontend artifact path");
    const path = resolve(root, file.path);
    if (!path.startsWith(root + sep) || lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(root + sep))
      throw new Error("Frontend artifact leaves its directory");
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error("Frontend artifact does not match its manifest");
    routes[`/${file.path}`] = new Response(bytes, { headers: {
      "Content-Type": Bun.file(path).type,
      "Cache-Control": file.path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
      ETag: `"${file.sha256}"`,
    } });
  }
  if (!routes["/index.html"]) throw new Error("Frontend entry HTML is missing");
  routes["/"] = routes["/index.html"]!;
  return routes;
}
