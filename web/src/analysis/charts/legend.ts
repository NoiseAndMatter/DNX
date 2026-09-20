/**
 * The legends and the table view: HTML rather than SVG, printed beside a chart.
 *
 * The class names here (`legend`, `item`, `sw`, `tabular`) are styled by `viz.css` and must match
 * it.
 */

import { escapeHtml } from "../../../../src/sheet/html.js";
import { NOTE_NAMES, POLYMETER_LIMIT, stepsLabel } from "../../../../src/analysis/model.js";
import { pcHue } from "./theme.js";
import { OVER_LIMIT } from "./svg.js";

/**
 * The ramp itself, with its two ends named.
 *
 * A sequential scale without a key is a decoration. This says what the colour means in the same
 * units the cells use, and it is the thing that was missing when the grid read as "true to the data
 * and very hard to interpret".
 *
 * Both ends go through `stepsLabel` because they are alignment waits: the cells they key are
 * rounded to two places, and a legend printing seventeen digits for the same number is a legend
 * that no longer matches its chart. A saturated far end says so the same way the cells do.
 */
export function rampLegend(soonest: number, longest: number): string {
  const swatches = [0, 1, 2, 3, 4, 5].map((band) =>
    `<span class="sw" style="background:var(--q${band + 1});width:22px;border-radius:0"></span>`).join("");
  return `<div class="legend"><span class="item">
      <span style="color:var(--ink3)">back in phase sooner</span>
      <span style="display:inline-flex">${swatches}</span>
      <span style="color:var(--ink3)">later</span>
    </span><span class="item" style="color:var(--ink3)">${stepsLabel(soonest)} → ${
      longest >= POLYMETER_LIMIT ? OVER_LIMIT : `${stepsLabel(longest)} steps`}</span></div>`;
}

/** A swatch-and-label legend. Each item is `[label, css custom property]`. */
export function legend(items: readonly (readonly [string, string])[]): string {
  return `<div class="legend">` + items.map(([label, v]) =>
    `<span class="item"><span class="sw" style="background:var(${v})"></span>
     <span>${escapeHtml(label)}</span></span>`).join("") + `</div>`;
}

/** The chromatic wheel as a legend, so the hue mapping is stated rather than guessed. */
export function pcLegend(): string {
  return `<div class="legend">` + NOTE_NAMES.map((n, pc) =>
    `<span class="item"><span class="sw" style="background:${pcHue(pc)};height:3px;width:14px">
     </span><span>${n}</span></span>`).join("") + `</div>`;
}

/**
 * The same numbers as a table, folded away.
 *
 * Every chart here is an encoding of something countable, and a reader who wants the count should
 * not have to hover twelve marks to get it.
 */
export function table(
  head: readonly string[], rows: readonly (readonly (string | number)[])[],
): string {
  return `<details class="tabular"><summary>Table view</summary><table>
    <thead><tr>${head.map((x) => `<th>${escapeHtml(x)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) =>
      `<tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}
    </tbody></table></details>`;
}
