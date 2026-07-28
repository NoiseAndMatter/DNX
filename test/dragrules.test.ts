import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Drag,
  actionFor,
  dropHint,
  patternForOperation,
  refuseDrop,
} from "../web/src/manager/dragrules.js";

const mods = (over: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

// --- what a modifier means -----------------------------------------------------------------

test("a plain drag moves", () => {
  // Dragging means moving everywhere else, and a manager that made it copy would quietly leave
  // the source behind — the opposite of what the gesture promises.
  assert.equal(actionFor(mods()), "move");
});

test("shift copies and ctrl swaps", () => {
  assert.equal(actionFor(mods({ shiftKey: true })), "copy");
  assert.equal(actionFor(mods({ ctrlKey: true })), "swap");
});

test("command is ctrl, for the Mac", () => {
  assert.equal(actionFor(mods({ metaKey: true })), "swap");
});

test("holding both picks the more specific request", () => {
  // Shift+Ctrl has to mean something. Swap is the more deliberate of the two, and silently
  // doing a copy instead would leave the source in place when the user asked to exchange.
  assert.equal(actionFor(mods({ shiftKey: true, ctrlKey: true })), "swap");
});

// --- which drops are refused ---------------------------------------------------------------

const patterns: Drag = { level: "pattern", indices: [3] };

test("a drop with nothing being dragged is refused", () => {
  assert.match(refuseDrop(undefined, "pattern", 5, "move")!, /nothing/);
});

test("a track cannot be dropped onto a pattern", () => {
  // The indices overlap — pattern A12 and track T12 are both 11 — so without this a stray drop
  // across the two sections would run a plausible-looking operation on the wrong thing.
  const tracks: Drag = { level: "track", indices: [2] };
  assert.match(refuseDrop(tracks, "pattern", 11, "move")!, /cannot be dropped/);
  assert.match(refuseDrop(patterns, "track", 11, "move")!, /cannot be dropped/);
});

test("dropping one thing where it already is does nothing", () => {
  // A no-op that would still push an undo entry and re-verify a whole image.
  assert.match(refuseDrop(patterns, "pattern", 3, "move")!, /already is/);
});

test("dropping a batch onto one of its own members is allowed", () => {
  // It is not a no-op: the others move in around it. Refusing would make a common tidy-up
  // gesture fail for no reason.
  const batch: Drag = { level: "pattern", indices: [3, 7, 9] };
  assert.equal(refuseDrop(batch, "pattern", 3, "move"), undefined);
});

test("a swap takes exactly two, so a batch swap is refused", () => {
  // Many sources against one target has no single obvious meaning. Same rule as the CLI and
  // the buttons, so all three surfaces refuse the same thing.
  const batch: Drag = { level: "pattern", indices: [3, 7] };
  assert.match(refuseDrop(batch, "pattern", 9, "swap")!, /two/);
  assert.equal(refuseDrop(patterns, "pattern", 9, "swap"), undefined);
});

test("an ordinary drop is allowed", () => {
  for (const action of ["move", "copy", "swap"] as const) {
    assert.equal(refuseDrop(patterns, "pattern", 9, action), undefined, `${action} was refused`);
  }
});

test("a batch move and a batch copy are both allowed", () => {
  const batch: Drag = { level: "track", indices: [0, 1, 2] };
  assert.equal(refuseDrop(batch, "track", 8, "move"), undefined);
  assert.equal(refuseDrop(batch, "track", 8, "copy"), undefined);
});

test("every refusal reads as a reason, not a code", () => {
  // These go straight into the status bar as "Not done — <reason>.", so each has to be a
  // lower-case clause that finishes that sentence. "ERR_LEVEL_MISMATCH" would tell the user
  // nothing about what to do differently.
  const refusals = [
    refuseDrop(undefined, "pattern", 1, "move"),
    refuseDrop({ level: "track", indices: [1] }, "pattern", 1, "move"),
    refuseDrop(patterns, "pattern", 3, "move"),
    refuseDrop({ level: "pattern", indices: [1, 2] }, "pattern", 5, "swap"),
  ];

  assert.equal(refusals.filter(Boolean).length, 4, "all four cases should refuse");
  for (const reason of refusals) {
    assert.match(reason!, /^[a-z]/, `"${reason}" should start lower case, mid-sentence`);
    assert.doesNotMatch(reason!, /[.!]$/, `"${reason}" should not punctuate its own end`);
    assert.ok(reason!.split(" ").length >= 4, `"${reason}" is too terse to act on`);
  }
});

// --- what the destination cell draws --------------------------------------------------------

test("the hovered cell names the action it is about to perform", () => {
  // The whole point. One outline for all three said only *that* something would happen; the
  // status bar had the *what*, at the other end of the page from where the user is looking.
  assert.deepEqual(dropHint(patterns, "pattern", 9, mods()), { action: "move", label: "MOVE" });
  assert.deepEqual(dropHint(patterns, "pattern", 9, mods({ shiftKey: true })), {
    action: "copy",
    label: "COPY",
  });
  assert.deepEqual(dropHint(patterns, "pattern", 9, mods({ ctrlKey: true })), {
    action: "swap",
    label: "SWAP",
  });
});

test("a refused drop draws nothing at all", () => {
  // Not a fourth colour meaning "you cannot" — that would compete with the three that mean
  // "this will happen", and the browser already draws a "no" cursor for a drop we decline.
  const tracks: Drag = { level: "track", indices: [2] };
  assert.equal(dropHint(tracks, "pattern", 11, mods()), undefined, "across levels");
  assert.equal(dropHint(patterns, "pattern", 3, mods()), undefined, "onto itself");
  assert.equal(dropHint(undefined, "pattern", 9, mods()), undefined, "nothing dragged");
});

test("holding ctrl over a batch draws nothing, because a batch swap is refused", () => {
  // The subtle one: the cell is a perfectly good move or copy target, and becomes a non-target
  // the instant Ctrl goes down. Drawing SWAP there would promise something that then refuses.
  const batch: Drag = { level: "pattern", indices: [3, 7] };
  assert.deepEqual(dropHint(batch, "pattern", 9, mods()), { action: "move", label: "MOVE" });
  assert.equal(dropHint(batch, "pattern", 9, mods({ ctrlKey: true })), undefined);
});

test("the hint changes with the modifier and nothing else", () => {
  // It has to be a pure function of the modifiers for the mid-drag repaint to be correct: the
  // key handler recomputes it with no drag event to hand, so anything read from an event would
  // be stale exactly when it matters.
  const seen = new Set(
    [mods(), mods({ shiftKey: true }), mods({ ctrlKey: true }), mods({ metaKey: true })].map(
      (m) => dropHint(patterns, "pattern", 9, m)?.label,
    ),
  );
  assert.deepEqual([...seen].sort(), ["COPY", "MOVE", "SWAP"]);
});

test("the label is what a person reads, not a code", () => {
  // It is drawn across the destination at 0.78rem. Anything longer wraps, and anything like
  // "DROP_ACTION_MOVE" would be unreadable at that size over a cell that already has content.
  for (const m of [mods(), mods({ shiftKey: true }), mods({ ctrlKey: true })]) {
    const hint = dropHint(patterns, "pattern", 9, m)!;
    assert.match(hint.label, /^[A-Z]{4}$/, `"${hint.label}" should be one short upper-case word`);
    assert.equal(hint.label, hint.action.toUpperCase(), "the label must name its own action");
  }
});

// --- which level an operation runs at ------------------------------------------------------

test("a pattern operation never runs inside the open pattern", () => {
  // The regression: the manager decided "is this a track operation?" by asking whether a track
  // section was open. That was the same question only while opening tracks *replaced* the
  // pattern grid. Once they stacked, dragging a pattern ran a track operation on the open one,
  // reinterpreting the indices on the way — A5 and T5 are both index 4, so it looked plausible.
  assert.equal(patternForOperation("pattern", 0), undefined);
  assert.equal(patternForOperation("pattern", 7), undefined);
});

test("a track operation runs inside the open pattern", () => {
  assert.equal(patternForOperation("track", 7), 7);
  assert.equal(patternForOperation("track", 0), 0, "pattern 0 is a pattern, not an absence");
});

test("a track operation with no pattern open runs nowhere", () => {
  assert.equal(patternForOperation("track", undefined), undefined);
});
