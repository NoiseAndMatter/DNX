/**
 * One pattern slot, reduced to what a grid shows. **No DOM.**
 *
 * ## Why this is shared
 *
 * Both tools draw the same grid of the same records, and both had written the mapping themselves —
 * the manager once, the expander twice. Two of the three were line for line identical, and the
 * third differed in one deliberate way that was impossible to see without putting them side by
 * side.
 *
 * That is the cost of a copied view-model: not that it is duplicated, but that a real difference
 * and an accidental one look exactly alike.
 *
 * ## The one real difference, now expressed rather than reimplemented
 *
 * The expander's **source** grid does not ask the record whether it is occupied — it asks the
 * expansion plan which patterns are *live*, because a pattern the plan will not carry should read
 * as empty even when the DN1 record has trigs in it. That is `live`, and it is the only knob here.
 *
 * No DOM, so the mapping can be tested without a browser, and so `dragrules`-style pure modules can
 * use it without dragging the DOM into the root typecheck.
 */

import type { Device } from "@noiseandmatter/dnx-core/librarian/device.js";
import { PATTERNS_PER_BANK, patternName } from "@noiseandmatter/dnx-core/project/naming.js";

/** One cell, already reduced to what it displays. */
export interface SlotView {
  index: number;
  /** `A1`, `T12` — whatever the caller's naming says. */
  id: string;
  /** The pattern or track name, or a placeholder. */
  name: string;
  /** The line underneath: `12 trigs · 3 locks`, `empty`, `unreadable version`. */
  detail: string;
  /**
   * A line between the name and the detail — the track grid's machine, `FM TONE` or `MIDI`.
   *
   * Omitted by the pattern grid, which has nothing to put there. Rendered only when present, so
   * one renderer serves both rather than two drifting apart.
   */
  machine?: string;
  /** Extra classes for this cell, e.g. `midi`. The stylesheet decides what they look like. */
  classes?: readonly string[];
  occupied: boolean;
  /**
   * False when the record's storage version is one we cannot **read**.
   *
   * Kept distinct from `occupied` because *"there is something here I cannot read"* and *"there is
   * nothing here"* must never look the same — one of them is somebody's work.
   *
   * **Not the same as the device summary's `supported`**, which means *rewritable*. A Digitone II
   * version-2 record reads perfectly and cannot be written back, so it belongs on screen looking
   * like any other pattern. The operations that would write to it refuse on their own.
   */
  supported: boolean;
}

/**
 * How one pattern slot reads.
 *
 * `live`, when given, decides occupancy instead of the record — see the note above. Everything else
 * comes from the device's own summary, including the refusal to describe a record whose storage
 * version we cannot read: **"unreadable version" is not "empty"**, and the two must never render
 * alike, because one of them is somebody's work.
 */
export function patternSlotView(
  device: Device,
  image: Uint8Array,
  index: number,
  live?: ReadonlySet<number>,
): Omit<SlotView, "index"> {
  const summary = device.summarise(image, index);
  const occupied = live ? live.has(index) : summary.occupied === true;

  return {
    id: patternName(index),
    name: summary.readable ? summary.name || "—" : `v${summary.version}`,
    detail: !summary.readable
      ? "unreadable version"
      : occupied
        ? `${summary.trigCount ?? 0} trigs${summary.soundLockCount ? ` · ${summary.soundLockCount} locks` : ""}`
        : "empty",
    occupied,
    supported: summary.readable,
  };
}

/**
 * How many slots in this bank hold something.
 *
 * Stops at `patternCount` rather than assuming a full bank: the last one is short on any device
 * whose count is not a multiple of the bank size, and counting past the end reads records that are
 * not there.
 */
export function countOccupiedIn(
  bank: number,
  device: Device,
  image: Uint8Array,
  live?: ReadonlySet<number>,
): number {
  const from = bank * PATTERNS_PER_BANK;
  const to = Math.min(from + PATTERNS_PER_BANK, device.patternCount);
  let n = 0;
  for (let index = from; index < to; index++) {
    if (live ? live.has(index) : device.summarise(image, index).occupied) n++;
  }
  return n;
}
