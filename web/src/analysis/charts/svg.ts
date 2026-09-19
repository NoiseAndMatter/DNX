/**
 * The markup every chart is wrapped in, and the tooltip attributes on its marks.
 *
 * Kept apart from the charts so they all emit the same `<svg>` element and the same `data-tip-t`
 * and `data-tip-b` attributes that `mount.ts` looks for.
 */

import { escapeHtml } from "../../../../src/sheet/html.js";

/**
 * Elements carrying these attributes get the shared tooltip. Exported so `mount.ts` and these
 * charts cannot disagree about the name.
 */
export const TIP_SELECTOR = "[data-tip-t]";

/**
 * Attach the shared tooltip to a mark.
 *
 * **`body` may carry markup, and the escaping is a deliberate round trip.** What is written here is
 * escaped into an attribute; the browser decodes it once when `mount.ts` reads `dataset.tipB`; that
 * result is set as `innerHTML`, so any tags the caller put in render. A *value* interpolated into
 * `body` must therefore be escaped by the caller first — it then survives two decodes as text and
 * cannot become markup, which is why a preset named `<b>` prints as `<b>` rather than emboldening
 * the tooltip.
 */
export const tip = (title: string, body: string) =>
  ` data-tip-t="${escapeHtml(title)}" data-tip-b="${escapeHtml(body)}"`;

export const svg = (w: number, h: number, label: string, body: string) =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
    aria-label="${escapeHtml(label)}">${body}</svg>`;

/** Fit a name to the gutter. The tooltip carries the whole thing, so nothing is lost. */
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
