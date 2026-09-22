import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { Session, combiningTag, tag } from "@noiseandmatter/dnx-core/librarian/session.js";
import { diffImages, isEmptyPatch, patchExtent, redoPatch, undoPatch } from "@noiseandmatter/dnx-core/librarian/patch.js";
import { applyRearrange } from "@noiseandmatter/dnx-core/librarian/rearrange.js";
import { keepOnly, moveMany, swap } from "@noiseandmatter/dnx-core/librarian/shuffle.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;
const CONFIRM = { confirmOverwrite: true } as const;

function corpusImage(): Uint8Array {
  const path = `${CORPUS}02_DN2/01_Projects/MORNING_JAM.dn2prj`;
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

// --- patches -----------------------------------------------------------------------------

test("a patch round-trips an image in both directions", () => {
  const before = Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff);
  const after = Uint8Array.from(before);
  after[10] = 0xaa;
  after[2000] = 0xbb;
  after[4095] = 0xcc;

  const patch = diffImages(before, after);
  const working = Uint8Array.from(before);

  redoPatch(working, patch);
  assert.deepEqual(working, after);
  undoPatch(working, patch);
  assert.deepEqual(working, before);
});

test("an unchanged image produces an empty patch", () => {
  const image = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const patch = diffImages(image, Uint8Array.from(image));
  assert.ok(isEmptyPatch(patch));
  assert.equal(patch.bytes, 0);
  assert.equal(patchExtent(patch), undefined);
});

test("nearby edits merge into one run rather than thousands", () => {
  // A changed pattern record is not one solid block; without bridging, one edited record
  // becomes thousands of runs whose object overhead dwarfs the bytes they carry.
  const before = new Uint8Array(1024);
  const after = Uint8Array.from(before);
  for (let i = 100; i < 300; i += 8) after[i] = 1;

  const patch = diffImages(before, after);
  assert.equal(patch.runs.length, 1, "edits 8 bytes apart should bridge into one run");
  assert.equal(patch.runs[0]!.at, 100);
});

test("edits far apart stay separate, so the patch does not swallow the whole image", () => {
  const before = new Uint8Array(4096);
  const after = Uint8Array.from(before);
  after[10] = 1;
  after[3000] = 1;

  const patch = diffImages(before, after);
  assert.equal(patch.runs.length, 2);
  assert.ok(patch.bytes < 100, `patch should be tiny, was ${patch.bytes}`);
});

test("diffing images of different sizes is refused rather than truncated", () => {
  assert.throws(() => diffImages(new Uint8Array(10), new Uint8Array(11)), /different sizes/);
});

// --- the session -------------------------------------------------------------------------

/**
 * Slots holding trigs in `MORNING_JAM.dn2prj`, 0-based.
 *
 * Worth naming rather than guessing at. Swapping two *empty* slots is a genuine no-op — each
 * blank has its slot index rewritten to match where it sits, so the two are byte-identical
 * afterwards — and `apply` correctly declines to record it. A test that reached for arbitrary
 * slots would then fail with a confusing message about history length rather than the real
 * cause, which is exactly what happened while writing these.
 */
const OCCUPIED = [0, 1, 3, 4, 5, 8, 11, 12, 13, 16, 18, 19, 20, 24, 26, 27, 28, 32, 48, 80];

/** Apply, and insist it really changed something, so a dead-slot choice fails loudly here. */
function applyReal(
  session: Session,
  t: Parameters<Session["apply"]>[0],
  mutate: Parameters<Session["apply"]>[1],
): void {
  assert.equal(
    session.apply(t, mutate),
    true,
    `"${t.label}" changed nothing — pick slots from OCCUPIED`,
  );
}

test("undo and redo restore the exact bytes", { skip }, () => {
  const original = corpusImage();
  const session = new Session(original);

  const changed = session.apply(tag("swap A1 B12"), (img) =>
    applyRearrange(img, swap(0, 27), CONFIRM).image,
  );
  assert.equal(changed, true);
  assert.notDeepEqual(session.snapshot(), original);

  assert.equal(session.undo(), "swap A1 B12");
  assert.deepEqual(session.snapshot(), original, "undo did not restore the original bytes");

  assert.equal(session.redo(), "swap A1 B12");
  assert.notDeepEqual(session.snapshot(), original);
  assert.equal(session.undo(), "swap A1 B12");
  assert.deepEqual(session.snapshot(), original);
});

