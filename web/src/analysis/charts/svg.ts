/**
 * The markup every chart is wrapped in, the tooltip attributes on its marks, and the four drawing
 * idioms more than one chart needs.
 *
 * Kept apart from the charts so they all emit the same `<svg>` element and the same `data-tip-t`
 * and `data-tip-b` attributes that `mount.ts` looks for.
 *
 * ## The line breaks inside these strings are output, not formatting
 *
 * Every helper below returns markup with a newline and six spaces inside the tag, because that is
 * what the charts emitted when each of them wrote the idiom out for itself, and `charts.golden`
 * compares 29 fixtures byte for byte. The indentation is therefore fixed by the fixtures rather
 * than by the nesting of the source, which is why it does not line up with the code around it.
 */

import { escapeHtml } from "../../../../src/sheet/html.js";
import { T, W, GRID_OP, GROUND } from "./theme.js";

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

/**
 * What a chart prints where a count stopped at `POLYMETER_LIMIT` instead of being measured.
 *
 * **Two charts on one card were saying it two ways.** `cycleBars` has always printed this; the
 * alignment grid printed the saturation point itself, "1000000", with "62500 bars" under it, so
 * the same condition read as a measurement in one chart and as a bound in the other. This is the
 * wording, because it is the one that says the number is a floor.
 *
 * The entity is deliberate: this goes into `<text>` content and into a `tip` body, and the tip's
 * escaping is a round trip that a caller must pre-escape for. See `tip`.
 */
export const OVER_LIMIT = "&gt; 1M steps";

/** Fit a name to the gutter. The tooltip carries the whole thing, so nothing is lost. */
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One vertical hairline from the top of the plot, the rule every grid is made of. */
export const gridLine = (x: number, y2: number) =>
  `<line x1="${x}" y1="0" x2="${x}" y2="${y2}"
      stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;

/**
 * The bar grid: a rule every sixteen steps, behind everything else.
 *
 * Four charts draw their marks against the musical grid, and drift read against a void is not
 * read at all. The trailing edge is included — `<=` — because a span that is a whole number of
 * bars is closed on the right, and seeing that a track is not is half the point of `resetRuler`.
 */
export function barGrid(x: (step: number) => number, steps: number, y2: number): string {
  let out = "";
  for (let bar = 0; bar <= steps / 16; bar++) out += gridLine(x(bar * 16), y2);
  return out;
}

/** One number on an axis, in the muted ink every axis uses. */
export const tickLabel = (x: number, y: number, text: string | number) =>
  `<text x="${x}" y="${y}" font-size="${T.tick}"
      fill="var(--ink3)">${text}</text>`;

/**
 * The bar numbers under a plot, one per bar, nudged 3px past the rule they belong to.
 *
 * The last edge is *not* labelled — `<` where `barGrid` has `<=` — because the rule closing the
 * span is the end of the last bar, not the start of another one. The two loops looking almost the
 * same and differing in that one character is why they are here rather than copied out again.
 */
export function barAxis(x: (step: number) => number, steps: number, y: number): string {
  let out = "";
  for (let bar = 0; bar < steps / 16; bar++) out += tickLabel(x(bar * 16) + 3, y, bar + 1);
  return out;
}

/**
 * The name of a row, right-aligned into the gutter left of the plot.
 *
 * Takes the row rather than the text position: the 6px gutter and the 3.5px baseline nudge that
 * centres ten-point type on a row are part of the idiom, and six charts had all three numbers
 * written out.
 */
export const rowLabel = (padL: number, y: number, rowH: number, text: string) =>
  `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">${text}</text>`;

/** The dark well a row of marks sits in, so an empty stretch reads as empty rather than absent. */
export const rowGround = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${GROUND}"/>`;
