import assert from "node:assert/strict";
import { test } from "node:test";
import { type Drag, actionFor, refuseDrop } from "../web/src/manager/dragrules.js";

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
