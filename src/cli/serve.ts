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
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../../web/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env["PORT"] ?? 8173);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);
  // normalize() collapses any ".." before it can climb out of web/.
  const target = join(ROOT, normalize(path === "/" ? "index.html" : path));

  if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
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
