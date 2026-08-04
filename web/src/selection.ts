/**
 * Extending a selection, without a DOM.
 *
 * Split out of `grid.ts` because that module draws cells and binds listeners, so anything importing
 * it needs `DOM.Iterable` — which the root TypeScript config does not have, and which is why a test
 * for this function could not compile while it lived there. The same reason `dropaction.ts` and
 * `slotview.ts` are their own modules: **a pure thing inside a DOM module is a pure thing nobody can
 * test.**
 *
 * `grid.ts` re-exports it, so the two pages keep importing it from where they look for it.
 */

import { type DropModifiers } from "./dropaction.js";

/** Modifier keys, as both a `MouseEvent` and a `DragEvent` supply them. */
export interface SelectionModifiers extends DropModifiers {}

/**
 * Extend a selection the way every list in every application does.
 *
 * Shared because getting it subtly different in two tools is worse than either behaviour: shift
 * takes a range from the anchor, ctrl or meta toggles one, and a plain click replaces.
 */
export function nextSelection(
  selection: readonly number[],
  anchor: number | undefined,
  index: number,
  modifiers: SelectionModifiers,
): { selection: number[]; anchor: number } {
  if (modifiers.shiftKey && anchor !== undefined) {
    const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
    const range: number[] = [];
    for (let i = lo; i <= hi; i++) range.push(i);
    return { selection: range, anchor };
  }
  if (modifiers.ctrlKey || modifiers.metaKey) {
    const at = selection.indexOf(index);
    const next = at >= 0 ? selection.filter((i) => i !== index) : [...selection, index];
    return { selection: next, anchor: index };
  }
  return { selection: [index], anchor: index };
}