test("many operations undo back to the start, in order", { skip }, () => {
  const original = corpusImage();
  const session = new Session(original);

  applyReal(session, tag("one"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  applyReal(session, tag("two"), (img) => applyRearrange(img, moveMany([3], 40), CONFIRM).image);
  applyReal(session, tag("three"), (img) => applyRearrange(img, swap(16, 32), CONFIRM).image);

  assert.deepEqual(
    session.history().map((h) => h.label),
    ["three", "two", "one"],
    "history should read most recent first",
  );

  assert.equal(session.undo(), "three");
  assert.equal(session.undo(), "two");
  assert.equal(session.undo(), "one");
  assert.equal(session.canUndo, false);
  assert.deepEqual(session.snapshot(), original);

  assert.equal(session.undo(), undefined, "undoing past the start should be a no-op");
});

test("an operation that changes nothing does not consume an undo step", { skip }, () => {
  const session = new Session(corpusImage());
  const changed = session.apply(tag("nothing"), (img) => img);
  assert.equal(changed, false);
  assert.equal(session.canUndo, false);
});

test("a new action discards the redo branch", { skip }, () => {
  const session = new Session(corpusImage());
  applyReal(session, tag("one"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  session.undo();
  assert.equal(session.canRedo, true);

  applyReal(session, tag("two"), (img) => applyRearrange(img, swap(4, 5), CONFIRM).image);
  assert.equal(session.canRedo, false, "the redo branch is unreachable and must be dropped");
  assert.equal(session.historyBytes > 0, true);
});

test("an operation that throws leaves the session untouched", { skip }, () => {
  const original = corpusImage();
  const session = new Session(original);
  assert.throws(() =>
    session.apply(tag("boom"), () => {
      throw new Error("boom");
    }),
  );
  assert.deepEqual(session.snapshot(), original, "a failed operation must not half-apply");
  assert.equal(session.canUndo, false);
});

test("combining tags collapse a run, and undo takes back the whole gesture", { skip }, () => {
  const original = corpusImage();
  const session = new Session(original);

  // Three "renames" in a row, the way typing produces one model change per keystroke.
  for (const [a, b] of [[0, 16], [1, 18], [3, 19]] as const) {
    applyReal(session, combiningTag("rename"), (img) =>
      applyRearrange(img, swap(a, b), CONFIRM).image,
    );
  }

  assert.equal(session.history().length, 1, "a combining run should be one step");
  assert.equal(session.undo(), "rename");
  assert.deepEqual(session.snapshot(), original, "undo must reach the start of the gesture");
});

test("undo cancels combining, so a later run does not merge across it", { skip }, () => {
  const session = new Session(corpusImage());
  applyReal(session, combiningTag("rename"), (img) => applyRearrange(img, swap(0, 16), CONFIRM).image);
  session.undo();
  session.redo();
  applyReal(session, combiningTag("rename"), (img) => applyRearrange(img, swap(1, 18), CONFIRM).image);

  assert.equal(session.history().length, 2, "the redone step must not absorb the new one");
});

test("non-combining tags never merge, even when identical", { skip }, () => {
  const session = new Session(corpusImage());
  applyReal(session, tag("move"), (img) => applyRearrange(img, swap(0, 16), CONFIRM).image);
  applyReal(session, tag("move"), (img) => applyRearrange(img, swap(1, 18), CONFIRM).image);
  assert.equal(session.history().length, 2);
});

test("history is bounded by bytes, and says when it dropped something", { skip }, () => {
  // Bytes rather than steps because steps are not comparable: a swap is small, --keep
  // rewrites almost the whole image. A step budget would be wasteful or useless by turns.
  const session = new Session(corpusImage(), { budgetBytes: 64 * 1024 });

  for (const slot of OCCUPIED.slice(0, 6)) {
    applyReal(session, tag(`step ${slot}`), (img) =>
      applyRearrange(img, swap(slot, slot + 40), CONFIRM).image,
    );
  }

  assert.ok(session.trimmedSteps > 0, "the budget should have forced a trim");
  assert.ok(
    session.historyBytes <= 64 * 1024 || session.history().length === 1,
    `history should fit the budget, held ${session.historyBytes}`,
  );
  // Whatever survives must still undo correctly.
  const before = session.snapshot();
  const label = session.undo();
  assert.ok(label, "at least one step should remain undoable");
  assert.notDeepEqual(session.snapshot(), before);
});

test("undo and redo labels drive the controls", { skip }, () => {
  const session = new Session(corpusImage());
  assert.equal(session.undoLabel, undefined);
  session.apply(tag("move A1 to C5"), (img) => applyRearrange(img, moveMany([0], 36), CONFIRM).image);
  assert.equal(session.undoLabel, "move A1 to C5");
  assert.equal(session.redoLabel, undefined);
  session.undo();
  assert.equal(session.undoLabel, undefined);
  assert.equal(session.redoLabel, "move A1 to C5");
});

test("the session reports the device it opened", { skip }, () => {
  assert.equal(new Session(corpusImage()).device.kind, "dn2");
});

test("a snapshot is independent of later edits", { skip }, () => {
  const session = new Session(corpusImage());
  const held = session.snapshot();
  session.apply(tag("swap"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  assert.deepEqual(held, corpusImage(), "a snapshot must not move under the caller");
});

test("a whole-project rewrite is one step, and still undoes", { skip }, () => {
  // The worst case for a patch: --keep blanks 126 of 128 slots. If the history can survive
  // this it can survive anything a single operation does.
  const original = corpusImage();
  const session = new Session(original);

  const changed = session.apply(tag("keep A1 A2"), (img) =>
    applyRearrange(img, keepOnly([0, 1], 128), CONFIRM).image,
  );
  assert.equal(changed, true);
  assert.ok(session.historyBytes > 0);
  session.undo();
  assert.deepEqual(session.snapshot(), original);
});

test("the future lists what redo would bring back, newest first", { skip }, () => {
  // `history()` and `future()` are the two halves of one timeline, which is what a clickable
  // history needs: a control that steps one at a time makes somebody click eleven times to reach a
  // state they can already see on screen.
  const session = new Session(corpusImage());
  applyReal(session, tag("first"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  applyReal(session, tag("second"), (img) => applyRearrange(img, swap(2, 3), CONFIRM).image);
  applyReal(session, tag("third"), (img) => applyRearrange(img, swap(4, 5), CONFIRM).image);

  assert.deepEqual(session.future(), [], "nothing has been undone yet");
  assert.deepEqual(session.history().map((e) => e.label), ["third", "second", "first"]);

  session.undo();
  session.undo();

  assert.deepEqual(session.future().map((e) => e.label), ["third", "second"], "newest first");
  assert.deepEqual(session.history().map((e) => e.label), ["first"]);

  session.redo();
  assert.deepEqual(session.future().map((e) => e.label), ["third"]);
  assert.deepEqual(session.history().map((e) => e.label), ["second", "first"]);
});

test("a new action after undoing drops the future", { skip }, () => {
  // The ordinary undo-then-diverge case. Those steps are unreachable now, and a timeline that
  // still listed them would offer somewhere the user cannot go.
  const session = new Session(corpusImage());
  applyReal(session, tag("first"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  applyReal(session, tag("second"), (img) => applyRearrange(img, swap(2, 3), CONFIRM).image);
  session.undo();
  assert.equal(session.future().length, 1);

  applyReal(session, tag("instead"), (img) => applyRearrange(img, swap(6, 7), CONFIRM).image);
  assert.deepEqual(session.future(), [], "the abandoned branch must not stay clickable");
  assert.deepEqual(session.history().map((e) => e.label), ["instead", "first"]);
});

test("undoing every recorded step returns the image to what it was opened with", { skip }, () => {
  // What the manager's new "as opened" row promises. It offers a single click that undoes
  // `history().length` times, so the claim it rests on is that doing exactly that lands back on the
  // original bytes — and that claim belongs here, not in a page.
  const original = corpusImage();
  const session = new Session(Uint8Array.from(original));

  applyReal(session, tag("one"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  applyReal(session, tag("two"), (img) => applyRearrange(img, moveMany([3], 40), CONFIRM).image);
  applyReal(session, tag("three"), (img) => applyRearrange(img, swap(5, 9), CONFIRM).image);
  assert.notDeepEqual(session.image, original, "the setup has to actually change something");

  const steps = session.history().length;
  assert.equal(steps, 3);
  for (let i = 0; i < steps; i++) session.undo();

  assert.deepEqual(session.image, original, "undoing every step must reach the opened project");
  assert.equal(session.canUndo, false, "and there must be nothing left behind it");
});

test("a session that dropped steps says so, because the original is then unreachable", { skip }, () => {
  // The manager offers the "as opened" row only when `trimmedSteps` is zero. Once the budget has
  // dropped a step the original genuinely cannot be reached, and a row promising it would be a lie
  // the session cannot keep — so the flag it depends on has to mean what it says.
  const session = new Session(corpusImage(), { budgetBytes: 1 });
  applyReal(session, tag("one"), (img) => applyRearrange(img, swap(0, 1), CONFIRM).image);
  applyReal(session, tag("two"), (img) => applyRearrange(img, moveMany([3], 40), CONFIRM).image);

  assert.ok(session.trimmedSteps > 0, "a one-byte budget must drop something");
});