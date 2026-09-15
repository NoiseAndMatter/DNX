/**
 * Four probe findings from the first release test run, held by reading the source.
 *
 * The probe is DOM and MIDI end to end, so each property is checked where it is written.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "probe", "main.ts"), "utf8");

function body(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} has been renamed; this fence no longer guards anything`);
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end, `${name} has no closing brace at column 0`);
  return source.slice(start, start + end.index);
}

test("the device card does not say the +Drive is unsupported", () => {
  // It said "Reads +Drive files: no" while the +Drive listed and read in the same session.
  assert.doesNotMatch(source, /\["Reads \+Drive files"/);
  assert.doesNotMatch(source, /\["Manages \+Drive"/);
});

test("the page's own link check is not reported as an unmatched reply", () => {
  assert.match(body("probe"), /respId !== LINK_ID/);
});

test("Read → write reads its source in the form a write accepts", () => {
  const readThenWrite = body("readThenWrite");
  const read = readThenWrite.indexOf("readStoredFile(source");
  assert.ok(read > 0, "the source read moved");
  assert.match(readThenWrite.slice(read, read + 400), /form: STORED_FORM/);
});

test("a refusal before anything is sent is not called the device's silence", () => {
  const readThenWrite = body("readThenWrite");
  const refused = readThenWrite.indexOf("wroteAnything && !sentAnything");
  const silence = readThenWrite.indexOf("verdictAfterSilence(");
  assert.ok(refused > 0, "no branch for a refusal before sending");
  assert.ok(refused < silence, "the local refusal must be decided before the silence verdict runs");
  assert.match(readThenWrite, /stage === "write" && written > 0\) sentAnything = true/);
});
