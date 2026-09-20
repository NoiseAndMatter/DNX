/**
 * Rhythm: where each track restarts and what it plays, how dense each track is, and how far the
 * microtimed trigs sit from the grid.
 */

import { escapeHtml } from "../../../../src/sheet/html.js";
import {
  MICRO_MAX, NOTE_NAMES, gateLabel, masterOffset, masterPeriod, microFraction, overlappingNotes,
  pitchClass, presetOf, trackLabel, trigDensity, type AnalysisTrack, type MicroBuckets,
} from "../model.js";
import { T, W, GRID_OP, machineVar } from "./theme.js";
import { tip, svg, barGrid, barAxis, rowLabel, rowGround } from "./svg.js";

/** What a dot on the phase strip encodes. */
export type PhaseMode = "velocity" | "length" | "locks" | "overlap";

/**
 * Phase strip: where each track restarts, and what it plays, across the pattern you can see.
 *
 * **This replaced a chart that failed at its own job.** The first version drew the whole cycle —
 * 1,344 steps — as one block per repetition. T1 got 84 blocks and T5 got 192, at two pixels each: a
 * striped mush in which the wrap points, the entire subject of the chart, were invisible.
 *
 * It now draws the master length, where a step is wide enough to see, and carries three things at
 * once: the restart tick, the repetition banding, and **the trigs themselves as dots**. That last
 * is what makes it a guide rather than a diagram — the polymeter is read against the actual rhythm
 * rather than against an empty lane.
 *
 * **There is deliberately no marker for the pattern reset.** One was built and taken out: callers
 * draw this over exactly one loop of what plays, so the reset is the right-hand edge — in 261 of
 * the 262 corpus patterns that have one, the line would have sat on the frame saying nothing.
 * Where the reset cuts a track mid-figure, `resetRuler` shows it and this chart stays about rhythm.
 */
