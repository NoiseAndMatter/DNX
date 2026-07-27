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
 */

import { patternName } from "../sheet/naming.js";
import { type Device } from "./device.js";
import { type Shuffle, clear, copyMany, moveMany, swap } from "./shuffle.js";

/** One row of the check sheet: an operation, and where to look for its result. */
export interface TestStep {
  /** Ordinal, matching the printed sheet. */
  n: number;
  operation: string;
  /** What the device should show, in the device's own slot names. */
  expect: string;
  /** Slots the tester must look at, so the sheet can list them explicitly. */
  inspect: number[];
  shuffle: Shuffle;
  /** True where the step destroys work, which the librarian requires be acknowledged. */
  destructive: boolean;
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
export function stepsFor(): TestStep[] {
  const { p1, p2 } = SEED_SOURCES;

  return [
    {
      n: 1,
      operation: "Copy, same bank",
      expect: `${patternName(bank("A", 5))} plays the same as ${patternName(p1)}, and ${patternName(p1)} still plays`,
      inspect: [p1, bank("A", 5)],
      shuffle: copyMany([p1], bank("A", 5)),
      destructive: false,
    },
    {
      n: 2,
      operation: "Copy, across banks",
      expect: `${patternName(bank("C", 1))} plays the same as ${patternName(p1)}`,
      inspect: [p1, bank("C", 1)],
      shuffle: copyMany([p1], bank("C", 1)),
      destructive: false,
    },
    {
      n: 3,
      operation: "Move, same bank",
      expect: `${patternName(bank("A", 9))} plays it, ${patternName(bank("A", 3))} is empty`,
      inspect: [bank("A", 3), bank("A", 9)],
      shuffle: moveMany([bank("A", 3)], bank("A", 9)),
      destructive: true,
    },
    {
      n: 4,
      operation: "Move, across banks",
      expect: `${patternName(bank("D", 16))} plays it, ${patternName(bank("A", 4))} is empty`,
      inspect: [bank("A", 4), bank("D", 16)],
      shuffle: moveMany([bank("A", 4)], bank("D", 16)),
      destructive: true,
    },
    {
      n: 5,
      operation: "Swap, same bank",
      expect: `${patternName(bank("A", 13))} and ${patternName(bank("A", 14))} have exchanged`,
      inspect: [bank("A", 13), bank("A", 14)],
      shuffle: swap(bank("A", 13), bank("A", 14)),
      destructive: true,
    },
    {
      n: 6,
      operation: "Swap, across banks",
      expect: `${patternName(bank("B", 1))} and ${patternName(bank("E", 1))} have exchanged`,
      inspect: [bank("B", 1), bank("E", 1)],
      shuffle: swap(bank("B", 1), bank("E", 1)),
      destructive: true,
    },
    {
      n: 7,
      operation: "Batch move, two sources",
      expect: `${patternName(bank("F", 1))} then ${patternName(bank("F", 2))} in that order; ${patternName(bank("F", 5))} and ${patternName(bank("F", 6))} empty`,
      inspect: [bank("F", 1), bank("F", 2), bank("F", 5), bank("F", 6)],
      shuffle: moveMany([bank("F", 5), bank("F", 6)], bank("F", 1)),
      destructive: true,
    },
    {
      n: 8,
      operation: "Batch copy, two sources",
      expect: `${patternName(bank("G", 3))} then ${patternName(bank("G", 4))}; ${patternName(p1)} and ${patternName(p2)} still play`,
      inspect: [bank("G", 3), bank("G", 4), p1, p2],
      shuffle: copyMany([p1, p2], bank("G", 3)),
      destructive: false,
    },
    {
      n: 9,
      operation: "Delete",
      expect: `${patternName(bank("H", 1))} is empty, selectable, and accepts a new trig`,
      inspect: [bank("H", 1)],
      shuffle: clear(bank("H", 1)),
      destructive: true,
    },
  ];
}

/** Things that fail quietly, and so have to be looked for deliberately. */
export const QUIET_FAILURES: readonly string[] = [
  "The pattern NAME the device shows. It travels inside the record, so a wrong name means we moved bytes without moving identity.",
  "The KIT — every track keeping its sound and its machine. `sound+244` travels with the kit, so a move that dropped it would leave the right notes on the wrong sounds.",
  "SOUND LOCKS, if the seed patterns have any. The pool is shared within a project, so indices should stay valid and a lock playing the wrong sound would disprove that.",
  "PER-TRACK LENGTHS, if the seed patterns use them.",
  "TEMPO and PATTERN LENGTH, which live in the metadata block beside the slot index.",
  "The cleared slot being genuinely blank rather than merely silent — select it, check the kit reads as initialised, and record a trig into it.",
];

/** Device-independent, but the sheet should say which family it was built for. */
export function describeLayout(device: Device): string {
  return `${device.name}, ${device.patternCount} pattern slots, ${device.patternCount / 16} banks of 16`;
}
