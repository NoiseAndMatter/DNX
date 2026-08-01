/**
 * What a drop means, and which modifier asks for it. **No DOM.**
 *
 * ## Why this is its own module rather than living in either of its users
 *
 * These three strings become CSS classes on a slot, are painted by the shared stylesheet, and are
 * passed by both the manager and the expander. So they are shared vocabulary, and the two obvious
 * homes are both wrong:
 *
 * - **`manager/dragrules.ts`**, where they started, is one page's folder — and `grid.ts` typed its
 *   own `action` as a bare `string` rather than import upward from a page, which is a layering
 *   inversion made visible in the type system.
 * - **`grid.ts`** looks right until you notice `dragrules.ts` says *"pure rules, no DOM"* and is
 *   type-checked by the root config, which has no DOM library at all. Pointing it at the grid broke
 *   that immediately: `NodeListOf` has no iterator without `DOM.Iterable`.
 *
 * A rule about what a gesture means does not need an element to exist. Keeping that true is what
 * lets `test/dragrules.test.ts` check the rules without a browser.
 */

/**
 * Plain drag moves — what dragging means everywhere else. Shift copies and Ctrl swaps, following
 * the file-manager convention people already have in their hands.
 *
 * Read at **drop** time, not at drag start, so changing your mind mid-drag works and the cursor can
 * say what will happen.
 */
export type DropAction = "move" | "copy" | "swap";

/**
 * The modifiers a drop rule consults.
 *
 * `altKey` is deliberately absent: **no rule reads it**, and a type that demands a key nobody
 * consults is asking for ceremony rather than describing its subject.
 */
export interface DropModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  /** Command on a Mac, where Ctrl is not the modifier people reach for. */
  metaKey: boolean;
}

/**
 * Which action the modifiers ask for.
 *
 * Ctrl wins over Shift when both are held: swap is the more specific request, and silently doing
 * the other one is worse than picking the one the user was more deliberate about.
 */
export function actionFor(event: DropModifiers): DropAction {
  if (event.ctrlKey || event.metaKey) return "swap";
  if (event.shiftKey) return "copy";
  return "move";
}