export function phaseStrip(
  tracks: readonly AnalysisTrack[],
  windowSteps: number,
  mode: PhaseMode,
  defaultVelocity: number,
  w: number,
): string {
  const rowH = 18, gap = 3, padL = 30, padR = 74;
  const h = tracks.length * (rowH + gap) + 14;
  const plot = w - padL - padR;
  const x = (step: number) => padL + (step / windowSteps) * plot;
  const stepW = plot / windowSteps;
  let out = "";

  // Bar lines behind everything, so drift is read against the musical grid rather than in a void.
  out += barGrid(x, windowSteps, h - 14);

  tracks.forEach((t, i) => {
    const y = i * (rowH + gap);
    const fill = `var(${machineVar(t.machine)})`;
    const cy = y + rowH / 2;
    // Computed per draw rather than cached on the track: the charts do not own the caller's data.
    const pairs = mode === "overlap" ? overlappingNotes(t) : [];
    out += rowGround(padL, y, plot, rowH);

    /*
     * **A track length of zero would step this loop by zero, forever.** The producer refuses such a
     * pattern, but a chart that can hang on its input is a landmine for the next producer — and
     * this one was found by rendering the corpus, where 27 patterns in the factory PRESETS project
     * declare a length of 0 and exhausted a 4 GB heap in seconds. In a browser that is a dead tab.
     */
    // The master clock, not the track's own: a 12-step track at 3/2x restarts every 8 of these.
    const stride = t.length >= 1 ? masterPeriod(t) : windowSteps;
    for (let start = 0; start < windowSteps; start += stride) {
      const x0 = x(start), x1 = x(Math.min(start + stride, windowSteps));
      // The repetition band is context: barely there, so the dots read as the data.
      out += `<rect x="${x0 + 1}" y="${y + 2}" width="${Math.max(1, x1 - x0 - 2)}"
        height="${rowH - 4}" rx="1.5" fill="${fill}" opacity=".13"/>`;
      // The restart tick. A hairline, full height — weight comes from contrast, not thickness.
      out += `<line x1="${x0 + .5}" y1="${y}" x2="${x0 + .5}" y2="${y + rowH}"
        stroke="${fill}" stroke-width="${W.limit}" opacity=".9"
        ${tip(`${trackLabel(t)} — ${t.preset}`,
          `restarts at step ${Math.round(start) + 1} · every ${stride} master steps` +
          (t.speed !== undefined && t.speed !== 1 ? ` · ${t.length} steps at ${t.speed}x` : ""))}/>`;

      for (const g of t.trigs) {
        const at = start + masterOffset(t, g.step);
        if (at >= windowSteps) continue;
        const cxp = x(at) + stepW / 2;
        const rootPc = pitchClass(g.notes[0] ?? 0);
        const accented = g.velocity > defaultVelocity;
        let r = 2.6, op = 1, extra = "";
        if (mode === "velocity") {
          // Opacity carries velocity; the accent additionally gets a ring, so the reading never
          // depends on opacity alone — which is not a reliable channel on its own.
          op = 0.28 + (g.velocity / 127) * 0.72;
          if (accented) {
            r = 3.4;
            extra = `<circle cx="${cxp}" cy="${cy}" r="5.4" fill="none"
              stroke="${fill}" stroke-width="${W.limit}" opacity=".8"/>`;
          }
        } else if (mode === "length") {
          /*
           * A bar whose width is the note's gate, **clipped to the plot's right edge**. It was
           * not, and a long note near the end of the window ran straight through the axis and over
           * the labels beyond it — the bar was sized from the note alone, with nothing saying
           * where the drawing area stops. A gate that would extend past the window is truncated,
           * which is also what the sequencer does to it.
           */
          const bx = cxp - stepW / 2 + .75;
          const right = padL + plot;
          // An INF gate is drawn to the edge of the window rather than as `Infinity` wide.
          const bw = Math.max(2.5, Math.min(g.length * stepW - 1.5, right - bx)) || (right - bx);
          out += `<rect x="${bx}" y="${cy - 2.5}" width="${bw}" height="5"
            rx="2.5" fill="${fill}" opacity=".85"
            ${tip(`${trackLabel(t)} step ${g.step + 1}`,
              `${NOTE_NAMES[rootPc]} · length ${gateLabel(g.length)}`)}/>`;
          continue;
        } else if (mode === "locks") {
          op = g.lockPreset !== undefined ? 1 : .18;
          r = g.lockPreset !== undefined ? 3.4 : 2.2;
        } else if (mode === "overlap") {
          // A note that runs into the next one on the same track. The pair is joined, because the
          // relationship *is* the finding — a lone highlighted dot would say nothing.
          const pair = pairs.find((p) => p.a === g);
          if (pair) {
            const x2 = x(start + masterOffset(t, pair.wrap ? t.length + pair.b.step : pair.b.step))
              + stepW / 2;
            out += `<line x1="${cxp}" y1="${cy}" x2="${Math.min(x2, padL + plot)}" y2="${cy}"
              stroke="${fill}" stroke-width="1.75" opacity=".95"/>`;
            r = 3.2; op = 1;
          } else {
            op = pairs.some((p) => p.b === g) ? 1 : .16;
            r = op === 1 ? 3.2 : 2.2;
          }
        }
        out += extra;
        out += `<circle cx="${cxp}" cy="${cy}" r="${r}" fill="${fill}" opacity="${op}"
          ${tip(`${trackLabel(t)} step ${g.step + 1}${accented ? " — accent" : ""}`,
            `${presetOf(t, g)} · ${NOTE_NAMES[rootPc]} · vel ${g.velocity}`
            + (g.lockPreset !== undefined ? " · preset lock" : ""))}/>`;
      }
    }
    out += rowLabel(padL, y, rowH, trackLabel(t));
    out += `<text x="${padL + plot + 8}" y="${cy + 3.5}" font-size="${T.value}"
      fill="var(--ink3)">${t.length} steps${
        t.speed !== undefined && t.speed !== 1 ? ` @${t.speed}x` : ""}</text>`;
  });

  out += barAxis(x, windowSteps, h - 3);
  return svg(w, h, "Where each track restarts and what it plays", out);
}

