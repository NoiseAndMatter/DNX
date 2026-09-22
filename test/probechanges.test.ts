/**
 * "What changed since the last time you asked" — the probe's whole investigative method.
 *
 * List a directory, change something on the instrument, list again, read the diff. Ask an
 * information code, change something, ask again, read the diff. Both were inline comparisons
 * against a module-level `Map`, a hundred lines apart, and neither could be exercised without an
 * instrument to change.
 *
 * The case that matters most is the **negative** one. An identical answer is not a non-result: it
 * says the thing you changed is *not* in this field, which narrows the search exactly as much as a
 * difference would. Reasoning is the method that has repeatedly failed on this protocol; asking
 * twice is the method that has not, and that only works if "nothing moved" is reported as loudly
 * as "something did".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerIsNews,
  describeAnswerChange,
  describeListingChange,
} from "../web/src/probe/changes.js";
import { type Entry } from "@noiseandmatter/dnx-core/device/storage.js";

function entry(index: number, name: string, trailer?: number[]): Entry {
  return {
    index,
    name,
    kind: "file",
    ...(trailer === undefined ? {} : { trailer: Uint8Array.from(trailer) }),
  } as Entry;
}

test("a first listing is not a result, and says so by saying nothing", () => {
  // Distinct from "nothing changed". There is no comparison to make yet, and claiming one would be
  // the tool inventing evidence.
  assert.equal(describeListingChange(undefined, [entry(1, "PRESETS")]), undefined);
});

test("an unchanged listing is reported, because that is the experiment's negative result", () => {
  const before = [entry(1, "PRESETS", [0x00, 0x12]), entry(2, "MORNING_JAM", [0x00, 0x7e])];
  const now = [entry(1, "PRESETS", [0x00, 0x12]), entry(2, "MORNING_JAM", [0x00, 0x7e])];

  const said = describeListingChange(before, now);
  assert.match(said!, /nothing/);
  assert.match(said!, /byte-identical/, "silence here would read as 'nobody looked'");
});

test("a changed trailer is the find this exists for", () => {
  // The four unexplained bytes per entry. If one tracks the loaded project, that is a fact the dump
  // protocol cannot supply — the project name lives in the one region no dump carries.
  const before = [entry(1, "PRESETS", [0x00, 0x12, 0x01, 0x01])];
  const now = [entry(1, "PRESETS", [0x00, 0x7e, 0x01, 0x01])];

  const said = describeListingChange(before, now)!;
  assert.match(said, /PRESETS/);
  assert.match(said, /00 12 01 01 → 00 7e 01 01/, "both sides, so the change can be read off");
});

test("a rename is reported as a rename, not as a disappearance and an arrival", () => {
  const said = describeListingChange([entry(3, "OLD")], [entry(3, "NEW")])!;
  assert.match(said, /3 renamed OLD → NEW/);
  assert.doesNotMatch(said, /disappeared/);
});

test("appearing and disappearing are both noticed", () => {
  const said = describeListingChange([entry(1, "A"), entry(2, "B")], [entry(1, "A"), entry(9, "C")])!;
  assert.match(said, /9 C appeared/);
  assert.match(said, /2 disappeared/);
});

test("an entry with no trailer compares cleanly against one that has none", () => {
  // Both sides render as the same placeholder, so a missing trailer must not read as a change.
  assert.match(describeListingChange([entry(1, "A")], [entry(1, "A")])!, /nothing/);
});

test("gaining a trailer is a change, and is shown against the placeholder", () => {
  const said = describeListingChange([entry(1, "A")], [entry(1, "A", [0xff])])!;
  assert.match(said, /— → ff/);
});

// --- asking a code twice --------------------------------------------------------------------------

test("the three outcomes of asking twice are three different sentences", () => {
  // A first ask is not evidence; an identical answer rules the field out; a change is the find.
  // Collapsing the first two into one would lose the distinction the whole method rests on.
  assert.match(describeAnswerChange(undefined, "00 01"), /first time/);
  assert.match(describeAnswerChange("00 01", "00 01"), /IDENTICAL/);
  assert.match(describeAnswerChange("00 01", "00 02"), /CHANGED — was 00 01/);
});

test("only a real change is news for the status bar", () => {
  // The card always says something; the bar should not shout on a first ask, which is not a result.
  assert.equal(answerIsNews(undefined, "00 01"), false);
  assert.equal(answerIsNews("00 01", "00 01"), false);
  assert.equal(answerIsNews("00 01", "00 02"), true);
});
