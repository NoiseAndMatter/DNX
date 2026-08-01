/**
 * What a drag-and-drop means **in the manager**. Pure rules, no DOM.
 *
 * `DropAction` and `actionFor` used to live here and have moved to `dropaction.ts`: they govern how the
 * shared grid paints a cell and the expander uses them too, so a page folder was the wrong home
 * for them. What stays is genuinely this page's policy — which drops are refused, what the hint
 * says, and which pattern an operation runs inside.
 *
 * They live apart from the handlers because they are the part with a right answer: which
 * modifier means what, and which drops are refused. A rule buried in a `dragover` listener can
 * only be checked by dragging things with a mouse, which is not a test anyone runs twice.
 */

/** Which grid a slot belongs to. A pattern and a track share index 11 and mean different things. */
export type Level = "pattern" | "track";

import { type DropAction, type DropModifiers, actionFor } from "../dropaction.js";
export { type DropAction, actionFor };

/**
 * Which pattern an operation runs *inside*, or `undefined` when it operates on patterns.
 *
 * The bug this exists to prevent: the manager used to decide "is this a track operation?" by
 * asking whether a track section was open. That was the same question only while opening
 * tracks *replaced* the pattern grid. Once the two stacked, `openPattern` stayed set while
 * patterns were on screen, so a pattern drag was executed as a track operation — silently, and
 * with the indices reinterpreted, since A5 and T5 are both index 4.
 *
 * What was dragged decides what happens. What is on screen never does.
 */
export function patternForOperation(level: Level, openPattern: number | undefined): number | undefined {
  return level === "track" ? openPattern : undefined;
}

export interface Drag {
  level: Level;
  /** Sources, in selection order — a batch lands in this order. */
  indices: number[];
}

/**
 * Whether a drop onto `(level, index)` is allowed, and why not when it is not.
 *
 * Three refusals, each for its own reason:
 *
 * - **Across levels.** A track cannot become a pattern. Nothing sensible to do.
 * - **Onto itself**, when it is the only thing dragged. A no-op that would still push an undo
 *   entry and re-verify a whole image.
 * - **A batch swap.** Many sources against one target has no single obvious meaning, so swap
 *   takes exactly two. Same rule the CLI and the buttons already follow.
 */
export function refuseDrop(
  drag: Drag | undefined,
  level: Level,
  index: number,
  action: DropAction,
): string | undefined {
  if (!drag) return "nothing is being dragged";
  if (drag.level !== level) {
    return `a ${drag.level} cannot be dropped onto a ${level}`;
  }
  if (drag.indices.length === 1 && drag.indices[0] === index) {
    return "that is where it already is";
  }
  if (action === "swap" && drag.indices.length !== 1) {
    return "a swap exchanges two, so drag one at a time";
  }
  return undefined;
}

/** What a hovered destination should draw on itself. */
export interface DropHint {
  action: DropAction;
  /** Drawn across the middle of the cell. Short and shouty, because it sits over content. */
  label: string;
}

/**
 * What to show on the cell the cursor is over, or `undefined` to show nothing.
 *
 * Two jobs the status bar was doing alone, and doing badly because it is at the other end of
 * the page from the cursor: say **which** of the three actions is about to happen, and say it
 * where the user is already looking.
 *
 * `undefined` on a refusal is the deliberate part. The browser already draws a "no" cursor for
 * a drop we decline, and that is both clearer and free; a fourth tint meaning *you cannot* would
 * compete with the three that mean *this will happen*, and the eye would have to learn which is
 * which. So a refused cell is drawn exactly like an untouched one.
 *
 * Pure, and separate from the handlers, for the same reason the rest of this module is: the
 * question "does Ctrl over a second selected pattern show SWAP?" has a right answer, and finding
 * it by dragging things with a mouse is not a test anyone runs twice.
 */
export function dropHint(
  drag: Drag | undefined,
  level: Level,
  index: number,
  modifiers: DropModifiers,
): DropHint | undefined {
  const action = actionFor(modifiers);
  if (refuseDrop(drag, level, index, action) !== undefined) return undefined;
  return { action, label: action.toUpperCase() };
}
