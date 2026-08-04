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
 * **Why this endpoint still matters now that a blank ships with the code.**
 * `src/librarian/blankproject.ts` does carry a device-authored `.dn2prj`, and `web/src/donor.ts`
 * falls back to it so no page is ever left with nothing. That does not retire this route, because
 * the objection to bundling was never about convenience: a template must match the **storage
 * version the device writes**, and the embedded one is version 3 from firmware 1.10E. Shipping it
 * as *the* template would quietly impose that version on every user on every firmware — the
 * problem elk-herd solves by keeping a blank per version and refusing when it has none.
 *
 * So the order is: the user's own `EMPTY.dn2prj` when this server can find it, because their file
 * is by definition the right version for their device; the embedded blank only as a floor, and it
 * says which firmware it came from when it is used.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findTemplate } from "../librarian/open.js";
import { htmlFallback, resolveStaticPath } from "./staticpath.js";

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

/**
 * Warn when the served build is older than the source it was built from.
 *
 * `npm run web` rebuilds before it starts, so this is never true at startup — which is
 * exactly why the check belongs on the *request*. The failure it catches is a server left
 * running from an earlier session: the page silently serves stale JavaScript, the new option
 * you just added appears to do nothing, and there is no way to tell from the browser.
 *
 * That cost an hour once. Same principle as stamping the build time into a project name:
 * never let someone test a build without knowing which build it is.
 */
function warnIfStale(): void {
  const built = join(ROOT, "dist", "web", "src", "app.js");
  if (!existsSync(built)) return;

  const builtAt = statSync(built).mtimeMs;
  const newest = newestSourceTime(fileURLToPath(new URL("../../src/", import.meta.url)));
  const newestWeb = newestSourceTime(join(ROOT, "src"));

  if (Math.max(newest, newestWeb) > builtAt) {
    console.warn(
      "\n  ⚠ The built page is older than the source. You are looking at a stale build.\n" +
        "    Restart: stop this server and run `npm run web` again.\n",
    );
  }
}

/** Newest mtime of any `.ts` beneath a folder, or 0 when there is none. */
function newestSourceTime(dir: string): number {
  let newest = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  try {
    walk(dir);
  } catch {
    // No sources to compare against — a packaged copy, say. Nothing to warn about.
  }
  return newest;
}

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

  // Checked per request, not at startup: `npm run web` always builds first, so the case
  // worth catching is a server left running from an earlier session.
  if (path === "/" || /\/(index|manager|probe)(\.html)?$/.test(path)) warnIfStale();

  const { path: target } = resolveStaticPath(ROOT, path);
  // `/manager` is what anyone types. Try the literal path first so a real extensionless file
  // still wins, then the `.html` they meant.
  const served = [target, target && htmlFallback(target)].find(
    (candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile(),
  );

  if (!served) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "content-type": TYPES[extname(served)] ?? "application/octet-stream",
    "cache-control": "no-store",
    // **So a page can say which build it is running.** `npm run web` rebuilds, but only when it is
    // restarted — so a pulled fix and a stale `web/dist` are indistinguishable in the browser, and
    // a debugging session was spent on a stall without knowing whether the fix for it was even in
    // the code being served. A module can `HEAD` its own URL and read this.
    "last-modified": statSync(served).mtime.toUTCString(),
  });
  createReadStream(served).pipe(response);
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
