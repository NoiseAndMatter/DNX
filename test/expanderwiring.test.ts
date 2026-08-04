/**
 * The expander's repaint chain, checked at the source.
 *
 * ## Why a source check and not a real one
 *
 * The bug being pinned is pure wiring: `replan()` recomputed the merge plan and did not repaint the
 * destination grid, so ticking **Contiguous** updated the panel while the grid above it went on
 * drawing the previous positions. Nothing about that is observable without a DOM, a drag and a
 * rendered page, and this repository has no browser harness — the honest verification is on the
 * check sheet.
 *
 * What *can* be checked cheaply is that the chain still exists:
 *
 *     the Contiguous toggle → replan() → landingChanged() → renderDestinationGrid()
 *
 * Every link broke silently in exactly the same way: no error, no failing test, just a grid quietly
 * describing an operation that had moved on. A reader of `app.ts` cannot see the missing call
 * because absence has no line number, which is the whole argument for asserting it somewhere.
 *
 * The same pattern as `toolnav.test.ts` reading `toolnav.ts` for its shortcut string, and the grid's
 * class guard reading the union from its real home: narrow, and aimed at what fails without a sound.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../web/src/app.ts"),
  "utf8",
);

/** The body of a top-level `function name(...) { ... }`, matched to its closing brace at column 0. */
function bodyOf(name: string): string {
  const start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.ts has no function called ${name}`);
  const end = APP.indexOf("\n}", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return APP.slice(start, end);
}

test("the Contiguous toggle is wired to replan", () => {
  // It changes where patterns land, so it belongs with the options that trigger a recompute rather
  // than being read only at Apply time.
  const wiring = APP.match(/for \(const id of \[([^\]]*)\]\) \$\(id\)\.addEventListener\("change", replan\)/);
  assert.ok(wiring, "the option toggles are no longer wired to replan in one place");
  assert.match(wiring[1]!, /"contiguous"/, "Contiguous must replan — it decides where patterns land");
});

test("replan repaints the destination grid, not only the plan", () => {
  // The regression itself. `replan` called `replanForDevice()` alone, so the panel and the grid
  // disagreed until you dropped the patterns again.
  assert.match(
    bodyOf("replan"),
    /landingChanged\(\)/,
    "replan must go through landingChanged, or the grid keeps drawing the previous landing",
  );
});

test("landingChanged does both halves, because either alone is a disagreement", () => {
  const body = bodyOf("landingChanged");
  assert.match(body, /renderDestinationGrid\(\)/, "landingChanged must repaint the grid");
  assert.match(body, /replanForDevice\(\)/, "landingChanged must recompute the plan");
});

test("nothing recomputes the plan without repainting", () => {
  // `replanForDevice` is the half that used to travel alone. It should now be reached only through
  // `landingChanged` — anything else is a call site that can drift apart from the grid again.
  const calls = [...APP.matchAll(/\breplanForDevice\(\)/g)].length;
  const declaration = [...APP.matchAll(/function replanForDevice\(\)/g)].length;
  assert.equal(
    calls - declaration,
    1,
    "replanForDevice should be called once, from landingChanged — a second caller is a view that " +
      "can go stale while the plan moves on",
  );
});
