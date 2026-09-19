/**
 * The charts: data in, SVG string out.
 *
 * ## Nothing here touches a document
 *
 * Every function returns markup and reads nothing but its arguments. `mount.ts` is what puts a
 * chart on a page and keeps it at the right width; the tooltip lives there too. The split is the
 * same one `selection.ts` was cut out of `grid.ts` for — **a pure thing inside a DOM module is a
 * pure thing nobody can test** — and `test/web.test.ts` enforces it by walking the import graph.
 *
 * ## Why the type scale is trustworthy
 *
 * Every chart is drawn at its container's real pixel width and its `viewBox` is set to that width,
 * so one unit inside the SVG is one CSS pixel and `T.tick` means what it says. It was not always
 * so: the viewBox was a fixed 940 while the card rendered near 1130, which multiplied every label
 * by 1.2 — a declared 10px landed at 12px against 13px body text, and the factor moved with the
 * window. That is why the labels read as huge and why the scale drifted as the window changed.
 *
 * The ramp follows the convention shared by IBM Carbon, Adobe Spectrum and the FT's visual
 * vocabulary: chart text sits a step or two below body text and never competes with it, and
 * structural lines are hairlines while only the data itself carries weight.
 *
 * ## `windowSteps`, not `window`
 *
 * The span a chart draws is the natural word for it, and it is also the name of a global these
 * modules must never reach for. Shadowing it would make a later `window.innerWidth` read as a
 * number of steps, and the boundary test that checks these files touch no browser API could not
 * tell the two apart. Named apart, both problems go away.
 *
 * ## Colour
 *
 * The `--s*`, `--q*`, `--d*` and `--crit` tokens are declared on `.viz` by whoever hosts the
 * charts, never on `:root` — they are a chart palette, not the app's, and the overlap budget in
 * `test/web.test.ts` is zero.
 */

import { escapeHtml } from "../../../src/sheet/html.js";
import {
  MACHINE_ORDER, NOTE_NAMES, gateLabel, machineLabel, masterOffset, masterPeriod, noteName,
  pitchClass, trackLabel, type AnalysisTrack, type PitchCell, type PitchWindow, type TrackRow,
} from "./model.js";
import { T, W, GRID_OP, machineVar, pcHue } from "./charts/theme.js";
import { tip, svg } from "./charts/svg.js";

export { T, W, GRID_OP, machineVar, rampBand, rampIsLight, pcHue } from "./charts/theme.js";
export { TIP_SELECTOR } from "./charts/svg.js";
export { rampLegend, legend, pcLegend, table } from "./charts/legend.js";
export { phaseStrip, densityBars, microDiverging } from "./charts/rhythm.js";
export type { PhaseMode } from "./charts/rhythm.js";
export { realignBars, cycleBars } from "./charts/cycle.js";
export type { CycleBar } from "./charts/cycle.js";
export { resetRuler, alignmentGrid } from "./charts/reset.js";

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
  for (let bar = 0; bar < n / 16; bar++) {
    out += `<text x="${x(bar * 16) + 3}" y="${h - 3}" font-size="${T.tick}"
      fill="var(--ink3)">${bar + 1}</text>`;
  }
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
  for (let bar = 0; bar <= windowSteps / 16; bar++) {
    out += `<line x1="${x(bar * 16)}" y1="0" x2="${x(bar * 16)}" y2="${h}"
      stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;
  }

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
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">${trackLabel(t)}</text>`;
  });
  return svg(w, h, "Which tracks are holding a voice at each step", out);
}

/**
 * Pitch-class histogram, stacked by machine, naming the presets on hover.
 *
 * **Stacked by machine rather than by track**, because sixteen tracks cannot be coloured — eight
 * slots is the ceiling of a categorical palette. Five machines fit it exactly. The presets are the
 * answer to *what plays this note*, and there can be dozens, so they go in the tooltip and the
 * table where a list is the right form.
 */
