/**
 * Voice pressure: how many voices are held at each step against the device's budget, and which
 * tracks are holding them.
 */

import { gateLabel, masterOffset, masterPeriod, trackLabel, type AnalysisTrack } from "@noiseandmatter/dnx-core/analysis/model.js";
import { T, W, GRID_OP, machineVar } from "./theme.js";
import { tip, svg, barGrid, barAxis, rowLabel } from "./svg.js";

/**
 * Voice pressure over the pattern, as a step area against the device's budget.
 *
 * A step area rather than a smooth line: voice count changes ON a step and holds. Interpolating
 * between steps would draw values the sequencer never has.
 */
export function voiceArea(series: readonly number[], budget: number, w: number): string {
  const h = 150, padL = 24, padB = 16, padT = 16;
  const plotH = h - padB;
  const n = series.length;
  const top = Math.max(budget, ...series) + 1;
  const x = (i: number) => padL + (i / n) * (w - padL);
  const y = (v: number) => padT + (plotH - padT) - (v / top) * (plotH - padT);
  let out = "";

  for (const v of [4, 8, 12, budget]) {
    out += `<line x1="${padL}" y1="${y(v)}" x2="${w}" y2="${y(v)}"
      stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;
    out += `<text x="${padL - 5}" y="${y(v) + 3}" text-anchor="end"
      font-size="${T.tick}" fill="var(--ink3)">${v}</text>`;
  }

  let d = `M ${x(0)} ${plotH}`;
  series.forEach((v, i) => { d += ` L ${x(i)} ${y(v)} L ${x(i + 1)} ${y(v)}`; });
  out += `<path d="${d} L ${x(n)} ${plotH} Z" fill="var(--q3)" opacity=".38"/>`;
  out += `<path d="${d}" fill="none" stroke="var(--q6)" stroke-width="${W.series}"
    stroke-linejoin="round"/>`;

  // The budget is a limit, not a series: a hairline, dashed, above the fill.
  out += `<line x1="${padL}" y1="${y(budget)}" x2="${w}" y2="${y(budget)}"
    stroke="var(--crit)" stroke-width="${W.limit}" stroke-dasharray="4 3"/>`;

  /*
   * Overruns are marked individually but labelled **once**.
   *
   * The first version labelled every one. On a pattern with a single overrun that reads well; on
   * one with thirty-one it printed thirty-one overlapping strings across the top of the plot and
   * the chart became unreadable at exactly the moment it had the most to say. **A chart has to
   * degrade toward the busy case, not away from it.**
   *
   * So: every over-budget step keeps its mark and its tooltip, the worst one is named, and the
   * count lives in a tile above, where a number belongs.
   */
  const worst = series.reduce((best, v, i) => (v > series[best]! ? i : best), 0);
  series.forEach((v, i) => {
    if (v <= budget) return;
    out += `<rect x="${x(i)}" y="${y(v)}" width="${Math.max(2.5, x(i + 1) - x(i))}"
      height="${plotH - y(v)}" fill="var(--crit)" opacity="${i === worst ? 1 : .62}"
      ${tip(`Step ${i + 1}`, `${v} voices — ${v - budget} over the ${budget}-voice budget`)}/>`;
  });
  if (series[worst]! > budget) {
    const near = x(worst) > w * 0.6;
    out += `<text x="${x(worst) + (near ? -6 : 6)}" y="${y(series[worst]!) - 5}"
      text-anchor="${near ? "end" : "start"}" font-size="${T.flag}"
      fill="var(--crit)">peak ${series[worst]}, step ${worst + 1}</text>`;
  }

  series.forEach((v, i) => {
    out += `<rect x="${x(i)}" y="0" width="${x(i + 1) - x(i)}" height="${plotH}"
      fill="transparent" ${tip(`Step ${i + 1}`, `${v} of ${budget} voices held`)}/>`;
  });
  out += barAxis(x, n, h - 3);
  return svg(w, h, `Concurrent voices at each step against the ${budget}-voice budget`, out);
}

/**
 * Every gate a track holds, on the same x-axis as the area above it.
 *
 * **The area chart says how many voices; this says whose.** A total alone cannot be acted on —
 * "18 voices at step 42" tells you there is a problem and nothing about what to do. Reading down
 * the highlighted column names the tracks sounding at that instant, so the decision — which trig
 * matters least — is made from the chart rather than by going and looking.
 *
 * Aligned by construction: it takes the same `padL` and plot width as `voiceArea`, so the columns
 * line up rather than approximately lining up.
 */
export function voiceLanes(
  tracks: readonly AnalysisTrack[],
  windowSteps: number,
  series: readonly number[],
  budget: number,
  w: number,
): string {
  const rowH = 11, gap = 3, padL = 24;
  const h = tracks.length * (rowH + gap);
  const plot = w - padL;
  const x = (s: number) => padL + (s / windowSteps) * plot;
  const stepW = plot / windowSteps;
  let out = "";

  // The over-budget columns, behind everything, spanning every lane. This is the anchor the whole
  // chart exists to be read against.
  series.forEach((v, i) => {
    if (v <= budget) return;
    out += `<rect x="${x(i)}" y="0" width="${Math.max(2.5, stepW)}" height="${h}"
      fill="var(--crit)" opacity=".16"/>`;
  });
  out += barGrid(x, windowSteps, h);

  tracks.forEach((t, i) => {
    const y = i * (rowH + gap);
    const fill = `var(${machineVar(t.machine)})`;
    // Same guard as `phaseStrip`, and the same clock: a zero length never reaches the window.
    const stride = t.length >= 1 ? masterPeriod(t) : windowSteps;
    for (let rep = 0; rep * stride < windowSteps; rep++) {
      for (const g of t.trigs) {
        const at = rep * stride + masterOffset(t, g.step);
        if (at >= windowSteps) continue;
        const end = Math.min(at + g.length, windowSteps);
        // Held during an overrun? Then this trig is a candidate for removal, and says so.
        let guilty = false;
        for (let k = at; k < end; k++) if (series[k]! > budget) guilty = true;
        out += `<rect x="${x(at)}" y="${y + 1}" width="${Math.max(2, x(end) - x(at) - 1)}"
          height="${rowH - 2}" rx="2" fill="${fill}" opacity="${guilty ? 1 : .42}"
          ${tip(`${trackLabel(t)} — ${t.preset}`,
            `step ${at + 1}, holds ${gateLabel(g.length)}`
            + (guilty ? " · sounding during an overrun" : ""))}/>`;
      }
    }
    out += rowLabel(padL, y, rowH, trackLabel(t));
  });
  return svg(w, h, "Which tracks are holding a voice at each step", out);
}
