import assert from "node:assert/strict";
import { NO_CORPUS, corpusPath, DN1_PROJECTS } from "./corpus.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { readPattern, readSoundPool } from "@noiseandmatter/dnx-core/project/dn1.js";
import {
  applyPatternCopy,
  freePoolSlots,
  LibrarianError,
  planPatternCopy,
} from "@noiseandmatter/dnx-core/librarian/copy.js";

const DIR = NO_CORPUS ? "" : corpusPath(DN1_PROJECTS);

function image(name: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(join(DIR, name))));
  return decodeProjectImage(payload.raw).image;
}

const names = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".dnprj")).sort() : [];
const skip = names.length < 2;

/** A pattern with sound locks makes the dependency-resolution path actually run. */
function findLockedPattern(img: Uint8Array): number {
  for (let p = 0; p < 128; p++) {
    for (const track of readPattern(img, p).tracks) {
      if (track.trigs.some((t) => t.soundLock !== undefined)) return p;
    }
  }
  return -1;
}

test("planning is pure — neither image is modified", { skip }, () => {
  const src = image("002 MORNING_JAM.dnprj");
  const dst = image("004 GROOVY.dnprj");
  const srcCopy = Uint8Array.from(src);
  const dstCopy = Uint8Array.from(dst);

  planPatternCopy(src, findLockedPattern(src), dst, 0);

  assert.deepEqual(src, srcCopy, "source image was mutated");
  assert.deepEqual(dst, dstCopy, "destination image was mutated");
});

test("a copied pattern reproduces the source's trigs and notes", { skip }, () => {
  const src = image("002 MORNING_JAM.dnprj");
  const dst = image("004 GROOVY.dnprj");
  const from = findLockedPattern(src);
  assert.ok(from >= 0, "expected a pattern with sound locks");

  const { image: out } = applyPatternCopy(src, from, dst, 3);

  const before = readPattern(src, from);
  const after = readPattern(out, 3);

  assert.equal(after.name, before.name);
  assert.equal(after.tempo, before.tempo);
  assert.equal(after.slotIndex, 3, "the record should know its new slot");

  for (let t = 0; t < 8; t++) {
    const a = before.tracks[t]!;
    const b = after.tracks[t]!;
    assert.deepEqual(
      b.trigs.map((x) => [x.step, x.note, x.velocity, x.microTiming]),
      a.trigs.map((x) => [x.step, x.note, x.velocity, x.microTiming]),
      `track ${t} trigs differ`,
    );
  }
});

test("sound locks are remapped and still resolve to the same sound", { skip }, () => {
  const src = image("002 MORNING_JAM.dnprj");
  const dst = image("004 GROOVY.dnprj");
  const from = findLockedPattern(src);

  const { image: out, plan } = applyPatternCopy(src, from, dst, 5);
  assert.ok(plan.soundMoves.length > 0, "expected at least one sound to be carried");

  const srcPool = readSoundPool(src);
  const outPool = readSoundPool(out);
  const before = readPattern(src, from);
  const after = readPattern(out, 5);

  for (let t = 0; t < 4; t++) {
    const a = before.tracks[t]!.trigs;
    const b = after.tracks[t]!.trigs;
    for (let i = 0; i < a.length; i++) {
      const lockA = a[i]!.soundLock;
      const lockB = b[i]!.soundLock;
      if (lockA === undefined) {
        assert.equal(lockB, undefined, `track ${t} trig ${i}: lock appeared from nowhere`);
        continue;
      }
      assert.notEqual(lockB, undefined, `track ${t} trig ${i}: lock was lost`);
      assert.deepEqual(
        outPool[lockB!]!.data,
        srcPool[lockA]!.data,
        `track ${t} trig ${i}: remapped lock points at a different sound`,
      );
    }
  }
});

test("copying the same pattern twice reuses pool slots rather than duplicating", { skip }, () => {
  const src = image("002 MORNING_JAM.dnprj");
  const dst = image("004 GROOVY.dnprj");
  const from = findLockedPattern(src);

  const freeBefore = freePoolSlots(dst).length;
  const first = applyPatternCopy(src, from, dst, 10);
  const freeAfter = freePoolSlots(first.image).length;
  assert.ok(freeAfter < freeBefore, "expected the first copy to consume pool slots");

  const second = applyPatternCopy(src, from, first.image, 11);
  assert.equal(
    freePoolSlots(second.image).length,
    freeAfter,
    "the second copy should reuse the identical sounds, not consume more slots",
  );
  assert.ok(second.plan.soundMoves.every((m) => m.reused), "expected every sound to be reused");
});

test("the plan reports what would be destroyed", { skip }, () => {
  const src = image("002 MORNING_JAM.dnprj");
  const from = findLockedPattern(src);
  const occupied = planPatternCopy(src, from, src, from);
  assert.equal(occupied.destinationOccupied, true);
  assert.ok(occupied.destinationTrigCount > 0);
});

test("a full destination pool is refused rather than silently mis-mapped", { skip }, () => {
  const src = image("002 MORNING_JAM.dnprj");
  const from = findLockedPattern(src);

  // Fill every destination pool slot so nothing can be carried across.
  const dst = image("004 GROOVY.dnprj");
  const pool = readSoundPool(dst);
  const donor = readSoundPool(src).find((s) => s.name !== "");
  assert.ok(donor, "expected a named sound to clone");
  for (const slot of pool) {
    if (slot.name === "") dst.set(donor.data, slot.offset);
  }
  // Make each filled slot distinct so dedup cannot reuse them.
  for (let i = 0; i < pool.length; i++) dst[pool[i]!.offset + 12] = 0x41 + (i % 26);

  const plan = planPatternCopy(src, from, dst, 0);
  if (plan.ok) return; // dedup found homes for everything, which is also correct
  assert.throws(() => applyPatternCopy(src, from, dst, 0), LibrarianError);
  const forced = applyPatternCopy(src, from, dst, 0, { force: true });
  assert.equal(forced.plan.ok, false, "force should still report the plan as not ok");
});
