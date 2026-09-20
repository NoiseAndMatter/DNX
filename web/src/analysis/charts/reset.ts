/**
 * The reset and the alignment of periods: where the reset cuts each track, and when each pair of
 * periods comes back into phase.
 */

import {
  barsOf, masterOffset, periodSources, resetPasses, speedLabel, trackLabel,
  type AnalysisTrack, type PeriodGroup,
} from "../model.js";
import { T, W, GRID_OP, rampBand, rampIsLight } from "./theme.js";
import { tip, svg } from "./svg.js";

// The one piece of arithmetic this file does. Kept local rather than exported from `model.ts`,
// because a chart that starts importing derivations is a chart that will start computing them.
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** Saturating, for the same reason `model.ts` saturates: sixteen coprime lengths overflow a double. */
const lcm = (a: number, b: number): number => {
  const value = (a / gcd(a, b)) * b;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
};
/**
 * When two **periods** realign. Periods are whole numbers of twenty-fourths — the speeds are 2,
 * 3/2, 1, 3/4, 1/2, 1/4 and 1/8 — so the arithmetic is done there and scaled back rather than
 * asking a float for the least common multiple of 10⅔ and 16.
 */
const align = (a: number, b: number): number =>
  a > 0 && b > 0 ? lcm(Math.round(a * 24), Math.round(b * 24)) / 24 : 0;

/**
 * Every track's passes laid against the reset, so an interrupted one can be seen rather than
 * deduced.
 *
 * **The chart exists for its last segment.** A track whose length divides the reset draws whole
 * blocks up to the line and stops; a track whose length does not draws a stub in the alert colour,
 * and that stub is the part of the figure the sequencer cuts off — in the same place, every time
 * the pattern comes round. Nothing on the instrument shows it: lengths and the reset live on
 * different rows of one screen and their remainder is never spelled out.
 *
 * Rows are ordered with the interrupted tracks first, because on sixteen tracks the two clean ones
 * are not what anybody opened this for.
 *
 * ## The trigs are drawn, and they are not decoration
 *
 * **A cut only matters if something was going to play in it.** 19 of the 63 interrupted tracks in
 * the corpus lose nothing — every trig sits before the cut — so an alert colour on all of them is
 * crying wolf. With the dots on, the difference is visible rather than asserted: a red stub with
 * notes in it is a part being clipped, and an empty one is only untidy arithmetic.
 *
 * ## Passes alternate shade rather than being separated by lines
 *
 * At one flat colour, five consecutive passes read as one long bar — the same fault the beat cells
 * had before their gap went from 1px to 3px. Alternating two steps of the ramp separates them with
 * no extra ink, and the gap is wider besides. **Dashed rules were the other candidate and were
 * rejected**: there are already vertical lines behind this chart and they mean bars. Two sets of
 * vertical lines meaning different things is worse than a boundary that is slightly softer.
 */
