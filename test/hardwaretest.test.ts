import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUIET_FAILURES,
  SEED_SOURCES,
  inspectedSlots,
  seedNameProblem,
  seedingFor,
  stepsFor,
} from "../src/hardwaretest/rearrange.js";
import { sourceOf, touchedSlots } from "@noiseandmatter/dnx-core/librarian/shuffle.js";

/**
 * The hardware test is only trustworthy if its layout holds. These assert the design rather
 * than the code: one artefact carrying many operations works *only* while each operation
 * lands somewhere nothing else touches, and while the reference patterns stay untouched.
 * Break either and a failure on the device stops telling you which operation caused it.
 */

/** Two names as unlike each other as the real seeds, so a crossed-over pair is obvious. */
const SEEDS = { p1: "250319", p2: "250423" } as const;

const steps = stepsFor(SEEDS);
const seeding = seedingFor();

/** Where each seeded slot starts, so a step's expectation can be checked against it. */
const startingName = new Map<number, string>([
  [SEED_SOURCES.p1, SEEDS.p1],
  [SEED_SOURCES.p2, SEEDS.p2],
  ...seeding.map((s) => [s.slot, s.from === SEED_SOURCES.p1 ? SEEDS.p1 : SEEDS.p2] as const),
]);

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

/**
 * The expectations are hand-written, and a hand-written expectation can be wrong in the one
 * way that matters: agreeing with what the code does rather than with what the operation
 * means. These derive each expectation from the shuffle instead, so the sheet cannot drift
 * from the layout it describes.
 */
test("every expectation follows from the shuffle it describes", () => {
  for (const step of steps) {
    for (const e of step.expected) {
      const from = sourceOf(step.shuffle, e.slot);
      if (from === undefined) {
        assert.equal(
          e.name,
          null,
          `step ${step.n} expects a name at slot ${e.slot}, but the shuffle empties it`,
        );
      } else {
        assert.equal(
          e.name,
          startingName.get(from),
          `step ${step.n} expects the wrong name at slot ${e.slot}: it is filled from ${from}`,
        );
      }
    }
  }
});

test("a step claims something about every slot it writes", () => {
  for (const step of steps) {
    const claimed = new Set(inspectedSlots(step));
    for (const slot of touchedSlots(step.shuffle)) {
      assert.ok(
        claimed.has(slot),
        `"${step.operation}" writes slot ${slot} but the sheet says nothing about it`,
      );
    }
  }
});

/**
 * The regression guard for the flaw that hardware testing found: the sheet used to say
 * "A13 and A14 have exchanged", which at the device cannot be checked — both slots play, and
 * without knowing which started where there is nothing to compare. A swap whose two
 * expectations named the same pattern, or named them uncrossed, would be that bug again.
 */
test("a swap expects the two names to have crossed over", () => {
  const swaps = steps.filter((s) => s.operation.startsWith("Swap"));
  assert.ok(swaps.length >= 2, "expected a same-bank and a cross-bank swap");

  for (const step of swaps) {
    assert.equal(step.expected.length, 2, `"${step.operation}" should name both slots`);
    const [a, b] = step.expected;
    assert.notEqual(a!.name, b!.name, `"${step.operation}" expects one name in both slots`);
    assert.equal(a!.name, startingName.get(b!.slot), `"${step.operation}" is not a swap`);
    assert.equal(b!.name, startingName.get(a!.slot), `"${step.operation}" is not a swap`);
  }
});

test("a batch expects the sources to land in order, by name", () => {
  const batches = steps.filter((s) => s.operation.startsWith("Batch"));
  assert.ok(batches.length >= 2, "expected a batch move and a batch copy");

  for (const step of batches) {
    // Only the slots the batch writes. A copy also claims its sources still play, and those
    // legitimately repeat the same two names.
    const written = new Set(touchedSlots(step.shuffle));
    const landed = step.expected
      .filter((e) => written.has(e.slot) && e.name !== null)
      .map((e) => e.name);

    assert.ok(landed.length >= 2, `"${step.operation}" should name at least two destinations`);
    assert.equal(
      new Set(landed).size,
      landed.length,
      `"${step.operation}" gives two destinations the same name, so a reordered batch would pass`,
    );
  }
});

test("seed names that could not be told apart are refused", () => {
  assert.equal(seedNameProblem({ p1: "250319", p2: "250423" }), undefined);
  assert.match(seedNameProblem({ p1: "SAME", p2: "SAME" }) ?? "", /both reference patterns/);
  assert.match(seedNameProblem({ p1: "", p2: "OK" }) ?? "", /no name/);
  assert.match(seedNameProblem({ p1: "OK", p2: "   " }) ?? "", /no name/);
});

test("the quiet-failure list is present, since it is the point of the sheet", () => {
  assert.ok(QUIET_FAILURES.length >= 5);
  assert.ok(QUIET_FAILURES.some((q) => /KIT/.test(q)));
  assert.ok(QUIET_FAILURES.some((q) => /SOUND LOCKS/.test(q)));
  // The name check moved into the table as a per-slot expectation, so what is left here has
  // to cover the failure a correct name would hide.
  assert.ok(QUIET_FAILURES.some((q) => /TRIG COUNT/.test(q)));
});
