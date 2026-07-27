/**
 * Serve the web UI locally.
 *
 *   npm run web
 *
 * ES modules cannot be loaded over `file://`, so the page needs an origin. This is the
 * smallest thing that provides one: static files from `web/`, no dependencies, no caching,
 * localhost only.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStaticPath } from "./staticpath.js";

// fileURLToPath rather than `.pathname` with a drive-letter regex: the latter leaves forward
// slashes on Windows, which made the containment check below never match, and leaves %20
// undecoded, which breaks any checkout in a path containing a space.
const ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const PORT = Number(process.env["PORT"] ?? 8173);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);
  const { path: target } = resolveStaticPath(ROOT, path);

  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(response);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`DNX web UI: http://127.0.0.1:${PORT}`);
  console.log("Nothing leaves this machine — the page does all its work locally.");
});
