/**
 * Where a dropped selection lands, and how the page says so.
 *
 * These were functions of four module-level variables, so the only way to ask "where would these
 * four patterns go?" was to click four patterns. The rules matter more than that: an overflowing
 * landing is refused **whole** by the merge, and a preview that quietly trimmed it would offer a
 * drop Apply will not perform.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DN2_LAYOUT } from "../src/project/dn2image.js";
import {
  allSlots,
  describeSlots,
  landingFits,
  landingSlots,
  pendingSources,
} from "../web/src/expander/drop.js";

test("relative landing keeps the gaps between the chosen patterns", () => {
  // The mode exists so a set of patterns arrives shaped as it was, not packed together. Patterns
  // 0, 3 and 4 dropped on slot 10 keep their spacing.
  const map = pendingSources({ selection: [0, 3, 4], landing: 10, mode: "relative" });
  assert.deepEqual([...map.entries()].sort((a, b) => a[0] - b[0]), [[10, 0], [13, 3], [14, 4]]);
});

test("contiguous landing packs them from the drop", () => {
  const map = pendingSources({ selection: [0, 3, 4], landing: 10, mode: "contiguous" });
  assert.deepEqual([...map.entries()].sort((a, b) => a[0] - b[0]), [[10, 0], [11, 3], [12, 4]]);
});

test("the map is keyed by destination, so a cell can ask about itself", () => {
  // A renderer draws one cell at a time and needs "what is arriving here", not "where does this go".
  const map = pendingSources({ selection: [5, 6], landing: 40, mode: "contiguous" });
  assert.equal(map.get(40), 5);
  assert.equal(map.get(41), 6);
  assert.equal(map.get(42), undefined);
});

test("nothing selected previews nothing", () => {
  assert.equal(pendingSources({ selection: [], landing: 3, mode: "relative" }).size, 0);
  assert.deepEqual(landingSlots({ selection: [], landing: 3, mode: "relative" }), []);
  assert.deepEqual(allSlots({ selection: [], landing: 3, mode: "relative" }), []);
});

test("a landing that runs past the end does not fit, and one slot is enough", () => {
  // The merge refuses the whole landing rather than trimming it, so a single overflowing slot has
  // to disqualify all of them. A hint that offered the rest would promise what Apply will not do.
  const overflowing = { selection: [0, 1], landing: DN2_LAYOUT.patternCount - 1, mode: "contiguous" as const };
  assert.equal(landingFits(overflowing), false);
  assert.deepEqual(allSlots(overflowing), [127, 128], "unfiltered, or the overflow is invisible");

  assert.equal(landingFits({ ...overflowing, landing: DN2_LAYOUT.patternCount - 2 }), true);
});

test("the preview drops out-of-range slots rather than clamping them", () => {
  // Absence is the signal. Clamping would draw two patterns into the last cell and claim the drop
  // was fine; leaving the cell unmarked is what makes the overflow visible before Apply.
  const map = pendingSources({ selection: [0, 1], landing: DN2_LAYOUT.patternCount - 1, mode: "contiguous" });
  assert.deepEqual([...map.keys()], [127]);
  assert.deepEqual(landingSlots({ selection: [0, 1], landing: 127, mode: "contiguous" }), [127]);
});

test("the bound is a parameter, so the rule is not tied to one device", () => {
  assert.equal(landingFits({ selection: [0, 1], landing: 6, mode: "contiguous", patternCount: 8 }), true);
  assert.equal(landingFits({ selection: [0, 1, 2], landing: 6, mode: "contiguous", patternCount: 8 }), false);
});

// --- saying it ------------------------------------------------------------------------------------

test("a consecutive run collapses to its ends", () => {
  // "A1…A8" is what somebody means by eight slots in a row; listing all eight is not.
  assert.equal(describeSlots([0, 1, 2, 3, 4, 5, 6, 7]), "A1…A8");
});

test("a scattered set is listed, and capped so a status bar can hold it", () => {
  const many = describeSlots([0, 2, 4, 6, 8, 10, 12, 14]);
  assert.match(many, /and 2 more$/);
  assert.equal(many.split(",").length, 6, "six named, then the count");
});

test("order does not change what it says", () => {
  assert.equal(describeSlots([4, 1, 2, 3]), describeSlots([1, 2, 3, 4]));
});

test("one slot is its own name, and none is a word", () => {
  assert.equal(describeSlots([0]), "A1");
  assert.equal(describeSlots([]), "nothing");
});
