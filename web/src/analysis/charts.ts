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
// The one piece of arithmetic this file does. Kept local rather than exported from `model.ts`,
// because a chart that starts importing derivations is a chart that will start computing them.
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** Saturating, for the same reason `model.ts` saturates: sixteen coprime lengths overflow a double. */
const lcm = (a: number, b: number): number => {
  const value = (a / gcd(a, b)) * b;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
};
import {
  MACHINE_ORDER, NOTE_NAMES, machineLabel, noteName, overlappingNotes, pitchClass, presetOf,
  type AnalysisTrack, type MicroBuckets, type PitchCell, type PitchWindow, type TrackRow,
} from "./model.js";

/** Chart type sizes, in real pixels. */
export const T = {
  tick: 10,     // axis and scale numbers
  label: 10,    // series and category names
  value: 9,     // numbers printed against a mark
  flag: 10,     // the one call-out per chart
} as const;

/** Stroke weights. `series` was 2 and was the single biggest cause of the heaviness. */
export const W = {
  series: 1.25,
  limit: 1,
  axis: 1,
  grid: 1,
} as const;

/** Gridlines carry at low opacity rather than at low weight. */
export const GRID_OP = 0.55;

/** What a dot on the phase strip encodes. */
export type PhaseMode = "velocity" | "length" | "locks" | "overlap";

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
const tip = (title: string, body: string) =>
  ` data-tip-t="${escapeHtml(title)}" data-tip-b="${escapeHtml(body)}"`;

