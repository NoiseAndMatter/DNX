/**
 * Where a dropped selection would land, and how to say so.
 *
 * ## Why this is not in the page
 *
 * These three answers were functions of four module-level variables — the selection, the landing
 * slot, the landing mode and the destination's size — so the only way to ask "where would these
 * four patterns go?" was to click four patterns. They are functions of their arguments now, which
 * is the whole difference.
 *
 * ## The preview must be the merge's own arithmetic
 *
 * `landingSlotsFor` is imported from `expand/landing.ts` rather than reproduced here, because
 * **a preview worked out separately from the write is a preview that can be wrong about it** — and
 * this page paints that preview into a destination cell as if it were fact. One function, two
 * callers, no chance of them disagreeing.
 *
 * ## Out of range is shown by absence, deliberately
 *
 * A landing that runs past the end of the destination is refused *whole* by the merge — it does not
 * trim and carry on. So the preview drops those slots rather than clamping them: the cells that
 * would have been marked are simply not, which is what makes the overflow visible before anybody
 * presses Apply. `renderReport` says it in words; this says it in the grid.
 */

import { type LandingMode, landingSlotsFor } from "../../../src/expand/landing.js";
import { patternName } from "../../../src/sheet/naming.js";

/** How many patterns a Digitone II holds. The bound a landing has to fit inside. */
export const DN2_PATTERN_COUNT = 128;

export interface Landing {
  /** Chosen source patterns, **in click order** — that order is the landing order. */
  selection: readonly number[];
  /** The slot the drop was aimed at. */
  landing: number;
  mode: LandingMode;
  /** Defaults to a Digitone II's 128. A parameter so the rule can be tested at any size. */
  patternCount?: number;
}

/**
 * Which source pattern is destined for which destination slot.
 *
 * Keyed by destination, so a renderer can ask about one cell.
 */
export function pendingSources({
  selection,
  landing,
  mode,
  patternCount = DN2_PATTERN_COUNT,
}: Landing): Map<number, number> {
  const pending = new Map<number, number>();
  if (selection.length === 0) return pending;

  const slots = landingSlotsFor(selection, landing, mode);
  selection.forEach((from, i) => {
    const to = slots[i]!;
    if (to < patternCount) pending.set(to, from);
  });
  return pending;
}

/**
 * Every slot the landing would use, **including any past the end of the destination**.
 *
 * The unfiltered answer, which is a different question from `landingSlots` and needed for exactly
 * one purpose: deciding whether the landing fits at all. Filtering first would hide the overflow
 * being asked about.
 */
export function allSlots({ selection, landing, mode }: Landing): number[] {
  return selection.length === 0 ? [] : landingSlotsFor(selection, landing, mode);
}

/**
 * True when the whole landing fits inside the destination.
 *
 * **The merge refuses a landing whole rather than trimming it**, so a hint that offered a partial
 * drop would be promising something Apply will not do. One slot past the end disqualifies all of
 * them, and that is the point.
 */
export function landingFits(landing: Landing): boolean {
  const limit = landing.patternCount ?? DN2_PATTERN_COUNT;
  return allSlots(landing).every((slot) => slot < limit);
}

/** Every destination slot the pending merge would write to, in the order they were picked. */
export function landingSlots({
  selection,
  landing,
  mode,
  patternCount = DN2_PATTERN_COUNT,
}: Landing): number[] {
  if (selection.length === 0) return [];
  return landingSlotsFor(selection, landing, mode).filter((slot) => slot < patternCount);
}

/**
 * A run of slots as a person would say it.
 *
 * A consecutive run collapses to its ends, because "A1…A8" is what somebody means by eight slots in
 * a row and listing them is not. Anything else is listed and **capped**: a selection can be large
 * and a status bar cannot.
 */
export function describeSlots(slots: readonly number[]): string {
  if (slots.length === 0) return "nothing";
  if (slots.length === 1) return patternName(slots[0]!);

  const sorted = [...slots].sort((a, b) => a - b);
  const consecutive = sorted.every((slot, i) => i === 0 || slot === sorted[i - 1]! + 1);
  if (consecutive) return `${patternName(sorted[0]!)}…${patternName(sorted[sorted.length - 1]!)}`;

  const shown = sorted.slice(0, 6).map(patternName).join(", ");
  return sorted.length > 6 ? `${shown} and ${sorted.length - 6} more` : shown;
}
