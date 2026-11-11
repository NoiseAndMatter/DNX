/**
 * One send to the sample store: new folders, uploads and deletes, in the order they run.
 *
 * The expected steps are written by hand from the listing below. No code under test made them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type SendStep, describeDone, planSend } from "@noiseandmatter/dnx-core/sample/sendplan.js";

const ZERO = "0".repeat(64);
const SHA = "ab".repeat(32);
const ENTRIES = [
  { path: "samples/drums", size: 0, sha256: ZERO },
  { path: "samples/drums/kick", size: 5_000, sha256: SHA },
  { path: "samples/drums/old", size: 0, sha256: ZERO },
  { path: "samples/pads/warm", size: 3_000, sha256: SHA },
];
const file = (name: string, size: number, folder = "") => ({ name, stored: new Uint8Array(size), folder });

/** A step as short text, so a whole order reads on one line. */
const shown = (step: SendStep): string =>
  step.kind === "mkdir" ? `mkdir ${step.folder}` : step.kind === "upload" ? `upload ${step.index}` : `delete ${step.path}`;

test("new folders run first, parents first, then uploads, then sample deletes, then folder deletes", () => {
  const plan = planSend({
    entries: ENTRIES,
    folders: ["loops/long", "loops"],
    uploads: [file("a", 100, "loops/long"), file("b", 100, "drums")],
    deletes: ["samples/drums/old", "samples/pads/warm"],
    free: 10_000,
  });
  assert.equal(plan.problem, undefined);
  assert.equal(plan.deletesFirst, false);
  assert.deepEqual(plan.steps.map(shown), [
    "mkdir loops",
    "mkdir loops/long",
    "upload 0",
    "upload 1",
    "delete samples/pads/warm",
    "delete samples/drums/old",
  ]);
  assert.equal(plan.bytes, 200);
  assert.equal(plan.freed, 3_000);
  assert.equal(plan.freeAfter, 12_800);
});

test("sample deletes run first when the uploads fit only in the space they give back", () => {
  const plan = planSend({
    entries: ENTRIES,
    folders: [],
    uploads: [file("big", 6_000, "drums")],
    deletes: ["samples/drums/kick"],
    free: 2_000,
  });
  assert.equal(plan.problem, undefined);
  assert.equal(plan.deletesFirst, true);
  assert.deepEqual(plan.steps.map(shown), ["delete samples/drums/kick", "upload 0"]);
  assert.equal(plan.freeAfter, 1_000);
});

test("uploads larger than the free space and the deletes together are refused", () => {
  const plan = planSend({
    entries: ENTRIES,
    folders: [],
    uploads: [file("big", 9_000, "drums")],
    deletes: ["samples/pads/warm"],
    free: 2_000,
  });
  assert.match(plan.problem ?? "", /need 0\.0 MiB.*free/);
  assert.equal(plan.deletesFirst, false);
});

test("a sample sent and deleted in one plan is refused", () => {
  const plan = planSend({
    entries: ENTRIES,
    folders: [],
    uploads: [file("kick", 100, "drums")],
    deletes: ["samples/drums/kick"],
    free: 10_000,
  });
  assert.equal(plan.problem, "samples/drums/kick is sent and deleted in one plan. Undo one of the two.");
});

test("a folder delete is refused while the folder keeps a sample, a folder, or gets something", () => {
  const base = { entries: ENTRIES, folders: [] as string[], uploads: [] as ReturnType<typeof file>[], free: 10_000 };
  // drums/ still holds kick and old/.
  assert.equal(planSend({ ...base, deletes: ["samples/drums"] }).problem, "samples/drums/ still holds kick.");
  // With both marked, drums/ empties: its own delete runs after them, the deepest folder first.
  const emptied = planSend({ ...base, deletes: ["samples/drums", "samples/drums/kick", "samples/drums/old"] });
  assert.equal(emptied.problem, undefined);
  assert.deepEqual(emptied.steps.map(shown), [
    "delete samples/drums/kick",
    "delete samples/drums/old",
    "delete samples/drums",
  ]);
  assert.equal(
    planSend({ ...base, uploads: [file("x", 10, "drums/old")], deletes: ["samples/drums/old"] }).problem,
    "samples/drums/old/ gets x in this plan.",
  );
  assert.equal(
    planSend({ ...base, folders: ["drums/old/new"], deletes: ["samples/drums/old"] }).problem,
    "samples/drums/old/ gets a new folder in this plan.",
  );
});

test("a file that cannot be sent is left out, and a plan with nothing to do says so", () => {
  const some = planSend({
    entries: ENTRIES,
    folders: [],
    uploads: [file("bad/name", 10, "drums"), file("good", 10, "drums")],
    deletes: [],
    free: 10_000,
  });
  assert.equal(some.problem, undefined);
  assert.deepEqual(some.steps.map(shown), ["upload 1"]);
  assert.equal(planSend({ entries: ENTRIES, folders: [], uploads: [file("bad/name", 10)], deletes: [], free: 10 }).problem, "No file can be sent.");
  assert.equal(planSend({ entries: ENTRIES, folders: [], uploads: [], deletes: [], free: 10 }).problem, "The plan is empty.");
});

test("a send that stops names what finished", () => {
  const names = (index: number): string => ["kick", "snare"][index]!;
  assert.equal(describeDone([], names), "Nothing was changed.");
  assert.equal(
    describeDone([{ kind: "mkdir", folder: "a" }, { kind: "upload", index: 0 }, { kind: "upload", index: 1 }], names),
    "Done before it stopped: made 1 folder, sent and verified kick, snare.",
  );
  assert.equal(
    describeDone([{ kind: "delete", path: "samples/x", folder: false }], names),
    "Done before it stopped: deleted 1.",
  );
});
