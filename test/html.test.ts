/**
 * The one HTML escaper.
 *
 * **Written because there were seven, and they were not equal.** Six escaped `& < > "`; the seventh
 * — in `web/src/grid.ts`, the module both browser pages render every slot through — did not escape
 * quotes. Nothing was visibly broken, because the grid interpolates into element text rather than
 * into an attribute, but that is a property of today's markup and not of the function, and it was
 * exported for anyone to pick up.
 *
 * The quote case is therefore the point of this file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml } from "../src/sheet/html.js";

test("the four characters that change how markup parses", () => {
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml(">"), "&gt;");
  assert.equal(escapeHtml('"'), "&quot;");
});

test("a quote is escaped — the case the divergent copy missed", () => {
  // A sound named with a quote, interpolated into an attribute, is how this would have bitten:
  // the value would close the attribute early and the rest would parse as markup.
  const name = 'BD "FAT"';
  assert.equal(escapeHtml(name), "BD &quot;FAT&quot;");
  assert.ok(!escapeHtml(`<b title="${name}">`).includes('="BD "'), "the attribute can still be broken out of");
});

test("ampersands are escaped first, so an escape is not escaped twice", () => {
  // `&lt;` must not come back as `&amp;lt;`. A replace chain that handled `<` before `&` would do
  // exactly that, which is why this uses a single pass over a character class.
  assert.equal(escapeHtml("a < b & c"), "a &lt; b &amp; c");
  assert.equal(escapeHtml("&amp;"), "&amp;amp;", "escaping is not idempotent, and must not pretend to be");
});

test("text with nothing to escape comes back unchanged", () => {
  // Real sound and pattern names, which is nearly every call: no allocation of surprises.
  for (const name of ["HEAVY KICK CD", "HH TICK", "A1", "SD FUR", ""]) {
    assert.equal(escapeHtml(name), name);
  }
});

test("every character is escaped, not just the first of each", () => {
  assert.equal(escapeHtml("<<>>"), "&lt;&lt;&gt;&gt;");
  assert.equal(escapeHtml('""'), "&quot;&quot;");
});

test("a script tag cannot survive it", () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  );
});
