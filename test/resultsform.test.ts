import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExportSpec,
  RESULTS_FORM_CSS,
  checkItem,
  exportBar,
  metaField,
  noteCell,
  observationsField,
  resultsFormScript,
  verdictCell,
} from "../src/sheet/resultsform.js";

/**
 * The renderers emit controls; the exported script reads them back by id. Nothing in the
 * type system connects the two, and a mismatch fails in the worst possible way — silently, at
 * the hardware, producing an export full of blanks after the session is over and the device
 * has moved on. These tests are that missing connection.
 */

const ID = "s5-A13";

test("a verdict control is the radio group the export reads", () => {
  const html = verdictCell(ID);
  // The script does querySelector('input[name="v-<id>"]:checked') and reads .value.
  assert.ok(html.includes(`name="v-${ID}"`), "radio group name must be v-<id>");
  assert.ok(html.includes(`value="PASS"`));
  assert.ok(html.includes(`value="FAIL"`));
  // Restore does getElementById(id + "-p" | "-f").
  assert.ok(html.includes(`id="${ID}-p"`));
  assert.ok(html.includes(`id="${ID}-f"`));
  // Both labels must point at their own input, or the pair becomes unclickable.
  assert.ok(html.includes(`for="${ID}-p"`));
  assert.ok(html.includes(`for="${ID}-f"`));
});

test("neither radio is pre-selected, so unanswered stays a real state", () => {
  // A default would turn every row the tester never reached into a pass, which is the one
  // failure mode that would quietly invent evidence.
  assert.ok(!verdictCell(ID).includes("checked"));
});

test("a note field carries both the id the script saves by and the one it reads by", () => {
  const html = noteCell(ID);
  assert.ok(html.includes(`id="n-${ID}"`), "export does getElementById('n-' + id)");
  assert.ok(html.includes(`data-note="${ID}"`), "save walks [data-note]");
});

test("checklist and metadata fields match their selectors", () => {
  const check = checkItem("q0", "The KIT");
  assert.ok(check.includes(`id="c-q0"`));
  assert.ok(check.includes(`data-check="q0"`));
  assert.ok(check.includes(`for="c-q0"`), "the label must be clickable");

  const meta = metaField("firmware", "Firmware", "1.10E");
  assert.ok(meta.includes(`id="m-firmware"`));
  assert.ok(meta.includes(`data-meta="firmware"`));
  assert.ok(meta.includes(`value="1.10E"`));

  assert.ok(observationsField().includes(`id="m-observations"`));
  assert.ok(observationsField().includes(`data-meta="observations"`));
});

test("the export bar carries every button the script binds", () => {
  const html = exportBar();
  for (const id of ["rf-download", "rf-copy", "rf-reset", "rf-status"]) {
    assert.ok(html.includes(`id="${id}"`), `the script binds #${id}`);
  }
});

test("user text is escaped, since pattern names come from the user's own projects", () => {
  const meta = metaField("tester", 'A "quoted" name', '<img src=x onerror=1>');
  assert.ok(!meta.includes("<img"), "a value must not break out of the attribute");
  assert.ok(meta.includes("&quot;") || !meta.includes('""'));

  const check = checkItem("q0", "<script>alert(1)</script>");
  assert.ok(!check.includes("<script>"), "a label must not inject markup");
});

const SPEC: ExportSpec = {
  title: "test",
  stamp: "1629",
  columns: ["#", "Operation", "Slot", "Should be"],
  rows: [
    { id: "baseline", cells: ["0", "Baseline loads", "HWTEST_BASE", "—"] },
    { id: ID, cells: ["5", "Swap, same bank", "A13", '"250423"'] },
  ],
  meta: [
    { id: "firmware", label: "Firmware" },
    { id: "observations", label: "Observations" },
  ],
  checks: [{ id: "q0", label: "The KIT" }],
};

test("the script embeds the spec and keys storage by build stamp", () => {
  const js = resultsFormScript(SPEC);
  assert.ok(js.includes('"stamp":"1629"'), "the spec must be inlined, there is no network");
  assert.ok(js.includes('"dnx-results-"'), "answers survive a reload");
  // Two sheets open at once must not overwrite each other's answers.
  assert.ok(js.includes("SPEC.stamp"), "the storage key must include the build");
});

test("the emitted script is syntactically valid JavaScript", () => {
  // The script is a string inside a template literal inside TypeScript, so every quote and
  // backslash is escaped twice. That is exactly the kind of thing that breaks without a
  // compiler noticing — the sheet would open, look right, and do nothing when clicked.
  const js = resultsFormScript(SPEC);
  const body = js.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotThrow(() => new Function(body), "generated sheet script does not parse");
});

test("the stylesheet cancels the printed tickbox it replaces", () => {
  // The base sheet draws "☐ ☐" with a ::before. Left in place it sits beside the real
  // controls and the tester ticks the wrong one.
  assert.ok(/td\.tick::before\s*\{\s*content:\s*none/.test(RESULTS_FORM_CSS));
});
