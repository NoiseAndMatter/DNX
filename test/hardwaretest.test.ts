import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUIET_FAILURES,
  SEED_SOURCES,
  seedingFor,
  stepsFor,
} from "../src/librarian/hardwaretest.js";
import { sourceOf, touchedSlots } from "../src/librarian/shuffle.js";

/**
 * The hardware test is only trustworthy if its layout holds. These assert the design rather
 * than the code: one artefact carrying many operations works *only* while each operation
 * lands somewhere nothing else touches, and while the reference patterns stay untouched.
 * Break either and a failure on the device stops telling you which operation caused it.
 */

const steps = stepsFor();
const seeding = seedingFor();

test("every step writes somewhere no other step writes", () => {
  const seen = new Map<number, string>();
  for (const step of steps) {
    for (const slot of touchedSlots(step.shuffle)) {
      const owner = seen.get(slot);
      assert.equal(
        owner,
        undefined,
        `slot ${slot} is written by both "${owner}" and "${step.operation}", ` +
          `so a failure there would not say which`,
      );
      seen.set(slot, step.operation);
    }
  }
});

test("the two reference patterns are never written after seeding", () => {
  for (const step of steps) {
    for (const slot of touchedSlots(step.shuffle)) {
      assert.notEqual(
        slot,
        SEED_SOURCES.p1,
        `"${step.operation}" writes the reference ${SEED_SOURCES.p1}`,
      );
      assert.notEqual(
        slot,
        SEED_SOURCES.p2,
        `"${step.operation}" writes the reference ${SEED_SOURCES.p2}`,
      );
    }
  }
});

test("every seeded slot is consumed by a step, and every consumed slot is seeded", () => {
  const seeded = new Set(seeding.map((s) => s.slot));

  // A step's sources are the slots it reads. Anything read must have been put there.
  const read = new Set<number>();
  for (const step of steps) {
    for (const slot of touchedSlots(step.shuffle)) {
      const from = sourceOf(step.shuffle, slot);
      if (from !== undefined && from !== slot) read.add(from);
    }
  }
  // The delete step reads nothing but still needs its slot occupied to be a real test.
  for (const step of steps) {
    if (step.operation === "Delete") for (const slot of touchedSlots(step.shuffle)) read.add(slot);
  }

  for (const slot of read) {
    const isReference = slot === SEED_SOURCES.p1 || slot === SEED_SOURCES.p2;
    assert.ok(
      seeded.has(slot) || isReference,
      `step reads slot ${slot}, which is neither seeded nor a reference`,
    );
  }
  for (const slot of seeded) {
    assert.ok(read.has(slot), `slot ${slot} is seeded but no step uses it`);
  }
});

test("seeding never overwrites a reference", () => {
  for (const { slot } of seeding) {
    assert.notEqual(slot, SEED_SOURCES.p1);
    assert.notEqual(slot, SEED_SOURCES.p2);
  }
});

test("seeding writes each slot once", () => {
  const slots = seeding.map((s) => s.slot);
  assert.equal(new Set(slots).size, slots.length, "a slot is seeded twice");
});

test("both in-bank and cross-bank variants are covered for copy, move and swap", () => {
  const bankOf = (slot: number): number => Math.floor(slot / 16);

  for (const verb of ["Copy", "Move", "Swap"]) {
    const matching = steps.filter((s) => s.operation.startsWith(verb));
    assert.ok(matching.length >= 2, `expected in-bank and cross-bank ${verb}`);

    const spans = matching.map((step) => {
      const banks = new Set<number>();
      for (const slot of touchedSlots(step.shuffle)) {
        banks.add(bankOf(slot));
        const from = sourceOf(step.shuffle, slot);
        if (from !== undefined) banks.add(bankOf(from));
      }
      return banks.size;
    });

    assert.ok(spans.some((n) => n === 1), `no same-bank ${verb} — an off-by-16 could hide`);
    assert.ok(spans.some((n) => n > 1), `no cross-bank ${verb} — an off-by-16 could hide`);
  }
});

test("steps are numbered in order from one", () => {
  assert.deepEqual(
    steps.map((s) => s.n),
    steps.map((_, i) => i + 1),
  );
});

test("destructive steps are flagged, since the librarian refuses them unacknowledged", () => {
  for (const step of steps) {
    const emptiesSomething = touchedSlots(step.shuffle).some(
      (slot) => sourceOf(step.shuffle, slot) === undefined,
    );
    if (emptiesSomething) {
      assert.equal(step.destructive, true, `"${step.operation}" empties a slot but is not flagged`);
    }
  }
});

test("the quiet-failure list is present, since it is the point of the sheet", () => {
  assert.ok(QUIET_FAILURES.length >= 5);
  assert.ok(QUIET_FAILURES.some((q) => /NAME/.test(q)));
  assert.ok(QUIET_FAILURES.some((q) => /KIT/.test(q)));
  assert.ok(QUIET_FAILURES.some((q) => /SOUND LOCKS/.test(q)));
});
