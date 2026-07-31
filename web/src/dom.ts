/**
 * The small browser things every page needs, in one place.
 *
 * ## Why these in particular
 *
 * Each is four lines, which is exactly why there were three copies. `$`, `escapeHtml`, the status
 * bar and the download helper were re-typed on every page because re-typing them is cheaper than
 * finding them — and then they drifted: the manager wrote `class="status warn"`, the expander wrote
 * `class="error"`, and the probe had its own `save` while `project.ts` had `download` doing the
 * same job with a different argument.
 *
 * Small and duplicated is worse than small and shared. A page that escapes HTML slightly
 * differently from its neighbour is a page with a slightly different set of bugs.
 *
 * ## The layering this belongs to
 *
 * - `src/` — pure, platform-free, no DOM and no MIDI.
 * - `web/src/*.ts` — shared browser code. This file, `grid.ts`, `devicesource.ts`, `project.ts`.
 * - `web/src/<page>/` — one page and nothing else.
 *
 * Anything a second page needs comes up a level. It is not a tidying job to do later: leaving the
 * grid inside `manager/` is what led the expander to grow a typed slot box instead of using it.
 */

/**
 * An element by id, or a thrown error naming the one that is missing.
 *
 * Throwing rather than returning null is deliberate. Every id here is written in the same repository
 * as the page, so a missing one is a typo or a stale rename — a bug to fix, not a case to handle.
 * `test/pages.test.ts` checks every id a page asks for against its HTML for the same reason.
 */
export const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

export type StatusKind = "info" | "error" | "warn" | "ok";

/**
 * A status bar bound to one element.
 *
 * A factory rather than a function, because the pages disagree about the class: the manager and the
 * probe use `status warn`, the expander uses bare `error`. That disagreement is in their
 * stylesheets, so it is a parameter here rather than something to unify by editing CSS that already
 * works.
 */
export function statusBar(id = "status", base = "status"): (message: string, kind?: StatusKind) => void {
  return (message: string, kind: StatusKind = "info"): void => {
    const bar = $(id);
    bar.textContent = message;
    // `info` carries no class: it is the resting state, and a class named after "nothing is wrong"
    // is one more thing for a stylesheet to have an opinion about.
    bar.className = `${base}${kind === "info" ? "" : ` ${kind}`}`.trim();
  };
}

/** Escape text for insertion into HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Hand bytes to the browser as a download.
 *
 * The `slice()` is not redundant: a `Uint8Array` over a `SharedArrayBuffer` is not a valid
 * `BlobPart`, and which kind you have depends on how the runtime allocated it. Copying into a fresh
 * buffer makes that stop mattering.
 */
export function saveBytes(bytes: Uint8Array, name: string): void {
  saveBlob(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }), name);
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
