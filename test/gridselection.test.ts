/**
 * How a selection grows, shrinks and anchors.
 *
 * `nextSelection` is pure, is shared by the manager and the expander, and had no test — which is
 * the worst combination available: the two tools' selections must behave identically, and the only
 * thing making them do so was that they call the same function.
 *
 * It is deliberately the behaviour every list in every application has: shift takes a range from
 * the anchor, ctrl or meta toggles one, a plain click replaces. Getting it subtly different in two
 * tools would be worse than either behaviour, and getting it subtly different from the rest of the
 * user's computer is worse still — which is why these read as assertions about *convention* rather
 * than about this codebase.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSelection } from "../web/src/selection.js";

const plain = { shiftKey: false, ctrlKey: false, metaKey: false };
const shift = { ...plain, shiftKey: true };
const ctrl = { ...plain, ctrlKey: true };
const meta = { ...plain, metaKey: true };

test("a plain click replaces the selection and becomes the anchor", () => {
  const { selection, anchor } = nextSelection([1, 2, 3], 1, 7, plain);
  assert.deepEqual(selection, [7]);
  assert.equal(anchor, 7);
});

test("shift takes the range from the anchor, in either direction", () => {
  assert.deepEqual(nextSelection([2], 2, 5, shift).selection, [2, 3, 4, 5]);
  assert.deepEqual(nextSelection([5], 5, 2, shift).selection, [2, 3, 4, 5]);
});

test("a shift range keeps the anchor, so extending again grows from the same place", () => {
  const first = nextSelection([2], 2, 5, shift);
  assert.equal(first.anchor, 2, "the anchor does not follow the click");
  const second = nextSelection(first.selection, first.anchor, 8, shift);
  assert.deepEqual(second.selection, [2, 3, 4, 5, 6, 7, 8], "extending replaces the range, not appends");
});

test("shift with no anchor behaves as a plain click rather than guessing one", () => {
  const { selection, anchor } = nextSelection([], undefined, 4, shift);
  assert.deepEqual(selection, [4]);
  assert.equal(anchor, 4);
});

test("ctrl adds a slot, and adds it at the end", () => {
  // Order matters downstream: the expander lands a batch in click order, so a selection that
  // silently sorted itself would change where patterns go.
  const { selection, anchor } = nextSelection([5, 1], 1, 3, ctrl);
  assert.deepEqual(selection, [5, 1, 3]);
  assert.equal(anchor, 3, "the toggled slot becomes the anchor for a following shift");
});

test("ctrl on a slot already selected removes it", () => {
  assert.deepEqual(nextSelection([5, 1, 3], 3, 1, ctrl).selection, [5, 3]);
});

test("meta does what ctrl does, for the same reason a Mac exists", () => {
  assert.deepEqual(nextSelection([2], 2, 6, meta).selection, [2, 6]);
  assert.deepEqual(nextSelection([2, 6], 6, 6, meta).selection, [2]);
});

test("shift wins over ctrl when both are held", () => {
  // Not a decision so much as an order of tests, but it is the order every file manager uses, and
  // pinning it means it changes on purpose.
  const { selection } = nextSelection([1], 1, 3, { ...plain, shiftKey: true, ctrlKey: true });
  assert.deepEqual(selection, [1, 2, 3]);
});

test("the input selection is never mutated", () => {
  // It is `readonly number[]` in the signature, but the expander keeps its selection in a live
  // array it splices elsewhere — so a helper that mutated its argument would corrupt state that
  // looks like it is only being read.
  const before = [4, 5];
  nextSelection(before, 4, 9, ctrl);
  assert.deepEqual(before, [4, 5]);
});
