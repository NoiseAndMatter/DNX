/**
 * The status bar: one line at the bottom of a page that says what just happened.
 *
 * Every tool has one, every tool spells it the same way, and it is the only element on the page
 * that three different modules write to. That makes it a thing rather than a helper, so it lives in
 * its own file with the whole contract in one place: the markup it expects, the classes it owns,
 * and the one way to write to it.
 *
 * ## The contract
 *
 * A page carries `<div class="status" id="status"></div>` as a direct child of `<body>`. `dnx.css`
 * styles `.status` — panel background, top border, and on a flowing page (`body.page`) pinned to
 * the bottom of the window. **The `status` class is the element's identity, not a decoration.**
 *
 * ## Why it is a module and not four lines in `dom.ts`
 *
 * It was four lines in `dom.ts`, and it took the expander's status bar apart. `statusBar` rebuilt
 * `className` from a `base` argument; the expander passed `""` on the strength of a comment
 * claiming its stylesheet used a bare `#status.error` — no such rule has ever existed — so the
 * first message it wrote deleted the element's own `status` class. Background, border, padding and
 * position went with it, and the text fell out as a naked line at the left edge of the page.
 *
 * Nothing in the markup or the stylesheet was wrong. The element stopped being a status bar the
 * moment it had something to say, which is why no page test could see it: every id existed, every
 * file parsed, and the class was only wrong *after* a message.
 *
 * So the module owns the identity. `mount` puts the class on and keeps it; `applyStatus` touches
 * the text and one kind class and nothing else. There is no argument left that can spell "and
 * forget what you were".
 */

import { $ } from "./dom.js";

export type StatusKind = "info" | "error" | "warn" | "ok";

/** The classes this module owns. Everything else on the element belongs to the page. */
const KINDS = ["error", "warn", "ok"] as const;

/** The identity class. `dnx.css` hangs the whole appearance of the bar off it. */
const STATUS = "status";

/** The part of a status element a message may touch: its text and its kind. */
export interface StatusTarget {
  textContent: string | null;
  classList: {
    add(name: string): void;
    remove(...names: string[]): void;
    contains?(name: string): boolean;
  };
}

/** Writes a message to a status bar. `info` is the resting state. */
export type StatusWriter = (message: string, kind?: StatusKind) => void;

/**
 * Write a message and its kind onto a status element, **touching nothing else**.
 *
 * Which classes an element carries is the page's business. This owns exactly `error`, `warn` and
 * `ok`: it adds one or none and removes the others. `info` carries no class, because it is the
 * resting state and a class named after "nothing is wrong" is one more thing for a stylesheet to
 * have an opinion about.
 *
 * Takes a target rather than an id so it can be tested without a DOM — see `test/dom.test.ts`.
 */
export function applyStatus(target: StatusTarget, message: string, kind: StatusKind = "info"): void {
  target.textContent = message;
  target.classList.remove(...KINDS);
  if (kind !== "info") target.classList.add(kind);
}

/**
 * Bind to a page's status element and return the one way to write to it.
 *
 * The class is asserted here rather than assumed: a page that renamed or hand-rolled the element
 * gets it back, once, at wiring time — the cheapest place for the mistake to be corrected.
 */
export function statusBar(id = "status"): StatusWriter {
  const bar = $(id);
  bar.classList.add(STATUS);
  return (message: string, kind: StatusKind = "info"): void => {
    applyStatus(bar, message, kind);
  };
}