export function resetRuler(
  tracks: readonly AnalysisTrack[], resetSteps: number, w: number,
): string {
  // Rows are taller when a speed has to be spelled out under the pass count.
  const anySpeed = tracks.some((t) => t.speed !== undefined && t.speed !== 1);
  const rowH = 15, gap = anySpeed ? 13 : 5, padL = 30, padR = 150;
  // Passes, remainder and lost trigs all come from the model. This chart draws them and sorts
  // them; it does not work them out, because `resetCuts` already answers the same question and
  // two answers to one question is how the two come to differ.
  const sorted = [...resetPasses(tracks, resetSteps)].sort((a, b) => {
    if ((a.cutAfter === 0) !== (b.cutAfter === 0)) return a.cutAfter === 0 ? 1 : -1;
    return a.track.length - b.track.length;
  });
  const h = sorted.length * (rowH + gap) + 14;
  const plot = w - padL - padR;
  const x = (step: number) => padL + (step / resetSteps) * plot;
  const stepW = plot / resetSteps;
  let out = "";

  // The bar grid behind everything: a reset is nearly always a whole number of bars, and seeing
  // that a track is not is half the point.
  for (let bar = 0; bar <= resetSteps / 16; bar++) {
    out += `<line x1="${x(bar * 16)}" y1="0" x2="${x(bar * 16)}" y2="${h - 14}"
      stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;
  }

  sorted.forEach(({ track, period, passes, cutAfter: remainder, lost }, i) => {
    const y = i * (rowH + gap);
    out += `<rect x="${padL}" y="${y}" width="${plot}" height="${rowH}" rx="2" fill="#1a1f21"/>`;

    for (let pass = 0; pass < passes; pass++) {
      const from = pass * period;
      const to = Math.min(from + period, resetSteps);
      out += `<rect x="${x(from) + 1.5}" y="${y + 2}" width="${Math.max(1, x(to) - x(from) - 3)}"
        height="${rowH - 4}" rx="1.5" fill="var(--q${pass % 2 ? 3 : 4})" opacity=".62"
        ${tip(`${trackLabel(track)} — pass ${pass + 1} of ${passes}`,
          `master steps ${Math.round(from) + 1}–${Math.round(to)} · complete`)}/>`;
    }
    if (remainder) {
      const from = passes * period;
      /*
       * Alert only when notes are actually lost. A cut that lands after every trig on the track is
       * drawn as an unfilled outline: the geometry is still shown, without claiming a problem.
       */
      out += `<rect x="${x(from) + 1.5}" y="${y + 2}"
        width="${Math.max(1.5, x(from + remainder) - x(from) - 3)}" height="${rowH - 4}" rx="1.5"
        fill="${lost ? "var(--crit)" : "none"}" opacity="${lost ? 1 : .9}"
        stroke="${lost ? "none" : "var(--crit)"}" stroke-dasharray="${lost ? "" : "3 2"}"
        ${tip(`${trackLabel(track)} — cut`,
          `pass ${passes + 1} gets ${remainder} of its ${period} master steps` +
          (lost ? ` · ${lost} trig${lost === 1 ? "" : "s"} never sound` : " · no trigs in the lost part"))}/>`;
    }

    // Every trig, in every pass it appears in. Small, because the bands are the subject and these
    // are what tells you whether the last one matters.
    for (let pass = 0; pass <= passes; pass++) {
      for (const trig of track.trigs) {
        const at = pass * period + masterOffset(track, trig.step);
        if (at >= resetSteps) continue;
        const inCut = remainder > 0 && pass === passes;
        out += `<circle cx="${x(at) + Math.max(0.5, stepW / 2)}" cy="${y + rowH / 2}" r="1.9"
          fill="${inCut ? "var(--ink)" : "var(--ink2)"}" opacity="${inCut ? 1 : .75}"/>`;
      }
    }
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">${trackLabel(track)}</text>`;
    out += `<text x="${padL + plot + 8}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(${remainder && lost ? "--crit" : "--ink3"})">${remainder
        ? `cut after ${remainder} of ${period}` + (lost ? ` \u00b7 ${lost} lost` : " \u00b7 nothing lost")
        : `${passes} clean \u00d7 ${period}`}</text>`;
    // What the reader set on the instrument, when it is not the same as the period drawn.
    if (track.speed !== undefined && track.speed !== 1) {
      out += `<text x="${padL + plot + 8}" y="${y + rowH / 2 + 13}" font-size="${T.tick}"
        fill="var(--ink)">${track.length} steps @${speedLabel(track.speed)}</text>`;
    }
  });

  // The reset itself, over everything, in the colour that means "a limit" everywhere else here.
  out += `<line x1="${padL + plot}" y1="0" x2="${padL + plot}" y2="${h - 14}"
    stroke="var(--crit)" stroke-width="${W.limit}" stroke-dasharray="4 3"/>`;
  for (let bar = 0; bar < resetSteps / 16; bar++) {
    out += `<text x="${x(bar * 16) + 3}" y="${h - 3}" font-size="${T.tick}"
      fill="var(--ink3)">${bar + 1}</text>`;
  }
  return svg(w, h, `Each track's passes before the reset at ${resetSteps} steps`, out);
}

/**
 * When each pair of track lengths comes back into phase.
 *
 * **Keyed on lengths, not on tracks, and that is the whole reason it fits.** Alignment is a
 * property of two lengths: two 16-step tracks are always in phase, so a sixteen-by-sixteen grid of
 * tracks would be mostly restatement of that. Sixteen tracks means at most sixteen distinct
 * lengths, and the cells are sized to fit however many there are.
 *
 * The diagonal is the length itself — when a part comes round on its own — and the reader needs it,
 * because "T2 realigns with T5 every 48 steps" only means something beside "T2 repeats every 12".
 *
 * Colour is the sequential ramp and it is a redundant encoding — the number is in the cell. It is
 * there so a long pairing can be found by scanning rather than by reading every value.
 *
 * **The ramp runs light for a long wait, which is the opposite of print convention and right here.**
 * On a dark ground the light end is the prominent one, and the pairs that take a long time to come
 * back into phase are what somebody opened this to find. The cost is that the text has to change
 * colour with the cell: light ink on the pale end of a six-step ramp is unreadable, which is what
 * the first version of this shipped with.
 */

