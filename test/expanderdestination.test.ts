/**
 * The Digitone II being expanded into.
 *
 * None of this was reachable from a test before: the destination was a `let` in the page module,
 * mutated by six functions, and every one of its rules — which origins may be written back, how
 * `merged` accumulates, what one step of undo means — could only be exercised by clicking.
 *
 * The rule with teeth is **writability**. A write goes to the instrument's *active* project, so a
 * project opened from a +Drive slot must never be writable: sending edits made to slot 47 would
 * land them in slot 3. It is expressed as a missing baseline rather than a flag, and these tests
 * are what hold that.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Destination, describeOrigin, type Opened } from "../web/src/expander/destination.js";

/** A `handle` only has to be present or absent here; nothing reads inside it. */
const HANDLE = {} as NonNullable<Opened["handle"]>;

function opened(over: Partial<Opened> = {}): Opened {
  return { image: Uint8Array.of(1, 2, 3), origin: "blank", label: "blank", merged: [], ...over };
}

test("only a project read from the instrument may be written back", () => {
  const changes: number[] = [];
  const destination = new Destination(() => changes.push(1));

  // The +Drive case is the one that matters. It came off the instrument and is *still* not
  // writable, because a write goes to whatever is loaded rather than back to the slot it came from.
  for (const origin of ["blank", "file", "drive"] as const) {
    destination.fill(opened({ origin }));
    assert.equal(destination.writable, false, `${origin} must not be writable`);
  }

  destination.fill(opened({ origin: "device", handle: HANDLE }));
  assert.equal(destination.writable, true, "the active project is the one a write can reach");
  assert.equal(changes.length, 4, "every fill has to tell the page to redraw");
});

test("a drive project handed a handle would be writable — so nothing may hand it one", () => {
  // Stated as a test because the safety is structural: `writable` is `handle !== undefined` and
  // nothing else. If a future caller sets a handle on a drive-origin project, the button lights up
  // and the write goes to the wrong project. This is the assertion that says so out loud.
  const destination = new Destination(() => {});
  destination.fill(opened({ origin: "drive", handle: HANDLE }));
  assert.equal(
    destination.writable,
    true,
    "writability follows the handle alone — which is why only the device read may supply one",
  );
});

test("merging accumulates what has landed; a whole conversion replaces it", () => {
  const destination = new Destination(() => {});
  destination.fill(opened({ merged: [1, 2] }));

  destination.apply(Uint8Array.of(9), [7], "merge");
  assert.deepEqual([...destination.merged], [1, 2, 7], "a merge adds to what is already in there");

  // A whole-project conversion does not add to the destination, it *produces* it — so the record
  // of what is in it has to be replaced, not appended to.
  destination.apply(Uint8Array.of(9), [0, 1, 2], "whole");
  assert.deepEqual([...destination.merged], [0, 1, 2]);
});

test("undo is exactly one step, and is spent once used", () => {
  const destination = new Destination(() => {});
  const first = Uint8Array.of(1);
  destination.fill(opened({ image: first }));
  assert.equal(destination.canUndo, false, "nothing has been applied yet");

  destination.apply(Uint8Array.of(2), [0], "merge");
  assert.equal(destination.canUndo, true);

  destination.apply(Uint8Array.of(3), [1], "merge");
  destination.undo();
  // Back one step, to the image before the *last* apply — not all the way to the start. A deeper
  // history belongs to the manager's session, and half a history would be worse than none.
  assert.deepEqual(destination.image, Uint8Array.of(2));
  assert.equal(destination.canUndo, false, "the step is spent");

  destination.undo();
  assert.deepEqual(destination.image, Uint8Array.of(2), "a second undo does nothing");
});

test("filling discards the undo step, because it belonged to the old project", () => {
  const destination = new Destination(() => {});
  destination.fill(opened({ image: Uint8Array.of(1) }));
  destination.apply(Uint8Array.of(2), [0], "merge");
  assert.equal(destination.canUndo, true);

  // Undoing into a project that has been replaced would restore bytes from something else.
  destination.fill(opened({ image: Uint8Array.of(8), origin: "file" }));
  assert.equal(destination.canUndo, false);
});

test("applying to nothing is a no-op rather than a crash", () => {
  const destination = new Destination(() => {});
  destination.apply(Uint8Array.of(1), [0], "merge");
  assert.equal(destination.open, undefined);
});

test("what to do next depends on whether it can go back to the instrument", () => {
  const destination = new Destination(() => {});
  destination.fill(opened({ origin: "device", handle: HANDLE }));
  assert.match(destination.whatNext(), /Write it back/);

  destination.fill(opened({ origin: "drive" }));
  assert.match(destination.whatNext(), /export/i, "a +Drive project leaves as a file");
});

test("every origin says where it came from, and the unwritable ones say why", () => {
  assert.match(describeOrigin("device"), /ACTIVE project/);
  // The reason belongs beside the fact: a grey button is a fact, and this is a different thing
  // to read.
  assert.match(describeOrigin("drive"), /would land in the ACTIVE project/);
  assert.match(describeOrigin("blank"), /export/);
  assert.match(describeOrigin("file"), /project file/);
});
