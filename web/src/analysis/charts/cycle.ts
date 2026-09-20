/**
 * How long things run before they repeat: per track within one pattern, and across several
 * patterns on one scale.
 */

import { escapeHtml } from "../../../../src/sheet/html.js";
import { barsOf, clock, repetitions, trackLabel, type AnalysisTrack } from "../model.js";
import { T } from "./theme.js";
import { tip, svg, clip, rowLabel } from "./svg.js";

/**
 * How many times each track repeats before everything lines up again.
 *
 * The half of polymeter that is a number rather than a shape. Log scale, because the values span
 * 21 to 192 and a linear axis would flatten everything that is not the culprit.
 *
 * **A log scale divides by the log of the largest value, and that is zero when every track is the
 * same length.** Then every bar is `0/0` — `NaN` — and an SVG rect with a `NaN` width draws
 * nothing while its label lands at x=0 on top of the track name. That is exactly what the first
 * real project did: the synthetic data always had mixed lengths, so the case never arose, and
 * the flat case is common — a pattern in PER PATTERN mode has one length by definition. Equal
 * repetitions are drawn equal, at full width, which is what they are.
 */
export function realignBars(tracks: readonly AnalysisTrack[], cycle: number, w: number): string {
  const rowH = 14, gap = 5, padL = 30, padR = 128;
  const sorted = [...tracks].sort((a, b) => repetitions(b, cycle) - repetitions(a, cycle));
  const h = sorted.length * (rowH + gap);
  const plot = w - padL - padR;
  const max = Math.log(Math.max(...sorted.map((t) => repetitions(t, cycle))));
  // Every track the same length: `max` is 0, the ratio is 0/0, and there is no culprit to point at
  // because nothing is stretching anything.
  const flat = max === 0;
  let out = "";
  sorted.forEach((t, i) => {
    const y = i * (rowH + gap);
    // Two places, as every other fractional number on this page is printed.
    const reps = Number(repetitions(t, cycle).toFixed(2));
    const bw = flat ? plot : Math.max(2, (Math.log(reps) / max) * plot);
    const culprit = i === 0 && !flat;
    out += `<rect x="${padL}" y="${y}" width="${bw}" height="${rowH}" rx="2"
      fill="var(${culprit ? "--s2" : "--q4"})"
      ${tip(`${trackLabel(t)} — ${t.preset}`,
        `${t.length} steps${t.speed !== undefined && t.speed !== 1 ? ` at ${t.speed}x` : ""} · ` +
        `repeats ${reps}x per cycle`)}/>`;
    out += rowLabel(padL, y, rowH, trackLabel(t));
    out += `<text x="${padL + bw + 6}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(${culprit ? "--s2" : "--ink2"})">${reps}&#215;
      <tspan fill="var(--ink3)">· ${t.length} steps${
        t.speed !== undefined && t.speed !== 1 ? ` @${t.speed}x` : ""}</tspan></text>`;
  });
  return svg(w, h, "Repetitions each track makes before the pattern realigns", out);
}

/** One subject on the comparison chart. Structural only — see `compare.ts` for where these come from. */
export interface CycleBar {
  /** How the subject names itself. Truncated to the gutter here; the tooltip carries it whole. */
  label: string;
  /** Master steps before it repeats. What the bar is proportional to. */
  cycle: number;
  /** What the track lengths alone would give, for the "cut from" annotation. */
  polymeter: number;
  /** False when counting stopped at the limit, in which case the bar runs off the scale. */
  bounded: boolean;
  /** Notes the reset silences every time round. Non-zero is the one alert state here. */
  lostTrigs: number;
  seconds: number;
  /** The subject whose full analysis is drawn below, so the two can be tied together. */
  focused?: boolean;
}