export function alignmentGrid(
  groups: readonly PeriodGroup[],
  w: number,
  /** The step at which *every* track aligns. Outlined, because it is the answer to the question. */
  everything?: number,
): string {
  if (groups.length === 0) return svg(w, 1, "No tracks to align", "");
  const padL = 92, gap = 3;
  const n = groups.length;
  /*
   * **A third header line, only when a speed is doing something.** The axis is periods, and a
   * period is not a control: a reader who set LEN 12 and SPEED 3/2x needs to see those two numbers
   * next to the 8 they produce, or the chart cannot be matched to the instrument.
   *
   * Drawn in full-strength ink rather than a colour. It wants to stand out, and the obvious choice
   * was the warm series hue — but `--crit` already means "notes lost" in the card this chart sits
   * in, and a second near-red meaning something else is the same fault as two sets of vertical
   * lines. Weight carries it instead.
   */
  const sources = groups.map((g) => periodSources(g).filter((s) => s.speed !== 1));
  const anySpeed = sources.some((s) => s.length > 0);
  const padT = anySpeed ? 46 : 34;
  /*
   * **Sized to fit, not to a comfortable minimum.** Sixteen distinct lengths is legal — sixteen
   * tracks, all different — and a grid with a floor under its cell width would simply run off the
   * side of the card, which is the one thing a chart may not do. Below about 46px the second line
   * of each cell is dropped rather than overlapping the first.
   */
  const cellW = Math.max(18, Math.min(120, (w - padL - 8) / n - gap));
  const roomy = cellW >= 46;
  const cellH = roomy ? 34 : 22;
  const h = padT + n * (cellH + gap) + 16;
  const worst = Math.max(...groups.flatMap((a) => groups.map((b) => align(a.period, b.period))));
  let out = "";

  groups.forEach((col, j) => {
    const x = padL + j * (cellW + gap);
    out += `<text x="${x + cellW / 2}" y="${padT - (anySpeed ? 30 : 18)}" text-anchor="middle"
      font-size="${T.label}" fill="var(--ink2)">${col.period} steps</text>`;
    out += `<text x="${x + cellW / 2}" y="${padT - (anySpeed ? 18 : 6)}" text-anchor="middle"
      font-size="${T.value}" fill="var(--ink3)">${col.labels.join(" ")}</text>`;
    if (anySpeed && sources[j]!.length) {
      out += `<text x="${x + cellW / 2}" y="${padT - 6}" text-anchor="middle"
        font-size="${T.value}" fill="var(--ink)">${sources[j]!
          .map((s) => `${s.length} @${speedLabel(s.speed)}`).join(" ")}</text>`;
    }
  });

  groups.forEach((row, i) => {
    const y = padT + i * (cellH + gap);
    out += `<text x="${padL - 8}" y="${y + cellH / 2 + (roomy ? 1 : 3)}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">${row.period} steps</text>`;
    if (roomy) {
      const from = sources[i]!.length
        ? sources[i]!.map((s) => `${s.length}@${speedLabel(s.speed)}`).join(" ")
        : "";
      out += `<text x="${padL - 8}" y="${y + cellH / 2 + 12}" text-anchor="end"
        font-size="${T.value}" fill="var(${from ? "--ink" : "--ink3"})">${
          from || row.labels.join(" ")}</text>`;
    }

    groups.forEach((col, j) => {
      const x = padL + j * (cellW + gap);
      const steps = align(row.period, col.period);
      const self = i === j;
      // Six sequential steps. A pair that is always in phase — one length dividing the other — sits
      // at the bottom of the ramp rather than off it.
      const band = rampBand(steps, worst);
      /*
       * **The ink follows the cell.** `--q4` and up are light enough that `--ink` on them is close
       * to invisible, and the number is the point of the cell — the colour is only a way to find
       * it. Measured against the ramp in `viz.css` rather than guessed: `--q4` is `#3a86b4`, which
       * is where light text stops working.
       */
      const onLight = !self && rampIsLight(band);
      // The pair that only comes round when the whole pattern does. Outlined rather than recoloured
      // so it reads as "this is the one", not as a seventh step of a six-step ramp.
      const isEverything = everything !== undefined && steps === everything && !self;
      const ink = onLight ? "#0d1418" : "var(--ink)";
      const inkDim = onLight ? "#0d1418" : "var(--ink2)";
      out += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3"
        fill="${self ? "#1a1f21" : `var(--q${band + 1})`}"
        stroke="${isEverything ? "var(--crit)" : self ? "var(--line-soft)" : "none"}"
        stroke-width="${isEverything ? 2 : 1}"
        ${tip(self ? `${row.period} master steps — on its own`
              : `${row.period} and ${col.period} master steps`,
          self
            ? `${row.labels.join(", ")} comes round every ${steps} steps · ${barsOf(steps)}`
            : `back in phase every ${steps} steps · ${barsOf(steps)}`)}/>`;
      out += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + (roomy ? 1 : 3)}"
        text-anchor="middle" font-size="${T.value}" fill="${ink}">${steps}</text>`;
      if (roomy) {
        out += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 12}" text-anchor="middle"
          font-size="${T.tick}" fill="${inkDim}" opacity="${onLight ? ".8" : "1"}"
          >${barsOf(steps)}</text>`;
      }
    });
  });
  return svg(w, h, "When each pair of track lengths comes back into phase", out);
}