const svg = (w: number, h: number, label: string, body: string) =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
    aria-label="${escapeHtml(label)}">${body}</svg>`;

/**
 * A machine's series colour.
 *
 * Five machines against an eight-slot categorical palette, which is why the pitch histogram stacks
 * by machine and not by track: sixteen tracks cannot be coloured, and five can. A machine this
 * project cannot name gets the muted ink rather than a sixth hue, so "unknown" never looks like a
 * category of its own.
 */
export function machineVar(machine: number | undefined): string {
  const at = machine === undefined ? -1 : MACHINE_ORDER.indexOf(machine);
  return at === -1 ? "--ink3" : `--s${at + 1}`;
}

/**
 * Which step of the six-value sequential ramp a wait falls on.
 *
 * **Exported so the grid and the prose under it can agree.** A colour that appears in a chart and
 * nowhere else is a colour the reader has to hold in their head; the same number written in a
 * sentence should carry the same swatch. Logarithmic, because alignments span 2 bars to 124 in the
 * same pattern and a linear ramp would put every one of them except the worst in the first band.
 */
export function rampBand(steps: number, worst: number): number {
  if (!(worst > 1) || !(steps > 0)) return 0;
  return Math.min(5, Math.max(0, Math.floor((Math.log(steps) / Math.log(worst)) * 5.99)));
}

/** True when `--q<band+1>` is light enough that dark ink reads better on it. */
export function rampIsLight(band: number): boolean {
  return band >= 3;
}

/**
 * The ramp itself, with its two ends named.
 *
 * A sequential scale without a key is a decoration. This says what the colour means in the same
 * units the cells use, and it is the thing that was missing when the grid read as "true to the data
 * and very hard to interpret".
 */
export function rampLegend(soonest: number, longest: number): string {
  const swatches = [0, 1, 2, 3, 4, 5].map((band) =>
    `<span class="sw" style="background:var(--q${band + 1});width:22px;border-radius:0"></span>`).join("");
  return `<div class="legend"><span class="item">
      <span style="color:var(--ink3)">back in phase sooner</span>
      <span style="display:inline-flex">${swatches}</span>
      <span style="color:var(--ink3)">later</span>
    </span><span class="item" style="color:var(--ink3)">${soonest} → ${longest} steps</span></div>`;
}

/** The hue wheel for pitch class — see `trackTimeline` for why twelve hues are allowed here. */
export const pcHue = (pc: number) => `hsl(${pc * 30} 52% 56%)`;

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
  for (let bar = 0; bar <= windowSteps / 16; bar++) {
    out += `<line x1="${x(bar * 16)}" y1="0" x2="${x(bar * 16)}" y2="${h - 14}"
      stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;
  }

  tracks.forEach((t, i) => {
    const y = i * (rowH + gap);
    const fill = `var(${machineVar(t.machine)})`;
    const cy = y + rowH / 2;
    // Computed per draw rather than cached on the track: the charts do not own the caller's data.
    const pairs = mode === "overlap" ? overlappingNotes(t) : [];
    out += `<rect x="${padL}" y="${y}" width="${plot}" height="${rowH}" rx="2" fill="#1a1f21"/>`;

    /*
     * **A track length of zero would step this loop by zero, forever.** The producer refuses such a
     * pattern, but a chart that can hang on its input is a landmine for the next producer — and
     * this one was found by rendering the corpus, where 27 patterns in the factory PRESETS project
     * declare a length of 0 and exhausted a 4 GB heap in seconds. In a browser that is a dead tab.
     */
    const stride = t.length >= 1 ? t.length : windowSteps;
    for (let start = 0; start < windowSteps; start += stride) {
      const x0 = x(start), x1 = x(Math.min(start + stride, windowSteps));
      // The repetition band is context: barely there, so the dots read as the data.
      out += `<rect x="${x0 + 1}" y="${y + 2}" width="${Math.max(1, x1 - x0 - 2)}"
        height="${rowH - 4}" rx="1.5" fill="${fill}" opacity=".13"/>`;
      // The restart tick. A hairline, full height — weight comes from contrast, not thickness.
      out += `<line x1="${x0 + .5}" y1="${y}" x2="${x0 + .5}" y2="${y + rowH}"
        stroke="${fill}" stroke-width="${W.limit}" opacity=".9"
        ${tip(`T${t.number} — ${t.preset}`,
          `restarts at step ${start + 1} · every ${t.length} steps`)}/>`;

      for (const g of t.trigs) {
        const at = start + g.step;
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
          const bw = Math.max(2.5, Math.min(g.length * stepW - 1.5, right - bx));
          out += `<rect x="${bx}" y="${cy - 2.5}" width="${bw}" height="5"
            rx="2.5" fill="${fill}" opacity=".85"
            ${tip(`T${t.number} step ${g.step + 1}`,
              `${NOTE_NAMES[rootPc]} · length ${g.length} steps`)}/>`;
          continue;
        } else if (mode === "locks") {
          op = g.lockPreset !== undefined ? 1 : .18;
          r = g.lockPreset !== undefined ? 3.4 : 2.2;
        } else if (mode === "overlap") {
          // A note that runs into the next one on the same track. The pair is joined, because the
          // relationship *is* the finding — a lone highlighted dot would say nothing.
          const pair = pairs.find((p) => p.a === g);
          if (pair) {
            const x2 = x(start + (pair.wrap ? t.length + pair.b.step : pair.b.step)) + stepW / 2;
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
          ${tip(`T${t.number} step ${g.step + 1}${accented ? " — accent" : ""}`,
            `${presetOf(t, g)} · ${NOTE_NAMES[rootPc]} · vel ${g.velocity}`
            + (g.lockPreset !== undefined ? " · preset lock" : ""))}/>`;
      }
    }
    out += `<text x="${padL - 6}" y="${cy + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">T${t.number}</text>`;
    out += `<text x="${padL + plot + 8}" y="${cy + 3.5}" font-size="${T.value}"
      fill="var(--ink3)">${t.length} steps</text>`;
  });

  for (let bar = 0; bar < windowSteps / 16; bar++) {
    out += `<text x="${x(bar * 16) + 3}" y="${h - 3}" font-size="${T.tick}"
      fill="var(--ink3)">${bar + 1}</text>`;
  }
  return svg(w, h, "Where each track restarts and what it plays", out);
}

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
  const sorted = [...tracks].sort((a, b) => cycle / b.length - cycle / a.length);
  const h = sorted.length * (rowH + gap);
  const plot = w - padL - padR;
  const max = Math.log(Math.max(...sorted.map((t) => cycle / t.length)));
  // Every track the same length: `max` is 0, the ratio is 0/0, and there is no culprit to point at
  // because nothing is stretching anything.
  const flat = max === 0;
  let out = "";
  sorted.forEach((t, i) => {
    const y = i * (rowH + gap);
    const reps = cycle / t.length;
    const bw = flat ? plot : Math.max(2, (Math.log(reps) / max) * plot);
    const culprit = i === 0 && !flat;
    out += `<rect x="${padL}" y="${y}" width="${bw}" height="${rowH}" rx="2"
      fill="var(${culprit ? "--s2" : "--q4"})"
      ${tip(`T${t.number} — ${t.preset}`,
        `${t.length} steps · repeats ${reps}x per cycle`)}/>`;
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">T${t.number}</text>`;
    out += `<text x="${padL + bw + 6}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(${culprit ? "--s2" : "--ink2"})">${reps}&#215;
      <tspan fill="var(--ink3)">· ${t.length} steps</tspan></text>`;
  });
  return svg(w, h, "Repetitions each track makes before the pattern realigns", out);
}

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
    // Same guard as `phaseStrip`: a zero length makes `rep * 0` never reach the window.
    const stride = t.length >= 1 ? t.length : windowSteps;
    for (let rep = 0; rep * stride < windowSteps; rep++) {
      for (const g of t.trigs) {
        const at = rep * stride + g.step;
        if (at >= windowSteps) continue;
        const end = Math.min(at + g.length, windowSteps);
        // Held during an overrun? Then this trig is a candidate for removal, and says so.
        let guilty = false;
        for (let k = at; k < end; k++) if (series[k]! > budget) guilty = true;
        out += `<rect x="${x(at)}" y="${y + 1}" width="${Math.max(2, x(end) - x(at) - 1)}"
          height="${rowH - 2}" rx="2" fill="${fill}" opacity="${guilty ? 1 : .42}"
          ${tip(`T${t.number} — ${t.preset}`,
            `step ${at + 1}, holds ${g.length} step${g.length === 1 ? "" : "s"}`
            + (guilty ? " · sounding during an overrun" : ""))}/>`;
      }
    }
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">T${t.number}</text>`;
  });
  return svg(w, h, "Which tracks are holding a voice at each step", out);
}

