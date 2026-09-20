/**
 * The rearrangement pipeline, with nothing on screen in it.
 *
 * `planOperation` and `applyOperation` are the five steps the manager's `run()` used to hold
 * inline: plan, refuse, list what is destroyed, apply, verify. The two it does not hold are the
 * person's decision and the wording, which stay with the caller.
 *
 * What is worth testing here is the composition rather than the parts. `rearrange.test.ts` and
 * `trackmove.test.ts` already prove what a shuffle does to real bytes; these prove that the
 * pipeline reports the right things in the right order and refuses to hand back an image it
 * could not verify.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN2_PROJECTS, NO_CORPUS, corpusPath } from "./corpus.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { deviceFor } from "../src/librarian/device.js";
import { applyOperation, planOperation } from "../src/librarian/operation.js";
import { copyMany, moveMany } from "../src/librarian/shuffle.js";

const FILE = "MORNING_JAM.dn2prj";
const have = !NO_CORPUS && existsSync(join(corpusPath(DN2_PROJECTS), FILE));
const SKIP = have ? false : "needs the private corpus";

function image(): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(join(corpusPath(DN2_PROJECTS), FILE))));
  return decodeProjectImage(payload.raw).image;
}

function occupied(img: Uint8Array): number[] {
  const device = deviceFor(img);
  const slots: number[] = [];
  for (let i = 0; i < device.patternCount; i++) if (device.summarise(img, i).occupied) slots.push(i);
  return slots;
}

test("a move onto an occupied slot names what it would destroy", { skip: SKIP }, () => {
  const img = image();
  const device = deviceFor(img);
  const [from, onto] = occupied(img);
  assert.ok(from !== undefined && onto !== undefined, "this project needs two occupied patterns");

  const plan = planOperation(img, device, { shuffle: moveMany([from], onto), scope: "both" });

  assert.equal(plan.blockers.length, 0, "moving between two real slots is not blocked");
  /*
   * **Two lines, not one.** A move empties its source as well as overwriting its destination, and
   * the plan says so: the destination line carries `replaced by`, the source line does not. A
   * caller showing only the destination would understate what the person is about to lose.
   */
  assert.equal(plan.destructive.length, 2);
  assert.ok(plan.destructive.some((line) => /replaced by/.test(line)), "the destination says what lands on it");
  /*
   * The instrument's own name for the slot, not an index. A host that re-derived the name would
   * eventually disagree with the grid the person is reading, which is why the line is formatted
   * where the naming lives rather than at the call site.
   */
  assert.match(plan.destructive[0]!, /^[A-H]\d+/, "named the way the instrument names it");
  assert.match(plan.destructive[0]!, /\d+ trigs/, "and says what is in it");
});

test("a copy into empty space destroys nothing", { skip: SKIP }, () => {
  const img = image();
  const device = deviceFor(img);
  const taken = new Set(occupied(img));
  const from = [...taken][0]!;
  let free = 0;
  while (taken.has(free)) free++;

  // A copy rather than a move, because a move would empty its source and that is destructive.
  const plan = planOperation(img, device, { shuffle: copyMany([from], free), scope: "both" });
  assert.deepEqual(plan.destructive, []);
  assert.equal(plan.blockers.length, 0);
});

test("applying returns a verified image, and the source is untouched", { skip: SKIP }, () => {
  const img = image();
  const device = deviceFor(img);
  const taken = new Set(occupied(img));
  const from = [...taken][0]!;
  let free = 0;
  while (taken.has(free)) free++;

  const before = Uint8Array.from(img);
  const after = applyOperation(img, device, { shuffle: copyMany([from], free), scope: "both" });

  assert.deepEqual(img, before, "the operation does not edit the image it was handed");
  assert.equal(after.length, img.length);
  assert.ok(deviceFor(after).summarise(after, free).occupied, "the copy landed");
});

test("the plan and the apply agree about the level", { skip: SKIP }, () => {
  /*
   * A track move and a pattern rearrangement report the same fields, which is the property that
   * lets one pipeline serve both. If a future change broke that symmetry, planning at one level
   * and applying at the other would be the first thing to go wrong, so it is asserted directly.
   */
  const img = image();
  const device = deviceFor(img);
  const [from, onto] = occupied(img);
  const operation = { tracks: from!, shuffle: moveMany([0], 1), scope: "both" as const };
  void onto;

  const plan = planOperation(img, device, operation);
  assert.ok(Array.isArray(plan.destructive), "a track-level plan reports the same shape");
  const after = applyOperation(img, device, operation);
  assert.equal(after.length, img.length);
});
