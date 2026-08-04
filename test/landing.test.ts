/**
 * Where merged patterns land.
 *
 * Pure arithmetic over slot indices, so all of it runs without a corpus, a device or a browser —
 * which is the point of having pulled the rule out of the merger and the page. It was written three
 * times; it has one home now, and these are the tests that home earns.
 *
 * The worked examples are copied from `docs/ROADMAP.md` §6c, which came from the user describing
 * what their instrument does. Deliberately: a rule about musical spacing is worth checking against
 * the sentences somebody actually said, not against whatever the implementation did first.
 *
 * Not to be confused with `placement.test.ts`, which is about **which track a sound gets** — a
 * different question at a different level, and the reason this module is called `landing`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LANDING,
  describeLanding,
  landingRefusal,
  landingSlotsFor,
} from "../src/expand/landing.js";

/** `A1` is 0, `B1` is 16 — banks of sixteen, one 128-slot run. */
const A1 = 0, A9 = 8, A10 = 9, B1 = 16, B2 = 17, B3 = 18, B9 = 24, B10 = 25;

test("keeping their spacing is the default, because it is what the musician arranged", () => {
  assert.equal(DEFAULT_LANDING, "relative");
});

test("A1, A9, A10 dropped on A1 land on A1, A9, A10", () => {
  // The bug this whole change exists for: they used to land on A1, A2, A3, silently discarding gaps
  // that are usually where the variations sit relative to the main idea.
  assert.deepEqual(landingSlotsFor([A1, A9, A10], A1, "relative"), [A1, A9, A10]);
});

test("the same three dropped on B1 land on B1, B9, B10", () => {
  assert.deepEqual(landingSlotsFor([A1, A9, A10], B1, "relative"), [B1, B9, B10]);
});

test("crossing a bank boundary is normal, not an edge case", () => {
  // Straight from the spec: anchored at A10 they land A10, B2, B3. The eight banks are one 128-slot
  // run and nothing special happens at the seam.
  assert.deepEqual(landingSlotsFor([A1, A9, A10], A10, "relative"), [A10, B2, B3]);
});

test("the lowest-numbered pattern lands on the anchor, whatever order they were picked in", () => {
  // Spacing is a property of the set, not of where the mouse started. Using click order here would
  // make the same three patterns land differently depending on which one was clicked first.
  const picked = [A10, A1, A9];
  assert.deepEqual(landingSlotsFor(picked, B1, "relative"), [B10, B1, B9]);
  assert.deepEqual(
    [...landingSlotsFor(picked, B1, "relative")].sort((a, b) => a - b),
    landingSlotsFor([A1, A9, A10], B1, "relative"),
    "the destinations are the same set however they were picked",
  );
});

test("contiguous packs them from the anchor, in the order they were picked", () => {
  // The old behaviour, kept because it is the right one when the job is gathering scattered
  // sketches into a block — and there, click order is the only thing that could decide the order.
  assert.deepEqual(landingSlotsFor([A10, A1, A9], B1, "contiguous"), [B1, B2, B3]);
});

test("one pattern lands on the anchor either way", () => {
  for (const mode of ["relative", "contiguous"] as const) {
    assert.deepEqual(landingSlotsFor([A9], B3, mode), [B3]);
  }
});

test("every pattern gets a destination, including the ones that do not fit", () => {
  // Not filtered and not clamped: the caller has to be able to see which ones fall off, and a
  // shorter array than it passed in would hide exactly that.
  const patterns = [A1, A9, A10];
  assert.equal(landingSlotsFor(patterns, 126, "relative").length, patterns.length);
});

test("a landing that fits is not refused", () => {
  const patterns = [A1, A9, A10];
  assert.equal(landingRefusal(patterns, landingSlotsFor(patterns, B1, "relative"), 128), undefined);
});

test("running off the end is refused, and the refusal names which patterns", () => {
  // There is no bank I. Not wrapped round to A, not clamped onto H16 — either would put a pattern
  // somewhere nobody chose, and quietly.
  const patterns = [A1, A9, A10];
  const refusal = landingRefusal(patterns, landingSlotsFor(patterns, 120, "relative"), 128);

  assert.ok(refusal, "120 + 9 is past the last slot, so this must refuse");
  assert.match(refusal, /H16/, "says where the end is");
  assert.match(refusal, /A9, A10/, "names the ones that fall off, so the fix is obvious");
});

test("relative can overflow where contiguous would not", () => {
  // The reason the check had to stop being `landing + count`. Three patterns spanning ten slots
  // need ten slots, not three, and the arithmetic version would have let this through.
  const patterns = [A1, A9, A10];
  const anchor = 125;
  assert.equal(landingRefusal(patterns, landingSlotsFor(patterns, anchor, "contiguous"), 128), undefined);
  assert.ok(landingRefusal(patterns, landingSlotsFor(patterns, anchor, "relative"), 128));
});

test("each mode describes itself differently, since the status line has to say which is in force", () => {
  assert.notEqual(describeLanding("relative"), describeLanding("contiguous"));
});