/** Per-track density, stacked. The parts are components of a total, not rivals. */
export function densityBars(
  tracks: readonly AnalysisTrack[], defaultVelocity: number, w: number,
): string {
  const rowH = 13, gap = 5, padL = 30, padR = 150;
  const h = tracks.length * (rowH + gap);
  const plot = w - padL - padR;
  const rows = tracks.map((t) => ({
    track: t,
    trigs: t.trigs.length,
    plocks: t.trigs.filter((g) => g.microTiming !== 0 || g.velocity > defaultVelocity).length,
    locks: t.trigs.filter((g) => g.lockPreset !== undefined).length,
  }));
  const max = Math.max(...rows.map((r) => r.trigs + r.plocks + r.locks));
  /*
   * **The middle band is not "parameter locks", and calling it that was wrong.**
   *
   * It counts trigs carrying microtiming or a velocity above the track default — and on a Digitone
   * II both of those live in the trig slot itself, which is exactly why `plockparams.ts` lists
   * `TRIG 1 VEL` and `TRIG 1 NOTE` under `NOT_LOCKABLE`. They are per-trig *values*, not entries in
   * the lock table. The label now says what is counted; the real lock table is a separate reading
   * and is not in this chart.
   */
  const parts = [
    { key: "trigs", cssVar: "--s3", name: "Note trigs" },
    { key: "plocks", cssVar: "--s4", name: "Microtimed or accented" },
    { key: "locks", cssVar: "--s7", name: "Preset locks" },
  ] as const;
  let out = "";
  rows.forEach((r, i) => {
    const y = i * (rowH + gap);
    let cx = padL;
    const total = r.trigs + r.plocks + r.locks;
    for (const part of parts) {
      const value = r[part.key];
      if (!value) continue;
      const bw = (value / max) * plot;
      out += `<rect x="${cx}" y="${y}" width="${Math.max(1, bw - 2)}" height="${rowH}" rx="2"
        fill="var(${part.cssVar})"
        ${tip(`T${r.track.number} — ${part.name}`, `${value}`)}/>`;
      cx += bw;
    }
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">T${r.track.number}</text>`;
    out += `<text x="${cx + 6}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(--ink2)">${total}
      <tspan fill="var(--ink3)">· ${escapeHtml(r.track.preset)}</tspan></text>`;
  });
  return svg(w, h, "Note trigs, microtimed or accented trigs, and preset locks per track", out);
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
  const span = Math.max(...buckets.map((b) => Math.abs(b.at))) + 5;
  const x = (t: number) => cx + (t / span) * (w / 2 - 30);
  const base = h - 22;
  let out = `<line x1="${cx}" y1="2" x2="${cx}" y2="${base}" stroke="var(--ink3)"
    stroke-width="${W.grid}" stroke-dasharray="2 3" opacity="${GRID_OP}"/>`;
  for (const b of buckets) {
    const bh = Math.max(3, (b.n / max) * (base - 16));
    out += `<rect x="${x(b.at) - 7}" y="${base - bh}" width="14" height="${bh}" rx="2.5"
      fill="var(${b.at < 0 ? "--dneg" : "--dpos"})"
      ${tip(b.at < 0 ? `${-b.at} ticks early` : `${b.at} ticks late`,
        `${b.n} trig${b.n === 1 ? "" : "s"}`)}/>`;
    out += `<text x="${x(b.at)}" y="${base - bh - 4}" text-anchor="middle"
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
          `T${row.track.number} ${escapeHtml(row.track.preset)} · bar ${Math.floor(c.at / 16) + 1}`,
          c.stack.map((n) => noteName(n)).join(" ")
          + (c.chord
            ? ` &mdash; <b>${escapeHtml(c.chord.name)}</b>`
              + (c.chord.kind ? ` <span class="r">${escapeHtml(c.chord.kind)}</span>` : "")
            : ""))}/>`;
    });
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">T${row.track.number}</text>`;
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
 */
