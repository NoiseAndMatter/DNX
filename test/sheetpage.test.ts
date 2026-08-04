/**
 * The shared hardware-sheet page, and the stamping helpers that came with it.
 *
 * The sheets themselves are checked by generating one and reading it — that is what the corpus and
 * the CLIs are for. What is worth pinning here is the part that went wrong: **two copies of a page
 * drifting apart**, silently, in ways nobody chose. One had `td.num`, the other did not. One spelled
 * the ballot box as a literal, the other as a CSS escape. One put a rule under the note cell.
 *
 * So these check that the page has one home and that its stylesheet still covers what its sheets
 * emit — the same guard as the grid's class check, for the same reason: a class with no rule behind
 * it renders as nothing and reports no error.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderSheetPage, sheetCss } from "../src/sheet/page.js";
import { STAMPED_NAME_SIZE, hhmm, stampedProjectName } from "../src/sheet/naming.js";
import { NAME_SIZE } from "../src/librarian/rename.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const page = renderSheetPage({
  documentTitle: "DNX hardware test 1234 — subject",
  heading: "Subject — hardware test",
  lede: 'Build <span class="mono">1234</span>',
  body: '<div class="card">the sheet</div>',
  spec: { title: "t", stamp: "1234", columns: [], rows: [], meta: [], checks: [] },
});

test("the page carries the sheet, in the order the form needs", () => {
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>DNX hardware test 1234 — subject<\/title>/);
  assert.match(page, /<h1>Subject — hardware test<\/h1>/);
  assert.match(page, /<div class="card">the sheet<\/div>/);
  // The script reads the fields the body wrote, so it has to come after both the body and the bar.
  assert.ok(
    page.indexOf('class="rf-bar"') > page.indexOf('class="card"'),
    "the export bar must follow the sheet, not precede it",
  );
  assert.ok(
    page.indexOf("<script") > page.indexOf('class="rf-bar"'),
    "the script must follow the button it wires",
  );
});

test("every class the sheets use has a rule behind it", () => {
  // The `.sw` failure, in the place it would be least visible: a printed sheet nobody can debug.
  const css = sheetCss("62rem", "44rem");
  for (const selector of [
    ".lede", ".card", ".scroll", ".mono", ".nm", ".empty", ".hint", ".warn", ".scope",
    "td.n", "td.num", "td.tick", "td.note", "tr.grp",
  ]) {
    assert.ok(css.includes(selector), `${selector} is used by a sheet and styled nowhere`);
  }
});

test("the ballot box is the escape, which survives a file opened without a charset", () => {
  const css = sheetCss("62rem", "44rem");
  assert.match(css, /content:"\\2610 \\2610"/, "the tick glyph must be the CSS escape");
  assert.doesNotMatch(css, /content:"☐/, "the literal spelling is the one that was dropped");
});

test("neither hardware-test CLI writes its own page any more", () => {
  // The duplication this change removed, asserted so it cannot quietly return: a third sheet should
  // reach for `renderSheetPage` rather than copying a doctype out of one of these.
  for (const file of ["src/cli/hardwaretest.ts", "src/cli/trackhwtest.ts"]) {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    assert.doesNotMatch(source, /<!doctype html>/i, `${file} still emits its own page scaffold`);
    assert.match(source, /renderSheetPage\(/, `${file} should render through the shared page`);
  }
});

test("the build stamp is four digits of local time", () => {
  assert.equal(hhmm(new Date(2026, 7, 4, 9, 5)), "0905");
  assert.equal(hhmm(new Date(2026, 7, 4, 18, 59)), "1859");
});

test("a stamped name fits the device field, with the time on the end", () => {
  const stamped = stampedProjectName("MORNING JAM", new Date(2026, 7, 4, 16, 40));
  assert.equal(stamped, "MORNING JA 1640");
  assert.equal(stamped.length, STAMPED_NAME_SIZE);
  // Short names are not padded, and the trailing space before the stamp is not doubled.
  assert.equal(stampedProjectName("JAM", new Date(2026, 7, 4, 16, 40)), "JAM 1640");
});

test("the stamped width is one short of the field, which is deliberate and unexplained", () => {
  // Both copies of the stamping logic said 15 while `NAME_SIZE` is 16, and neither said why. Kept
  // rather than corrected — a name that overruns on hardware is worse than one character wasted —
  // and asserted here so the discrepancy is a decision on the record rather than a coincidence.
  assert.equal(NAME_SIZE, 16);
  assert.equal(STAMPED_NAME_SIZE, NAME_SIZE - 1);
});