export function pitchBars(cells: readonly PitchCell[], w: number): string {
  const h = 138, padL = 24, padB = 20;
  const plotH = h - padB;
  const max = Math.max(...cells.map((c) => c.total));
  const slot = (w - padL) / cells.length;
  /*
   * **The bar is capped, not fitted to its slot.** At full width each segment was 128px wide and a
   * few tens tall, so a stacked bar read as a stack of separate floating bands — the segments
   * looked like unrelated marks that happened to be near each other. A bar wants to be taller than
   * it is wide, or the stacking stops being legible as one quantity.
   */
  const bw = Math.min(slot - 8, 46);
  // `-1` last: an unnameable machine is a real column, and it goes at the top of the stack rather
  // than in the middle of the named ones.
  const stackOrder = [...MACHINE_ORDER, -1];
  let out = "";
  cells.forEach((c, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const accidental = c.name.includes("#");
    let acc = 0;
    for (const machine of stackOrder) {
      const v = c.byMachine[machine];
      if (!v) continue;
      const segH = (v / max) * plotH;
      // Square corners inside the stack; only the top segment is rounded, so the parts read as one
      // bar rather than as a pile of pills.
      const top = acc + segH >= (c.total / max) * plotH - 0.5;
      out += `<rect x="${x}" y="${plotH - acc - segH}" width="${bw}"
        height="${Math.max(2, segH - 1)}" rx="${top ? 2.5 : 0}"
        fill="var(${machineVar(machine === -1 ? undefined : machine)})"
        ${tip(`${c.name} — ${machineLabel(machine === -1 ? undefined : machine)}`,
          `${v} note${v === 1 ? "" : "s"}`)}/>`;
      acc += segH;
    }
    if (c.total) {
      out += `<text x="${x + bw / 2}" y="${plotH - acc - 5}" text-anchor="middle"
        font-size="${T.value}" fill="var(--ink3)">${c.total}</text>`;
      // One transparent target per column so the tooltip can name the presets for the whole class.
      const rows = Object.entries(c.byPreset).sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${p} ×${n}`).join(" · ");
      out += `<rect x="${padL + i * slot}" y="0" width="${slot}" height="${plotH}"
        fill="transparent" ${tip(`${c.name} — ${c.total} notes`, rows)}/>`;
    }
    out += `<text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle" font-size="${T.tick}"
      fill="var(${accidental ? "--ink3" : "--ink2"})">${c.name}</text>`;
  });
  out += `<line x1="${padL}" y1="${plotH}" x2="${w}" y2="${plotH}"
    stroke="var(--rule)" stroke-width="${W.axis}" opacity="${GRID_OP}"/>`;
  return svg(w, h, "How often each pitch class sounds, and which machines play it", out);
}

/**
 * Pitch classes over time as a heat grid, with the fitted key as a ribbon beneath it.
 *
 * The grid is the fact and the ribbon is the inference, and they are stacked in that order on
 * purpose. The ribbon fades where the margin over the runner-up is small, so a passage the method
 * cannot really call *looks* like one.
 *
 * A key belongs to a **moment**, not to a pattern — with per-track lengths the tracks phase against
 * each other, so what sounds together genuinely changes bar by bar with nothing edited.
 */
export function keyTimeline(windows: readonly PitchWindow[], w: number): string {
  const rowH = 9, padL = 24, ribbon = 22, gap = 8;
  const gridH = 12 * rowH;
  const h = gridH + gap + ribbon + 16;
  const plot = w - padL;
  const cw = plot / windows.length;
  const max = Math.max(...windows.flatMap((v) => v.counts));
  let out = "";

  windows.forEach((win, i) => {
    const x = padL + i * cw;
    for (let pc = 0; pc < 12; pc++) {
      const v = win.counts[pc]!;
      const y = (11 - pc) * rowH;
      // Absence is a fact too: an empty cell is drawn as the ground, not skipped.
      const step = v === 0 ? null : Math.min(5, Math.floor((v / max) * 5.99));
      out += `<rect x="${x}" y="${y}" width="${Math.max(1, cw - .5)}" height="${rowH - .5}"
        fill="${step === null ? "#1a1f21" : `var(--q${step + 1})`}"
        ${tip(`${NOTE_NAMES[pc]} · bar ${Math.floor(win.at / 16) + 1}`,
          `${v} note${v === 1 ? "" : "s"} in this window`)}/>`;
    }
    // The ribbon. Hue says major or minor; opacity says how sure the fit is.
    const f = win.fit;
    const conf = Math.max(0.12, Math.min(1, f.margin * 6));
    out += `<rect x="${x}" y="${gridH + gap}" width="${Math.max(1, cw - .5)}" height="${ribbon}"
      fill="var(${f.minor ? "--s7" : "--s4"})" opacity="${conf}"
      ${tip(`Bar ${Math.floor(win.at / 16) + 1} — ${f.name}`,
        `margin over ${f.runnerUp}: ${f.margin.toFixed(2)} · ${f.notes} notes`)}/>`;
  });

  // Naturals are labelled and accidentals are not — the white keys, which is how anyone reading a
  // pitch axis finds their place. Labelling every other index instead gave A#, G#, F#, D#, C#: a
  // set with no musical meaning that happened to fall on even numbers.
  for (let pc = 0; pc < 12; pc++) {
    if (NOTE_NAMES[pc]!.includes("#")) continue;
    out += `<text x="${padL - 5}" y="${(11 - pc) * rowH + rowH - 1.5}" text-anchor="end"
      font-size="${T.value}" fill="var(--ink3)">${NOTE_NAMES[pc]}</text>`;
  }
  // Only a handful of tick labels: a bar number under every window is unreadable and useless.
  const every = Math.max(1, Math.round(windows.length / 10));
  windows.forEach((win, i) => {
    if (i % every) return;
    out += `<text x="${padL + i * cw + 2}" y="${h - 3}" font-size="${T.tick}"
      fill="var(--ink3)">${Math.floor(win.at / 16) + 1}</text>`;
  });
  return svg(w, h, "Pitch classes and the fitted key across the full cycle", out);
}

/**
 * One row per track, and inside each cell the notes sounding, as thin stacked bars.
 *
 * **A piano roll's readability without its vertical cost.** A real roll spends its height on tonal
 * distance, which needs 73 rows to show a couple of octaves and leaves most of them empty. Here the
 * bars are ordered low to high but spaced evenly, so a triad is three lines however wide the
 * voicing is, and ten tracks fit in the height one track would otherwise take.
 *
 * Colour is the note. **Twelve hues, and this is the one place they are allowed:** pitch class is
 * *cyclic*, not arbitrary and unordered, and a hue wheel is its conventional encoding — the one
 * case where wrapping round to the start is the truth rather than an artefact. Identity never rests
 * on it alone, because the stack is named on hover.
 */
export function trackTimeline(
  rows: readonly TrackRow[], stepsPerCell: number, w: number,
): string {
  const rowH = 26, gap = 4, padL = 30, padR = 88, barH = 3, barGap = 1.5;
  const h = rows.length * (rowH + gap) + 14;
  const plot = w - padL - padR;
  const first = rows[0];
  if (!first) return svg(w, 1, "No tracks to draw", "");
  const cw = plot / first.cells.length;
  let out = "";

  rows.forEach((row, i) => {
    const y = i * (rowH + gap);
    out += `<rect x="${padL}" y="${y}" width="${plot}" height="${rowH}" rx="2" fill="#1a1f21"/>`;
    row.cells.forEach((c, j) => {
      if (!c.stack.length) return;
      const x = padL + j * cw;
      // Packed from the bottom and centred, so a one-note cell does not sit on the floor while a
      // four-note cell fills the row — the group reads as a group.
      const stackH = c.stack.length * barH + (c.stack.length - 1) * barGap;
      const y0 = y + (rowH - stackH) / 2;
      c.stack.forEach((n, k) => {
        /*
         * The gap between cells is 3px, not 1. At 1px, two consecutive beats holding the same
         * notes drew as one unbroken line and the beat boundary vanished — the row read as a
         * single long note instead of four repeats of a chord. **The gap is what makes a repeated
         * chord look repeated.**
         */
        out += `<rect x="${x + 1.5}" y="${y0 + (c.stack.length - 1 - k) * (barH + barGap)}"
          width="${Math.max(1.5, cw - 3)}" height="${barH}" rx="1.25"
          fill="${pcHue(pitchClass(n))}"/>`;
      });
      // One target for the whole stack: the chord is a property of the group, not of a bar in it.
      out += `<rect x="${x}" y="${y}" width="${Math.max(1, cw)}" height="${rowH}"
        fill="transparent" ${tip(
          `${trackLabel(row.track)} ${escapeHtml(row.track.preset)} · bar ${Math.floor(c.at / 16) + 1}`,
          c.stack.map((n) => noteName(n)).join(" ")
          + (c.chord
            ? ` &mdash; <b>${escapeHtml(c.chord.name)}</b>`
              + (c.chord.kind ? ` <span class="r">${escapeHtml(c.chord.kind)}</span>` : "")
            : ""))}/>`;
    });
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">${trackLabel(row.track)}</text>`;
    out += `<text x="${padL + plot + 8}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(--ink3)">${escapeHtml(row.track.preset)}</text>`;
  });

  /*
   * At beat resolution the bar line is what you count in, so it is drawn as well as labelled; at
   * bar resolution there is nothing coarser to draw and the labels stand alone.
   */
  const perBar = 16 / stepsPerCell;
  const every = stepsPerCell === 16 ? Math.max(1, Math.round(first.cells.length / 10)) : perBar;
  first.cells.forEach((c, j) => {
    if (j % every) return;
    if (stepsPerCell < 16) {
      out += `<line x1="${padL + j * cw}" y1="0" x2="${padL + j * cw}" y2="${h - 14}"
        stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;
    }
    out += `<text x="${padL + j * cw + 3}" y="${h - 3}" font-size="${T.tick}"
      fill="var(--ink3)">${Math.floor(c.at / 16) + 1}</text>`;
  });
  return svg(w, h, "The notes each track plays, stacked low to high", out);
}
