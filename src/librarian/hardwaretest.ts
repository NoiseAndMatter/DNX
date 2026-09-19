/**
 * The pattern-rearrangement hardware test, as data.
 *
 * Everything the librarian does has been verified by re-reading what it wrote, which is our
 * code agreeing with itself. This builds the artefacts that ask the **device** instead.
 *
 * ## One file, not eleven
 *
 * The obvious design is a file per operation, so a failure localises. That is the wrong
 * trade here: eleven loads on a Digitone is an evening, and the method that has worked four
 * times on this project is the opposite — **one artefact carrying many changes, each
 * identified by its position.** A wrong result in bank C is a broken cross-bank copy no
 * matter what else is in the file.
 *
 * So: two files. A **baseline** that is nothing but the seed patterns and 126 captured
 * blanks, and an **operations** file built from it. The baseline is separate because it
 * answers the one question everything else depends on — do our blanks load at all — and if
 * it fails, no result from the second file means anything.
 *
 * ## Every operation lands somewhere nothing else touches
 *
 * The layout below keeps sources and destinations in separate regions so a bug in one
 * operation cannot corrupt the evidence for another. `A1` and `A2` are never written after
 * seeding: they are the reference the whole sheet is read against.
 *
 * ## Expectations name the pattern, because "they have exchanged" is not checkable
 *
 * The first version of this sheet said things like *"A13 and A14 have exchanged"*. At the
 * device that is unfalsifiable: both slots play, and without knowing which pattern started
 * where there is nothing to compare against. The tester has to take the swap on trust —
 * which is precisely the claim the test exists to check.
 *
 * So every expectation names the pattern the device should display in each slot, or says the
 * slot must be empty. `A13 -> "250423"` can be read straight off the screen and be wrong.
 * The names travel inside the pattern record, so this also tests identity rather than just
 * audio: a step that moved the right bytes to the wrong slot fails visibly.
 */

import { patternName } from "../project/naming.js";
import { type Device } from "./device.js";
import { type Shuffle, clear, copyMany, moveMany, swap } from "./shuffle.js";

/** The names of the two reference patterns, read from the project being seeded from. */
export interface SeedNames {
  p1: string;
  p2: string;
}

/** What the device should show in one slot once the step has run. */
export interface SlotExpectation {
  slot: number;
  /**
   * The pattern name the device should display, or `null` when the slot must be empty.
   *
   * Compared against the built file before the sheet is printed, so a sheet that claims
   * something the bytes do not support is never handed to a tester.
   */
  name: string | null;
}

/** One row of the check sheet: an operation, and what each slot should show afterwards. */
export interface TestStep {
  /** Ordinal, matching the printed sheet. */
  n: number;
  operation: string;
  /** Per-slot, name-based. Both what the tester reads and what the generator verifies. */
  expected: SlotExpectation[];
  /** Anything the per-slot table cannot express. */
  note?: string;
  shuffle: Shuffle;
  /** True where the step destroys work, which the librarian requires be acknowledged. */
  destructive: boolean;
}

/** Slots the tester must look at — always exactly the slots we make a claim about. */
export function inspectedSlots(step: TestStep): number[] {
  return step.expected.map((e) => e.slot);
}

/** Slot index from a bank letter and a 1-based position, `bank("C", 1)` = C1. */
function bank(letter: string, position: number): number {
  return (letter.charCodeAt(0) - 65) * 16 + (position - 1);
}

/**
 * Where each pattern starts before any operation runs.
 *
 * The seeding copies the two kept patterns into the slots that later operations consume, so
 * that a move can empty its source without destroying a reference.
 */
export const SEED_SOURCES = { p1: bank("A", 1), p2: bank("A", 2) } as const;

export interface Seeding {
  /** Slot to fill, and which of the two seed patterns goes there. */
  slot: number;
  from: number;
}

export function seedingFor(): Seeding[] {
  const { p1, p2 } = SEED_SOURCES;
  return [
    { slot: bank("A", 3), from: p1 }, // consumed by the same-bank move
    { slot: bank("A", 4), from: p2 }, // consumed by the cross-bank move
    { slot: bank("A", 13), from: p1 }, // same-bank swap, left side
    { slot: bank("A", 14), from: p2 }, // same-bank swap, right side
    { slot: bank("B", 1), from: p1 }, // cross-bank swap, left side
    { slot: bank("E", 1), from: p2 }, // cross-bank swap, right side
    { slot: bank("F", 5), from: p1 }, // batch move, first source
    { slot: bank("F", 6), from: p2 }, // batch move, second source
    { slot: bank("H", 1), from: p1 }, // deleted outright
  ];
}

/**
 * The operations, in the order they must be applied.
 *
 * Order matters only in that seeding comes first; the steps themselves touch disjoint slots
 * so that one failing cannot explain another.
 */
