/**
 * Serve the web UI locally.
 *
 *   npm run web
 *
 * ES modules cannot be loaded over `file://`, so the page needs an origin. This is the
 * smallest thing that provides one: static files from `web/`, no dependencies, no caching,
 * localhost only.
 *
 * ## One endpoint: `/template.dn2prj`
 *
 * The browser cannot read the corpus, so the page used to make you pick the same blank
 * project by hand every single time. The CLI has no such problem — it locates the template
 * via `DN_TEMPLATE`, `DN_CORPUS` or a sibling checkout — and **this server is the CLI**. So it
 * hands the file over, and the page asks for it on load.
 *
 * The deployed static build has no server, that request 404s, and the picker stays as the
 * fallback. Same page either way, no build-time switch.
 *
 * **Why the template is still not bundled into the repository.** It would make the tool
 * self-contained and it is tempting. It is wrong for a reason that outlives the convenience:
 * a template must match the **storage version the device writes**, and ours is version 3 from
 * firmware 1.10E. Shipping one would quietly make it *the* template for every user on every
 * firmware, which is the versioning problem elk-herd solves by keeping a blank per version and
 * refusing when it has none. Reading the user's own device-authored `EMPTY.dn2prj` sidesteps
 * it entirely: their file is by definition the right version for their device.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { findTemplate } from "../librarian/open.js";
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

/** The path the page asks for its template on. Not a file inside `web/`. */
const TEMPLATE_ROUTE = "/template.dn2prj";

createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);

  if (path === TEMPLATE_ROUTE) {
    const template = findTemplate();
    if (!template) {
      // 404 rather than an error page: the page treats "no template here" as normal and
      // falls back to the picker, which is exactly what the deployed build always does.
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("no template found");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      // So the page can name what it loaded rather than saying "a template".
      "x-template-name": basename(template),
    });
    createReadStream(template).pipe(response);
    return;
  }

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
  const template = findTemplate();
  console.log(
    template
      ? `Template: ${template} — the page will load it, no need to pick one.`
      : "No template found. The page will ask you for one; set DN_TEMPLATE to skip that.",
  );
  console.log("Nothing leaves this machine — the page does all its work locally.");
});