/**
 * How long each of several patterns runs before it repeats, on one scale.
 *
 * ## The scale is linear, and that is the whole point
 *
 * `realignBars` is logarithmic because it compares *ratios* within one pattern, where a track
 * repeating 124 times against one repeating twice would otherwise flatten everything between them.
 * This chart compares **durations across patterns**, and a log scale would make a four-bar loop
 * look like a meaningful fraction of a 124-bar one. A sliver next to a full bar is the truth, so a
 * sliver is what is drawn — with the number printed beside it, because a 2px bar is honest and
 * unreadable at the same time.
 *
 * ## A saturated cycle runs off the end rather than setting the scale
 *
 * Sixteen coprime lengths give a least common multiple past what a double holds, so `cycleSteps`
 * stops at `POLYMETER_LIMIT` and reports that it stopped. Letting that number set the maximum would
 * squash every real pattern beside it into nothing, to show a bar whose length is not a measurement
 * in the first place. Those rows are drawn to the full width with the bar breaking into dashes,
 * which says "longer than this chart can show" without claiming a proportion.
 *
 * ## Every row must be a pattern that plays something
 *
 * A subject with no trigs has no cycle, and `cycleSteps` returns 1 for it — the identity, because
 * there is nothing to take a least common multiple of. Handed to this chart that draws as a bar at
 * its 2px floor labelled "0.06 bars": a measurement of nothing, presented as a measurement.
 * **The caller filters those out and says so in prose instead.** A `cycle < 1` guard in here would
 * never have fired, which is exactly how the first version of this got it wrong.
 */
export function cycleBars(rows: readonly CycleBar[], w: number): string {
  const rowH = 16, gap = 7, padL = 122, padR = 156;
  const h = rows.length * (rowH + gap);
  const plot = Math.max(40, w - padL - padR);
  /*
   * Only measurable cycles set the scale. `|| 1` covers every row being unbounded or silent, where
   * there is no measurement to be proportional to and every bar is drawn at its floor.
   */
  const top = Math.max(...rows.filter((r) => r.bounded).map((r) => r.cycle), 0) || 1;
  let out = "";
  rows.forEach((r, i) => {
    const y = i * (rowH + gap);
    const mid = y + rowH / 2 + 3.5;
    const cut = r.bounded && r.polymeter > r.cycle;
    const bw = r.bounded ? Math.max(2, (r.cycle / top) * plot) : plot;
    // The alert is reserved for notes actually being silenced. A cut that loses nothing is common
    // and unremarkable, and colouring it the same would be the crying-wolf fault `resetRuler` had.
    const fill = r.lostTrigs > 0 ? "--crit" : r.focused ? "--s3" : "--q4";

    // A caret rather than a colour: the focused row is the one the cards below are about, and that
    // is a different fact from anything the bar encodes.
    if (r.focused) {
      out += `<text x="4" y="${mid}" font-size="${T.label}" fill="var(--s3)">&#9656;</text>`;
    }
    out += `<text x="${padL - 8}" y="${mid}" text-anchor="end" font-size="${T.label}"
      fill="var(${r.focused ? "--ink" : "--ink2"})">${escapeHtml(clip(r.label, 17))}</text>`;

    out += `<rect x="${padL}" y="${y}" width="${bw}" height="${rowH}" rx="2" fill="var(${fill})"
      ${tip(r.label, `${r.cycle.toLocaleString()} steps · ${barsOf(r.cycle)} · ${clock(r.seconds)}` +
        (cut ? ` · RESET cuts a ${r.polymeter.toLocaleString()}-step polymeter` : "") +
        (r.lostTrigs ? ` · ${r.lostTrigs} notes never sound` : ""))}/>`;

    /*
     * The break, for a cycle nothing counted to the end. Three dashes past the bar's end read as
     * "continues" in every chart vocabulary; the alternative — an arrowhead — reads as a pointer to
     * something, and there is nothing there to point at.
     */
    if (!r.bounded) {
      for (let d = 0; d < 3; d++) {
        out += `<rect x="${padL + bw + 4 + d * 7} " y="${y}" width="4" height="${rowH}" rx="1"
          fill="var(--q4)" opacity="${0.5 - d * 0.14}"/>`;
      }
    }

    const at = padL + bw + (r.bounded ? 6 : 30);
    out += `<text x="${at}" y="${mid}" font-size="${T.value}" fill="var(--ink2)">${
      r.bounded ? barsOf(r.cycle) : "&gt; 1M steps"}
      <tspan fill="var(--ink3)">· ${clock(r.seconds)}</tspan>${cut
        ? `<tspan fill="var(--ink3)"> · of ${barsOf(r.polymeter)}</tspan>` : ""}</text>`;
  });
  return svg(w, h, "How long each selected pattern runs before it repeats", out);
}