/** Per-track density, stacked. The parts are components of a total, not rivals. */
export function densityBars(
  tracks: readonly AnalysisTrack[], defaultVelocity: number, w: number,
): string {
  const rowH = 13, gap = 5, padL = 30, padR = 150;
  const h = tracks.length * (rowH + gap);
  const plot = w - padL - padR;
  const rows = trigDensity(tracks, defaultVelocity);
  const max = Math.max(...rows.map((r) => r.trigs + r.accented + r.presetLocks));
  // The middle band is not "parameter locks": see `TrackDensity.accented` for what it counts and
  // why the first label was wrong.
  const parts = [
    { key: "trigs", cssVar: "--s3", name: "Note trigs" },
    { key: "accented", cssVar: "--s4", name: "Microtimed or accented" },
    { key: "presetLocks", cssVar: "--s7", name: "Preset locks" },
  ] as const;
  let out = "";
  rows.forEach((r, i) => {
    const y = i * (rowH + gap);
    let cx = padL;
    const total = r.trigs + r.accented + r.presetLocks;
    for (const part of parts) {
      const value = r[part.key];
      if (!value) continue;
      const bw = (value / max) * plot;
      out += `<rect x="${cx}" y="${y}" width="${Math.max(1, bw - 2)}" height="${rowH}" rx="2"
        fill="var(${part.cssVar})"
        ${tip(`${trackLabel(r.track)} — ${part.name}`, `${value}`)}/>`;
      cx += bw;
    }
    out += rowLabel(padL, y, rowH, trackLabel(r.track));
    out += `<text x="${cx + 6}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(--ink2)">${total}
      <tspan fill="var(--ink3)">· ${escapeHtml(r.track.preset)}</tspan></text>`;
  });
  return svg(w, h, "Note trigs, microtimed or accented trigs, and preset locks per track", out);
}

/** Keep a bucket edge inside what the sequencer offers. See `MICRO_MAX`. */
const clampMicro = (t: number) => Math.max(-MICRO_MAX, Math.min(MICRO_MAX, t));

/**
 * Microtiming, diverging around the grid.
 *
 * The one genuine polarity here: early is a different thing from late, and zero is a real midpoint
 * rather than the smallest value. The on-grid bucket is excluded from the plot on purpose — it
 * holds most of the trigs and flattened every deviation into a stub. It is stated in the caption
 * instead, which is the honest way to drop a bar rather than quietly rescaling around it.
 */

export function microDiverging(buckets: MicroBuckets["buckets"], w: number): string {
  const h = 96;
  const cx = w / 2;
  const max = Math.max(...buckets.map((b) => b.n));
  /*
   * **The axis is the parameter's range, not the data's.** Buckets are six ticks wide and centred
   * on a multiple of six, so a trig at the maximum `+23` sits in a bucket labelled 24 — a position
   * the sequencer cannot reach, and which would mean "on the next trig". Bounding the axis at
   * `MICRO_MAX` keeps every mark inside what the instrument can actually do.
   */
  const span = Math.min(MICRO_MAX, Math.max(...buckets.map((b) => Math.abs(b.at)))) + 5;
  const x = (t: number) => cx + (t / span) * (w / 2 - 30);
  const base = h - 22;
  let out = `<line x1="${cx}" y1="2" x2="${cx}" y2="${base}" stroke="var(--ink3)"
    stroke-width="${W.grid}" stroke-dasharray="2 3" opacity="${GRID_OP}"/>`;
  for (const b of buckets) {
    const bh = Math.max(3, (b.n / max) * (base - 16));
    const at = clampMicro(b.at);
    out += `<rect x="${x(at) - 7}" y="${base - bh}" width="14" height="${bh}" rx="2.5"
      fill="var(${b.at < 0 ? "--dneg" : "--dpos"})"
      ${tip(
        // The device's own fraction, and the centre is clamped into the parameter's range: a trig
        // at the maximum +23 falls in a bucket centred on 24, which would read as 1/16 — one whole
        // step, the next trig. Naming the span instead was tried and was worse: it turned a trig
        // sitting exactly on -1/32 into "-7/192 to -3/128".
        `${at < 0 ? "early" : "late"} — ${microFraction(at)}`,
        `${b.n} trig${b.n === 1 ? "" : "s"}`)}/>`;
    out += `<text x="${x(at)}" y="${base - bh - 4}" text-anchor="middle"
      font-size="${T.value}" fill="var(--ink2)">${b.n}</text>`;
  }
  out += `<line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="var(--rule)"
    stroke-width="${W.axis}" opacity="${GRID_OP}"/>`;
  out += `<text x="2" y="${h - 6}" font-size="${T.tick}" fill="var(--ink2)">&#8592; early</text>`;
  out += `<text x="${cx}" y="${h - 6}" text-anchor="middle" font-size="${T.tick}"
    fill="var(--ink3)">on the grid</text>`;
  out += `<text x="${w - 2}" y="${h - 6}" text-anchor="end" font-size="${T.tick}"
    fill="var(--ink2)">late &#8594;</text>`;
  return svg(w, h, "How far the microtimed trigs sit ahead of or behind the grid", out);
}
