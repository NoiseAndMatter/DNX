/**
 * Where merged patterns land — the rule, on its own, so nothing can hold a different copy of it.
 *
 * ## Why this is a module and not four lines in the merger
 *
 * The rule was `patterns.map((_, i) => landing + i)`, written out **three times**: once in
 * `merge.ts` to decide what gets written, and twice in the expander page to decide what the grid
 * previews and which cells it marks. Three copies of a rule that must agree is a preview that can
 * lie about what Apply will do — the exact failure this project keeps paying for elsewhere.
 *
 * One function, three callers, and the preview is now the same computation as the write.
 *
 * ## The two modes, and why relative is the default
 *
 * Selecting A1, A9, A10 and dropping on A1 used to write **A1, A2, A3** — contiguous from the
 * landing slot, silently discarding the spacing the musician chose. That spacing is usually
 * deliberate: it is where the variations sit relative to the main idea.
 *
 * - **`relative`** — each pattern keeps its distance from the lowest-numbered one selected. A1, A9,
 *   A10 dropped on A1 land on A1, A9, A10; dropped on B1 they land on B1, B9, B10.
 * - **`contiguous`** — the old behaviour, kept because it is the right one when the job is
 *   *gathering* scattered sketches into a block.
 *
 * **The landing slot stops being a start and becomes an anchor.** In `relative` it is where the
 * lowest-numbered selected pattern goes, and everything else is measured from there.
 *
 * ## Click order matters in one mode and not the other
 *
 * `contiguous` places patterns in the order they were picked, because that order is the only thing
 * that could decide it. `relative` ignores it entirely: a pattern's destination follows from its own
 * index, so picking A9 before A1 changes nothing. That asymmetry is a property of the two questions,
 * not an inconsistency.
 *
 * ## Crossing a bank is normal; running off the end is not
 *
 * The eight banks are one 128-slot run, so A1, A9, A10 anchored at A10 land on A10, B2, B3 and
 * nothing special happens at the boundary — confirmed by the user, whose instrument works that way.
 *
 * **There is no bank I.** A destination past the last slot has nowhere to go, so the landing is
 * refused *before anything is written* — not wrapped around to A, not clamped onto the last slot,
 * both of which would quietly put a pattern somewhere nobody chose.
 */

import { patternName } from "../project/naming.js";

export type LandingMode = "relative" | "contiguous";

/** The default, and the one that keeps what the musician arranged. */
export const DEFAULT_LANDING: LandingMode = "relative";

/**
 * Destination slot for each pattern, in the same order as `patterns`.
 *
 * **Not filtered and not clamped**, so a caller can see exactly which ones fall off the end — the
 * returned array is always the same length as the input, and out-of-range values are the honest
 * report of a landing that does not fit. `landingRefusal` turns that into a sentence.
 */
export function landingSlotsFor(
  patterns: readonly number[],
  anchor: number,
  mode: LandingMode,
): number[] {
  if (mode === "contiguous") return patterns.map((_, i) => anchor + i);

  // The lowest-numbered selection is the one that lands on the anchor, and everything else keeps
  // its distance from it. Deliberately **not** the first one clicked: spacing is a property of the
  // set, not of the order somebody happened to pick it in, and using click order here would make
  // the same three patterns land differently depending on where the mouse started.
  const base = Math.min(...patterns);
  return patterns.map((p) => anchor + (p - base));
}

/**
 * Why this landing cannot be written, or `undefined` when it can.
 *
 * Names the patterns that would fall off the end rather than the count, because the fix is almost
 * always to pick an earlier anchor and that is easier to judge when you can see which ones are the
 * problem.
 */
export function landingRefusal(
  patterns: readonly number[],
  slots: readonly number[],
  slotCount: number,
): string | undefined {
  const overflowing = slots
    .map((slot, i) => ({ slot, pattern: patterns[i]! }))
    .filter((entry) => entry.slot >= slotCount);
  if (overflowing.length === 0) return undefined;

  const names = overflowing.map((entry) => patternName(entry.pattern)).join(", ");
  return (
    `${overflowing.length} pattern(s) would land past ${patternName(slotCount - 1)}, which is the ` +
    `last slot there is: ${names}. Anchor them earlier, or take fewer.`
  );
}

/** One phrase describing a mode, for a status line or a plan panel. */
export function describeLanding(mode: LandingMode): string {
  return mode === "relative"
    ? "keeping their spacing, anchored on the drop"
    : "packed one after another from the drop";
}
