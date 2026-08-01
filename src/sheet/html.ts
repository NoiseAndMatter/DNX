/**
 * Escaping text for HTML, in one place.
 *
 * ## Why this file exists
 *
 * There were **seven** implementations of this function: `web/src/dom.ts`, `web/src/grid.ts`,
 * `web/src/render.ts`, `src/sheet/render.ts`, `src/sheet/resultsform.ts` (as `esc`),
 * `src/cli/hardwaretest.ts` and `src/cli/trackhwtest.ts`.
 *
 * Six escaped `& < > "`. **The seventh did not escape quotes** — and it was the one in `grid.ts`,
 * the module both browser pages render every slot through. Nothing was broken by it today, because
 * the grid interpolates into element text rather than into an attribute, but that is a property of
 * the current markup rather than of the function, and it was exported for anyone to pick up.
 *
 * That is the argument against small-and-duplicated in a sentence: the copies do not stay equal,
 * and the one that drifts is not the one you would have guessed.
 *
 * ## Why it lives in `src/` rather than `web/`
 *
 * Four of the seven copies are in `src/`, which is platform-free and cannot import from `web/`. So
 * the shared home has to be here, and `web/src/dom.ts` re-exports it for the pages. The dependency
 * runs one way, as everything else in this codebase does.
 */

/**
 * Escape text for insertion into HTML, including inside a quoted attribute.
 *
 * `&`, `<`, `>` and `"` — the four that change how markup parses. A single-quoted attribute would
 * also need `'`, and nothing in this codebase writes one; if that changes, this is the only place
 * that has to learn about it, which is the point.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