export function resetRuler(
  tracks: readonly AnalysisTrack[], resetSteps: number, w: number,
): string {
  const rowH = 15, gap = 5, padL = 30, padR = 96;
  const cut = (t: AnalysisTrack) => (t.length >= 1 ? resetSteps % t.length : 0);
  const sorted = [...tracks].sort((a, b) => {
    const ca = cut(a), cb = cut(b);
    if ((ca === 0) !== (cb === 0)) return ca === 0 ? 1 : -1;
    return a.length - b.length;
  });
  const h = sorted.length * (rowH + gap) + 14;
  const plot = w - padL - padR;
  const x = (step: number) => padL + (step / resetSteps) * plot;
  let out = "";

  // The bar grid behind everything: a reset is nearly always a whole number of bars, and seeing
  // that a track is not is half the point.
  for (let bar = 0; bar <= resetSteps / 16; bar++) {
    out += `<line x1="${x(bar * 16)}" y1="0" x2="${x(bar * 16)}" y2="${h - 14}"
      stroke="var(--rule)" stroke-width="${W.grid}" opacity="${GRID_OP}"/>`;
  }

  sorted.forEach((track, i) => {
    const y = i * (rowH + gap);
    const remainder = cut(track);
    const passes = track.length >= 1 ? Math.floor(resetSteps / track.length) : 0;
    out += `<rect x="${padL}" y="${y}" width="${plot}" height="${rowH}" rx="2" fill="#1a1f21"/>`;

    for (let pass = 0; pass < passes; pass++) {
      const from = pass * track.length;
      const to = Math.min(from + track.length, resetSteps);
      out += `<rect x="${x(from) + 1}" y="${y + 2}" width="${Math.max(1, x(to) - x(from) - 2)}"
        height="${rowH - 4}" rx="1.5" fill="var(--q4)" opacity=".55"
        ${tip(`T${track.number} — pass ${pass + 1} of ${passes}`,
          `steps ${from + 1}–${to} · complete`)}/>`;
    }
    if (remainder) {
      const from = passes * track.length;
      out += `<rect x="${x(from) + 1}" y="${y + 2}"
        width="${Math.max(1.5, x(from + remainder) - x(from) - 2)}" height="${rowH - 4}" rx="1.5"
        fill="var(--crit)"
        ${tip(`T${track.number} — cut`,
          `pass ${passes + 1} gets ${remainder} of its ${track.length} steps before the reset`)}/>`;
    }
    out += `<text x="${padL - 6}" y="${y + rowH / 2 + 3.5}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">T${track.number}</text>`;
    out += `<text x="${padL + plot + 8}" y="${y + rowH / 2 + 3.5}" font-size="${T.value}"
      fill="var(${remainder ? "--crit" : "--ink3"})">${remainder
        ? `cut after ${remainder} of ${track.length}`
        : `${passes} clean \u00d7 ${track.length}`}</text>`;
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
/**
 * Steps as bars, and it says `1 bar` rather than `1 bars`.
 *
 * A track length need not be a multiple of sixteen — 12 and 24 are both common — so the count is
 * often fractional and printing an em-dash for those, as the first version did, threw away the
 * number a reader of a 24-step track most wants.
 */
function bars(steps: number): string {
  const value = steps / 16;
  if (Number.isInteger(value)) return `${value} bar${value === 1 ? "" : "s"}`;
  return `${Number(value.toFixed(2))} bars`;
}

export function alignmentGrid(
  groups: readonly { length: number; tracks: number[] }[],
  w: number,
  /** The step at which *every* track aligns. Outlined, because it is the answer to the question. */
  everything?: number,
): string {
  if (groups.length === 0) return svg(w, 1, "No tracks to align", "");
  const padL = 92, padT = 34, gap = 3;
  const n = groups.length;
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
  const worst = Math.max(...groups.flatMap((a) => groups.map((b) => lcm(a.length, b.length))));
  let out = "";

  groups.forEach((col, j) => {
    const x = padL + j * (cellW + gap);
    out += `<text x="${x + cellW / 2}" y="${padT - 18}" text-anchor="middle"
      font-size="${T.label}" fill="var(--ink2)">${col.length} steps</text>`;
    out += `<text x="${x + cellW / 2}" y="${padT - 6}" text-anchor="middle"
      font-size="${T.value}" fill="var(--ink3)">${col.tracks.map((n2) => `T${n2}`).join(" ")}</text>`;
  });

  groups.forEach((row, i) => {
    const y = padT + i * (cellH + gap);
    out += `<text x="${padL - 8}" y="${y + cellH / 2 + 1}" text-anchor="end"
      font-size="${T.label}" fill="var(--ink2)">${row.length} steps</text>`;
    if (roomy) {
      out += `<text x="${padL - 8}" y="${y + cellH / 2 + 12}" text-anchor="end"
        font-size="${T.value}" fill="var(--ink3)">${row.tracks.map((n2) => `T${n2}`).join(" ")}</text>`;
    }

    groups.forEach((col, j) => {
      const x = padL + j * (cellW + gap);
      const steps = lcm(row.length, col.length);
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
        ${tip(self ? `${row.length} steps — on its own` : `${row.length} and ${col.length} steps`,
          self
            ? `T${row.tracks.join(", T")} comes round every ${steps} steps · ${bars(steps)}`
            : `back in phase every ${steps} steps · ${bars(steps)}`)}/>`;
      out += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + (roomy ? 1 : 3)}"
        text-anchor="middle" font-size="${T.value}" fill="${ink}">${steps}</text>`;
      if (roomy) {
        out += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 12}" text-anchor="middle"
          font-size="${T.tick}" fill="${inkDim}" opacity="${onLight ? ".8" : "1"}"
          >${bars(steps)}</text>`;
      }
    });
  });
  return svg(w, h, "When each pair of track lengths comes back into phase", out);
}

/* ---- legends and the table view ------------------------------------------------------- */

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
