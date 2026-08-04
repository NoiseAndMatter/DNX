/**
 * The tool row: its order, its targets, and whether anything actually paints it.
 *
 * ## Why these tests and not others
 *
 * The interesting parts of `toolnav.ts` are a keydown handler and a CSS transition, neither of
 * which a Node test can honestly exercise — those are on the check sheet instead. What *can* be
 * checked here is everything that goes wrong silently:
 *
 * - **A link pointing at a page that is not there.** A 404 from the top bar of every tool.
 * - **A page that forgot the container.** The row simply does not appear, on that page only.
 * - **A class with no rule behind it.** `.sw` in the expander's legend rendered as an empty box for
 *   weeks for exactly this reason; every chip was in the markup and none of them was in the
 *   stylesheet. A row of unstyled links looks like a mistake and reads like one.
 *
 * The order is asserted because it is a decision, not an implementation detail: the user chose a
 * fixed row over a most-recently-used one so that each tool keeps a permanent screen position.
 * Changing it silently would take that away.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOLS, indexOfTool, stepFrom } from "../web/src/toolnav.js";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

/** Which page each tool's row is drawn on, so a missing container is caught per page. */
const PAGES: [string, string][] = [
  ["expander", "index.html"],
  ["manager", "manager.html"],
  ["probe", "probe.html"],
];

test("the row order is fixed, and it is the order that was chosen", () => {
  // Settled against a most-recently-used ordering: MRU turns the row into a history stack, so a
  // tool's position depends on where you have been and the thing you just clicked moves.
  assert.deepEqual(
    TOOLS.map((tool) => tool.id),
    ["expander", "manager", "probe"],
  );
});

test("every tool links to a page that exists", () => {
  for (const tool of TOOLS) {
    assert.ok(existsSync(join(WEB, tool.href)), `${tool.id} links to ${tool.href}, which is not in web/`);
  }
});

test("every page has somewhere to draw the row, and loads the stylesheet that paints it", () => {
  for (const [tool, file] of PAGES) {
    const html = readFileSync(join(WEB, file), "utf8");
    assert.match(html, /id="toolnav"/, `${file} has no #toolnav container, so ${tool} would show no row`);
    // The probe does not link `dnx.css` at all, which is the reason these rules have their own
    // file. A page that grew a container and forgot the stylesheet would render bare links.
    assert.match(html, /toolnav\.css/, `${file} does not load toolnav.css`);
  }
});

test("every class the row emits has a rule behind it", () => {
  const css = readFileSync(join(WEB, "toolnav.css"), "utf8");
  for (const selector of [".toolnav", ".tool", ".brand", 'aria-current="page"']) {
    assert.ok(css.includes(selector), `${selector} is emitted by toolnav.ts and styled nowhere`);
  }
  // The slide is opt-in per navigation, so its classes only exist while it is running — but an
  // absent rule would make the page jump rather than move, which is the sort of thing nobody
  // reports and everybody notices.
  for (const state of ["slide-from-left", "slide-from-right", "sliding"]) {
    assert.ok(css.includes(state), `body.${state} is set by toolnav.ts and styled nowhere`);
  }
});

test("the shortcut is discoverable from the row itself", () => {
  // A shortcut nobody can find is a shortcut nobody uses, so each link carries it in its tooltip.
  // Asserted on the source because building the row needs a DOM; what matters is that the string is
  // there to be built.
  const source = readFileSync(resolve(WEB, "src/toolnav.ts"), "utf8");
  assert.match(source, /link\.title = /, "the links must carry their shortcut in a title");
  assert.match(source, /Ctrl\+Alt\+/, "the tooltip must name the actual combination");
});

test("the row does not wrap at either end", () => {
  // Reported from the hardware: at the rightmost tool the right arrow cycled round to the leftmost.
  // The rule was three lines inside a keydown listener where nothing could reach it; it is a
  // function now, and this is the assertion that was missing.
  const last = TOOLS.length - 1;
  assert.equal(stepFrom(last, 1), undefined, "there is nothing to the right of the last tool");
  assert.equal(stepFrom(0, -1), undefined, "there is nothing to the left of the first");
});

test("stepping inside the row moves exactly one place", () => {
  assert.equal(stepFrom(0, 1), 1);
  assert.equal(stepFrom(1, 1), 2);
  assert.equal(stepFrom(2, -1), 1);
});

test("an unknown tool throws rather than reading as position -1", () => {
  // **This is the only mechanism that could produce the reported wrap.** `findIndex` answers -1 for
  // an id not in the row, and -1 + 1 is 0 — so "next" from an unknown position lands on the
  // leftmost tool, which is indistinguishable from cycling. Now it says so instead.
  assert.throws(() => indexOfTool("nosuchtool" as never), /not one of expander, manager, probe/);
  for (const tool of TOOLS) assert.equal(TOOLS[indexOfTool(tool.id)]!.id, tool.id);
});