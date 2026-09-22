/**
 * Pitch: which pitch classes sound and on which machines, the fitted key over time, and the notes
 * each track plays.
 */

import { escapeHtml } from "../../../../src/sheet/html.js";
import {
  MACHINE_ORDER, NOTE_NAMES, machineLabel, noteName, pitchClass, trackLabel, type PitchCell,
  type PitchWindow, type TrackRow,
} from "@noiseandmatter/dnx-core/analysis/model.js";
import { T, W, GRID_OP, GROUND, machineVar, pcHue } from "./theme.js";
import { tip, svg, gridLine, tickLabel, rowLabel, rowGround } from "./svg.js";

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
        fill="${step === null ? GROUND : `var(--q${step + 1})`}"
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
    out += tickLabel(padL + i * cw + 2, h - 3, Math.floor(win.at / 16) + 1);
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
    out += rowGround(padL, y, plot, rowH);
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
    out += rowLabel(padL, y, rowH, trackLabel(row.track));
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
    if (stepsPerCell < 16) out += gridLine(padL + j * cw, h - 14);
    out += tickLabel(padL + j * cw + 3, h - 3, Math.floor(c.at / 16) + 1);
  });
  return svg(w, h, "The notes each track plays, stacked low to high", out);
}
