/**
 * The history panel — the list of what you did, and the way back to any point in it.
 *
 * ## Extracted when the library needed one too
 *
 * This was the manager's, and every line of it was earned there: the timeline that reads in one
 * direction, the *as opened* row at the foot, the refusal to offer that row once steps have been
 * trimmed, and the labels living in tooltips rather than on the buttons. Copying it would have
 * meant two of each of those decisions, and the copy would have been the one that drifted.
 *
 * The library edits a project exactly as the manager does — `Session.apply` takes any
 * image-to-image function, and adding a preset to a pool is one. So the panel is the same panel.
 *
 * ## What it does not own
 *
 * The session, the DOM ids, and what to do afterwards. It is handed the elements and the session,
 * writes the list, and calls back when a row is chosen. A page decides what "afterwards" means —
 * the manager clears its selection, the library re-audits the pool — and neither is this module's
 * business.
 */

import { type Session } from "../../src/librarian/session.js";
import { escapeHtml } from "./dom.js";

export interface HistoryElements {
  /** The `<ul>` the timeline is written into. */
  list: HTMLElement;
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
}

/**
 * Draw the timeline and set the buttons.
 *
 * Undone steps sit **above** the current position, so the list reads as one timeline: what would
 * happen again at the top, what has happened below, and the line between them is where you are.
 */
export function renderHistory(elements: HistoryElements, session: Session | undefined): void {
  const entries = session?.history() ?? [];
  const future = session?.future() ?? [];

  if (entries.length === 0 && future.length === 0) {
    elements.list.innerHTML = `<li class="hint">Nothing done yet.</li>`;
  } else {
    const row = (e: { label: string; bytes: number }, cls: string, step: string): string =>
      `<li class="${cls}" data-step="${step}" tabindex="0" role="button" ` +
      `title="Go to this point">${escapeHtml(e.label)}` +
      `<span class="b">${(e.bytes / 1024).toFixed(0)} KB</span></li>`;

    /**
     * The project as it was opened, at the foot of the list.
     *
     * Every other row is an *action*; this one is the state before any of them, and without it the
     * untouched original is the one place in the timeline you cannot click — reachable only by
     * pressing Undo once per step. Reported from the hardware.
     *
     * **Offered only when undo can actually get there.** `trimmedSteps` counts steps dropped to
     * stay inside the memory budget, and once any have gone the original is genuinely unreachable;
     * a row promising it would be a lie the session cannot keep. So that case says what happened.
     */
    const origin =
      entries.length === 0
        ? ""
        : session && session.trimmedSteps > 0
          ? `<li class="hint">${session.trimmedSteps} earlier step(s) dropped — the original is no longer reachable</li>`
          : `<li class="origin" data-step="undo:${entries.length}" tabindex="0" role="button" ` +
            `title="Go back to the project as it was opened">as opened</li>`;

    elements.list.innerHTML = [
      ...future.map((e, i) => row(e, "ahead", `redo:${future.length - i}`)),
      ...entries.slice(0, 12).map((e, i) => row(e, "", `undo:${i}`)),
      origin,
    ].join("");
  }

  elements.undo.disabled = !session?.canUndo;
  elements.redo.disabled = !session?.canRedo;
  // **The label goes in the tooltip, not on the button.** Putting the action name on the control
  // made it as wide as the longest operation name, which wrapped the top bar onto a second line and
  // moved every other control down — a toolbar that changes height as you work is worse than one
  // that says less. The name is still there for anyone who wants it, on hover.
  elements.undo.title = session?.undoLabel ? `Undo ${session.undoLabel}` : "Nothing to undo";
  elements.redo.title = session?.redoLabel ? `Redo ${session.redoLabel}` : "Nothing to redo";
}

/**
 * Walk to a point in the timeline, and say what happened.
 *
 * Returns the sentence for the status bar, or `undefined` when the session had nothing to give —
 * so a page never announces a move that did not happen.
 */
export function goToHistoryPoint(session: Session | undefined, step: string): string | undefined {
  const [direction, countText] = step.split(":");
  const count = Number(countText);
  if (!Number.isFinite(count) || count <= 0) return undefined;

  let last: string | undefined;
  for (let i = 0; i < count; i++) {
    const label = direction === "redo" ? session?.redo() : session?.undo();
    // Stop the moment the session says there is nothing left, rather than counting into thin air.
    if (!label) break;
    last = label;
  }

  if (!last) return undefined;
  const verb = direction === "redo" ? "Redid" : "Undid";
  return count === 1 ? `${verb} ${last}.` : `${verb} ${count} steps, back to ${last}.`;
}

/**
 * Make the rows clickable and keyboard-operable.
 *
 * **Delegated from the list**, not bound per row: the rows are rebuilt on every render, and
 * listeners on replaced elements are how a control quietly stops working. The rows announce
 * themselves as buttons, so they have to answer a keyboard like one.
 */
export function wireHistory(list: HTMLElement, onStep: (step: string) => void): void {
  const stepFrom = (target: EventTarget | null): string | undefined =>
    (target as HTMLElement | null)?.closest<HTMLElement>("li[data-step]")?.dataset["step"];

  list.addEventListener("click", (event) => {
    const step = stepFrom(event.target);
    if (step !== undefined) onStep(step);
  });

  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const step = stepFrom(event.target);
    if (step === undefined) return;
    event.preventDefault();
    onStep(step);
  });
}

/**
 * Undo and redo on the keyboard, the way every other application does it.
 *
 * Bound to the **buttons** rather than to the session, so a page has one path for the action and
 * the disabled state is honoured for free — a shortcut that fires when the button is grey is a
 * shortcut that does something the interface says is impossible.
 */
export function wireHistoryKeys(elements: HistoryElements): void {
  document.addEventListener("keydown", (event) => {
    // Never while somebody is typing: Ctrl+Z in a search box is the box's own undo, and stealing
    // it would make the field unusable.
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, textarea, select, [contenteditable]")) return;
    if (!(event.ctrlKey || event.metaKey)) return;

    if (event.key === "z" && !event.shiftKey) {
      event.preventDefault();
      elements.undo.click();
    } else if (event.key === "y" || (event.key === "z" && event.shiftKey)) {
      event.preventDefault();
      elements.redo.click();
    }
  });
}
