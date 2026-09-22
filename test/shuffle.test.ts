/**
 * The shuffle: where every slot operation's meaning originates.
 *
 * ## Why this was worth writing
 *
 * `swap`, `move`, `copy`, `clear` and `keepOnly` are the vocabulary the CLI, the manager and the
 * expander all speak. Every one of them was covered only *indirectly*, through tests that apply a
 * shuffle to a real project and check the bytes — which means a wrong semantic and a wrong writer
 * were indistinguishable, and both needed the corpus to notice.
 *
 * Nothing here touches a Digitone. A shuffle is index arithmetic, and that is the point of it: the
 * same description that reorders patterns will reorder the sound pool, where `rereference` stops
 * being theoretical because sound locks address slots by index.
 *
 * ## The distinctions these exist to hold
 *
 * - **`sourceOf` returns the index itself for an untouched slot and `undefined` for an emptied
 *   one.** Those mean "leave it alone" and "write a blank here", and a caller that conflates them
 *   either wipes work or leaves stale patterns behind.
 * - **`asShuffle` vacates its sources; `asImport` does not.** Within one bank a move empties where
 *   it came from; across banks the source project is untouched.
 * - **Two sources landing on one slot throws.** No constructor here can produce it, so it is a
 *   caller's bug, and silently keeping whichever was listed last would discard the other.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NULL_SHUFFLE,
  ShuffleError,
  asImport,
  asShuffle,
  assertWithin,
  clear,
  copyMany,
  copyOnto,
  keepOnly,
  mergeShuffles,
  move,
  moveMany,
  movedSlots,
  outOfRange,
  rereference,
  sourceOf,
  swap,
  touchedSlots,
} from "@noiseandmatter/dnx-core/librarian/shuffle.js";

test("an untouched slot keeps its contents, and an emptied one is not the same thing", () => {
  const s = move(3, 7);
  assert.equal(sourceOf(s, 5), 5, "nothing touches slot 5, so it keeps what it has");
  assert.equal(sourceOf(s, 7), 3, "slot 7 receives slot 3");
  assert.equal(sourceOf(s, 3), undefined, "slot 3 is emptied, which is not 'leave it alone'");
});

test("rereference is the other direction, and says when a reference is dangling", () => {
  const s = move(3, 7);
  assert.equal(rereference(s, 3), 7, "anything pointing at 3 should now point at 7");
  assert.equal(rereference(s, 5), 5, "an untouched slot does not move");
  // A song row naming slot 7 now names something that was overwritten. Reported as discarded so
  // the caller decides what that means, rather than being repointed somewhere plausible.
  assert.equal(rereference(s, 7), undefined);
});

test("a move empties its source and a copy does not", () => {
  assert.equal(sourceOf(move(3, 7), 3), undefined);
  assert.equal(sourceOf(copyOnto(3, 7), 3), 3, "a copy leaves the source exactly as it was");
  assert.equal(sourceOf(copyOnto(3, 7), 7), 3);
});

test("a swap exchanges both ways and is lossless", () => {
  const s = swap(2, 9);
  assert.equal(sourceOf(s, 2), 9);
  assert.equal(sourceOf(s, 9), 2);
  assert.equal(rereference(s, 2), 9);
  assert.equal(rereference(s, 9), 2);
});

test("swapping a slot with itself does nothing at all", () => {
  assert.equal(swap(4, 4), NULL_SHUFFLE);
  assert.ok(NULL_SHUFFLE.isEmpty);
});

test("a batch lands at consecutive slots, in the order given", () => {
  const s = moveMany([10, 4, 7], 20);
  assert.equal(sourceOf(s, 20), 10);
  assert.equal(sourceOf(s, 21), 4);
  assert.equal(sourceOf(s, 22), 7);
  // Order given, not sorted: "these, in this order" is the question being asked.
  assert.deepEqual(touchedSlots(s), [4, 7, 10, 20, 21, 22]);
});

test("sources may overlap destinations, because every source is read from the original", () => {
  // `[4, 3] -> 3` is a swap rather than a slot read twice, which is what lets a batch move
  // overlap the range it came from.
  const s = moveMany([4, 3], 3);
  assert.equal(sourceOf(s, 3), 4);
  assert.equal(sourceOf(s, 4), 3);
});

test("two sources landing on one slot is refused, not resolved", () => {
  assert.throws(
    () => asShuffle([{ from: 1, to: 5 }, { from: 2, to: 5 }]),
    (error: Error) => {
      assert.ok(error instanceof ShuffleError);
      assert.match(error.message, /both land on slot 5/);
      assert.match(error.message, /silently discarded/);
      return true;
    },
  );
});

test("within a bank a move vacates; across banks the source is untouched", () => {
  // The whole difference between the two constructors, and the reason both exist.
  assert.equal(sourceOf(asShuffle([{ from: 1, to: 2 }]), 1), undefined, "intra-bank: 1 is emptied");
  assert.equal(sourceOf(asImport([{ from: 1, to: 2 }]), 1), 1, "import: the source bank is not ours to empty");
});

test("an identity move is not a move", () => {
  assert.ok(asShuffle([{ from: 3, to: 3 }]).isEmpty);
  assert.deepEqual(movedSlots(asShuffle([{ from: 3, to: 3 }])), []);
});

test("clear writes a blank rather than leaving a slot alone", () => {
  const s = clear(2, 5);
  assert.equal(sourceOf(s, 2), undefined);
  assert.equal(sourceOf(s, 5), undefined);
  assert.equal(sourceOf(s, 3), 3);
  assert.deepEqual(touchedSlots(s), [2, 5]);
  assert.deepEqual(movedSlots(s), [], "nothing is going anywhere; it is being erased");
});

test("keepOnly packs the kept slots to the front and empties the rest", () => {
  const s = keepOnly([5, 9], 8);
  assert.equal(sourceOf(s, 0), 5);
  assert.equal(sourceOf(s, 1), 9);
  for (const slot of [2, 3, 4, 6, 7]) {
    assert.equal(sourceOf(s, slot), undefined, `slot ${slot} should be blanked`);
  }
});

test("a slot already in its final position survives keepOnly", () => {
  // This was a bug first, and the module's own comment records it: `asImport` drops identity moves
  // as no-ops, so merged over a blanket clear the clear won and the pattern you asked to keep
  // vanished. Slot 0 here is both kept and already home.
  const s = keepOnly([0, 4], 6);
  assert.equal(sourceOf(s, 0), 0, "slot 0 is kept where it already is, not cleared");
  assert.equal(sourceOf(s, 1), 4);
  assert.equal(sourceOf(s, 2), undefined);
});

test("merging overlays rather than composes, and the later shuffle wins", () => {
  const merged = mergeShuffles(move(1, 2), move(3, 2));
  assert.equal(sourceOf(merged, 2), 3, "the later move decides what lands on 2");
});

test("slots outside the bank are reported, not thrown, so a person can be told which", () => {
  // The usual cause is asking to move three patterns to H15 — off the end by one — which deserves
  // an explanation rather than a stack trace.
  assert.deepEqual(outOfRange(moveMany([1, 2, 3], 126), 128), [128]);
  assert.deepEqual(outOfRange(move(1, 2), 128), []);
});

test("assertWithin is the throwing form, for callers treating it as their own bug", () => {
  assert.throws(() => assertWithin(move(1, 200), 128), /200 (are|is) outside 0\.\.127/);
  assert.doesNotThrow(() => assertWithin(move(1, 2), 128));
});

test("copyMany leaves every source in place", () => {
  const s = copyMany([1, 2, 3], 10);
  for (const from of [1, 2, 3]) assert.equal(sourceOf(s, from), from);
  assert.deepEqual(touchedSlots(s), [10, 11, 12]);
});