export function stepsFor(seeds: SeedNames): TestStep[] {
  const { p1, p2 } = SEED_SOURCES;
  const { p1: n1, p2: n2 } = seeds;

  return [
    {
      n: 1,
      operation: "Copy, same bank",
      expected: [
        { slot: p1, name: n1 },
        { slot: bank("A", 5), name: n1 },
      ],
      note: "A copy leaves the source alone — both slots play, and both carry the same name.",
      shuffle: copyMany([p1], bank("A", 5)),
      destructive: false,
    },
    {
      n: 2,
      operation: "Copy, across banks",
      expected: [
        { slot: p1, name: n1 },
        { slot: bank("C", 1), name: n1 },
      ],
      shuffle: copyMany([p1], bank("C", 1)),
      destructive: false,
    },
    {
      n: 3,
      operation: "Move, same bank",
      expected: [
        { slot: bank("A", 3), name: null },
        { slot: bank("A", 9), name: n1 },
      ],
      shuffle: moveMany([bank("A", 3)], bank("A", 9)),
      destructive: true,
    },
    {
      n: 4,
      operation: "Move, across banks",
      expected: [
        { slot: bank("A", 4), name: null },
        { slot: bank("D", 16), name: n2 },
      ],
      shuffle: moveMany([bank("A", 4)], bank("D", 16)),
      destructive: true,
    },
    {
      // Seeded A13 = p1 and A14 = p2, so after the swap the names must have crossed over.
      // Naming them is the whole point: "they have exchanged" cannot be checked at the device.
      n: 5,
      operation: "Swap, same bank",
      expected: [
        { slot: bank("A", 13), name: n2 },
        { slot: bank("A", 14), name: n1 },
      ],
      note: `Before the swap A13 held ${n1} and A14 held ${n2}.`,
      shuffle: swap(bank("A", 13), bank("A", 14)),
      destructive: true,
    },
    {
      n: 6,
      operation: "Swap, across banks",
      expected: [
        { slot: bank("B", 1), name: n2 },
        { slot: bank("E", 1), name: n1 },
      ],
      note: `Before the swap B1 held ${n1} and E1 held ${n2}.`,
      shuffle: swap(bank("B", 1), bank("E", 1)),
      destructive: true,
    },
    {
      n: 7,
      operation: "Batch move, two sources",
      expected: [
        { slot: bank("F", 1), name: n1 },
        { slot: bank("F", 2), name: n2 },
        { slot: bank("F", 5), name: null },
        { slot: bank("F", 6), name: null },
      ],
      note: "The batch lands in source order, so the names also test that the order held.",
      shuffle: moveMany([bank("F", 5), bank("F", 6)], bank("F", 1)),
      destructive: true,
    },
    {
      n: 8,
      operation: "Batch copy, two sources",
      expected: [
        { slot: bank("G", 3), name: n1 },
        { slot: bank("G", 4), name: n2 },
        { slot: p1, name: n1 },
        { slot: p2, name: n2 },
      ],
      shuffle: copyMany([p1, p2], bank("G", 3)),
      destructive: false,
    },
    {
      n: 9,
      operation: "Delete",
      expected: [{ slot: bank("H", 1), name: null }],
      note:
        "Empty is not enough — select it, check the kit reads as initialised, and record a " +
        "trig into it. A slot that looks blank but refuses a trig is a different bug.",
      shuffle: clear(bank("H", 1)),
      destructive: true,
    },
  ];
}

/**
 * Why the two reference patterns must have different, non-empty names.
 *
 * Every expectation is read by comparing a name on the device's screen. Two seeds sharing a
 * name makes the swap and batch rows unfalsifiable again — the sheet would look precise and
 * check nothing. Returns the reason to refuse, or `undefined` when the seeds are usable.
 */
export function seedNameProblem(seeds: SeedNames): string | undefined {
  if (seeds.p1.trim() === "" || seeds.p2.trim() === "") {
    return "a reference pattern has no name, so nothing on the sheet could be read off the device";
  }
  if (seeds.p1 === seeds.p2) {
    return (
      `both reference patterns are named "${seeds.p1}", so a swap or a reordered batch ` +
      `would look identical either way — pick two differently named patterns`
    );
  }
  return undefined;
}

/** Render one expectation the way the sheet and the console both want it. */
export function describeExpectation(e: SlotExpectation): string {
  return `${patternName(e.slot)} ${e.name === null ? "empty" : `"${e.name}"`}`;
}

/**
 * Things that fail quietly, and so have to be looked for deliberately.
 *
 * The NAME check that used to head this list is now in the table itself, as a per-slot
 * expectation — it is the mechanism the sheet is read by rather than an afterthought.
 */
export const QUIET_FAILURES: readonly string[] = [
  "The KIT — every track keeping its sound and its machine. `sound+244` travels with the kit, so a move that dropped it would leave the right notes on the wrong sounds. A correct NAME with a wrong kit is exactly the failure the table alone would miss.",
  "SOUND LOCKS, if the seed patterns have any. The pool is shared within a project, so indices should stay valid and a lock playing the wrong sound would disprove that.",
  "PER-TRACK LENGTHS, if the seed patterns use them.",
  "TEMPO and PATTERN LENGTH, which live in the metadata block beside the slot index.",
  "TRIG COUNT — the table names the pattern, but a truncated copy would keep the name and lose the notes. The seed trig counts are printed above.",
];

/** Device-independent, but the sheet should say which family it was built for. */
export function describeLayout(device: Device): string {
  return `${device.name}, ${device.patternCount} pattern slots, ${device.patternCount / 16} banks of 16`;
}
