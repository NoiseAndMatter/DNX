import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveStaticPath } from "../src/cli/staticpath.js";

/**
 * The regression these exist for: `npm run web` served "not found" for every request on
 * Windows, including `/`, with `web/index.html` present the whole time. The root came from a
 * URL pathname (forward slashes) and the target from `path.join` (backslashes), so the
 * containment check `startsWith` never matched.
 *
 * It survived because nothing tested it — the page was only ever opened on a machine where
 * the separators happened to agree.
 */

const ROOT = fileURLToPath(new URL("../web/", import.meta.url));

test("the site root serves index.html", () => {
  const { path } = resolveStaticPath(ROOT, "/");
  assert.ok(path, "/ must resolve");
  assert.ok(path.endsWith(`${sep}index.html`), `expected index.html, got ${path}`);
});

test("the resolved path is a real file in this repository", () => {
  // The bug was invisible to any test that only checked string shapes, so this one insists
  // the answer points at something that actually exists.
  const { path } = resolveStaticPath(ROOT, "/");
  assert.ok(existsSync(path!), `${path} should exist — this is the exact 404 bug`);
});

test("a nested asset resolves beneath the root", () => {
  const { path } = resolveStaticPath(ROOT, "/dist/app.js");
  assert.ok(path);
  assert.ok(path.startsWith(ROOT.replace(/[\\/]$/, "")), "must stay under the root");
  assert.ok(path.endsWith(`${sep}dist${sep}app.js`));
});

test("the separators of root and target agree", () => {
  // The whole bug in one assertion: mixing URL and filesystem separators.
  const { path } = resolveStaticPath(ROOT, "/dist/app.js");
  assert.ok(path);
  if (sep === "\\") {
    assert.ok(!path.includes("/"), `a Windows path should not contain forward slashes: ${path}`);
  }
});

test("traversal in a URL path collapses to the root instead of escaping", () => {
  // Worth pinning down, because it is not what it looks like: `normalize` resolves ".."
  // against the path's *own* root, so "/../../etc/passwd" becomes "/etc/passwd" before `join`
  // ever sees it, and the result lands inside the root rather than being refused. The guard
  // below is defence in depth, not the thing doing the work here.
  const base = ROOT.replace(/[\\/]$/, "");
  for (const attempt of ["/../secrets.txt", "/../../etc/passwd", "/dist/../../package.json"]) {
    const { path, refused } = resolveStaticPath(ROOT, attempt);
    assert.equal(refused, undefined, `${attempt} is neutralised, not refused`);
    assert.ok(path!.startsWith(base + sep), `${attempt} escaped the root as ${path}`);
  }
});

test("a relative path that does escape is refused", () => {
  // Without a leading slash there is no root for ".." to collapse against, so this one really
  // does climb out — and must be caught. It also covers the prefix trap: `startsWith(base)`
  // alone would accept "web-secrets" for a root of "web", so the check lands on a separator.
  const { path, refused } = resolveStaticPath("/srv/web", "../web-secrets/keys.txt");
  assert.equal(refused, "escapes-root");
  assert.equal(path, undefined);
});

test("an empty path is treated as the root", () => {
  assert.ok(resolveStaticPath(ROOT, "")!.path?.endsWith(`${sep}index.html`));
});

test("existence is the caller's question, not this one's", () => {
  // "outside the root" and "not there" deserve different answers: one is a refusal, the other
  // a plain 404, and collapsing them hides traversal attempts.
  const { path, refused } = resolveStaticPath(ROOT, "/definitely-not-here.css");
  assert.equal(refused, undefined);
  assert.ok(path, "a missing file still resolves; the server checks existsSync");
});
