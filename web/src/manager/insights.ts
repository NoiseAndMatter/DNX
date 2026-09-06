/**
 * Insights mode: the analysis charts, drawn for the pattern selected in the grid above them.
 *
 * ## Wiring, not analysis
 *
 * Every number here comes from `analysis/model.ts` and every mark from `analysis/charts.ts`. This
 * file composes cards, remembers what the controls are set to, and repaints. If something in it
 * starts computing a metric, that metric belongs one level down where it can be tested.
 *
 * ## Why the grid stays and the rest goes
 *
 * The charts want the page's full width and the reader wants to change pattern without leaving
 * them, so the mode keeps the bank tabs and the pattern grid — the selector — and hides the side
 * column, the track drill-down and the edit affordances. **Clicking between patterns to compare
 * them on the same chart is the gesture this layout exists for**, which is why the scroll position
 * survives a selection change: a view that jumped to the top on every click could not be used for
 * the one thing it is for.
 *
 * ## It is read-only, and that is structural
 *
 * The side column carries History, which is undo. Hiding it while leaving the grid able to accept
 * drops would let somebody rearrange a project with no visible way back, so the caller declines
 * drops in this mode. `GridDrag` asks rather than decides, which is what makes that possible.
 */

import {
  alignmentOf, barsOf, clock, cycleSteps, dormantTrigs, drawableWindow, fitKey, harmonic,
  machineLabel,
  masterPeriod, microBuckets,
  periodGroups, pitchByPreset, pitchWindows, playing, polymeterIsBounded, reachableSteps,
  overlappingNotes, repeatSteps, resetCuts, resetOptions, speedLabel, stepsToSeconds,
  trackWindows, voicesPerStep,
  type AnalysisSubject, type KeyFit,
} from "../analysis/model.js";
import {
  alignmentGrid, densityBars, keyTimeline, legend, machineVar, microDiverging, pcLegend,
  phaseStrip, pitchBars, rampBand, rampIsLight, rampLegend, realignBars, resetRuler, table,
  voiceArea,
  trackTimeline, type PhaseMode,
} from "../analysis/charts.js";
import {
  compareSubjects, summariseComparison, type ComparisonRow,
} from "../analysis/compare.js";
import { cycleBars } from "../analysis/charts.js";
import { attachTooltip, mount, repaint } from "../analysis/mount.js";
import { MACHINE_ORDER } from "../analysis/model.js";
import { escapeHtml } from "../dom.js";

/** What the controls are set to, kept across repaints so changing pattern does not reset them. */
interface Controls {
  phase: PhaseMode;
  key: "pitch" | "track";
  span: "beat" | "bar";
}

const controls: Controls = { phase: "velocity", key: "pitch", span: "beat" };

/**
 * The tooltip is attached once, on the first draw, and never taken down.
 *
 * **Once**, because `attachTooltip` binds to the document and every chart repaint would otherwise
 * add another set of listeners — a pattern clicked twenty times would show its tooltip through
 * twenty handlers writing the same element. **Lazily**, because attaching at module load would
 * make importing this file have an effect on a page that may never open Insights.
 *
 * Never taken down for the same reason it is delegated in the first place: leaving the mode does
 * not destroy the document, and re-entering must not need to remember anything.
 *
 * Found by opening the page and hovering. Every chart drew, every number was right, and nothing
 * had a tooltip — a green build cannot see a listener that was never bound.
 */
let tooltipAttached = false;

const card = (title: string, body: string) =>
  `<section class="panel"><h2>${escapeHtml(title)}</h2><div class="body">${body}</div></section>`;

/** A pattern the reader selected that could not be read, and the reason it gave. */
export interface InsightsRefusal {
  label: string;
  /**
   * Why, as a predicate — *"is a version 2 pattern record…"*, not *"A1 is a version 2…"*.
   *
   * The reader's own messages lead with the pattern's name, and the caller strips it. Two reasons:
   * the label is printed right beside it anyway, and **identical refusals cannot group while each
   * one names a different pattern**. Shift-selecting a bank of `PRESETS.dn2prj` printed the same
   * 190-character sentence sixteen times, and telling them apart meant reading all sixteen.
   */
  reason: string;
}

/**
 * What could not be read, said in the panel rather than dropped.
 *
 * A selection of eight that quietly analyses six is the same fault as a chart that filters silent
 * tracks without saying so — three separate readings went wrong that way before this surface
 * started naming its own omissions.
 */
function refusalNote(refusals: readonly InsightsRefusal[]): string {
  if (refusals.length === 0) return "";
  /*
   * **Grouped by reason, because a range selection refuses in bulk.** Every record in
   * `PRESETS.dn2prj` is version 2, so shift-selecting a bank printed the same 190-character
   * sentence sixteen times and the reader has to compare paragraphs to see they are identical.
   * There is one reason and sixteen patterns, and that is what it should say.
   */
  const byReason = new Map<string, string[]>();
  for (const r of refusals) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r.label]);
  return `<div class="inferred" style="margin-top:.7rem">
    <span class="h">${refusals.length} selected pattern${refusals.length === 1 ? "" : "s"} could
      not be read</span>
    ${[...byReason].map(([reason, labels]) =>
      `<p class="why"><b>${labels.map(escapeHtml).join(", ")}</b>${
        // One reads as the sentence the reader wrote; several read as one sentence about a set.
        labels.length > 1 ? " — each " : " "}${escapeHtml(reason)}</p>`).join("")}
  </div>`;
}

/**
 * Rows sharing an identical set of figures, so one sentence can speak for all of them.
 *
 * **Patterns in a bank are often near-copies of each other**, and three of them refused, cut or
 * phased in exactly the same way produce three identical sentences with only the name changed. The
 * reader then has to compare them word by word to discover they are the same, which is worse than
 * not printing them at all.
 */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): T[][] {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return [...out.values()];
}

/** `A1`, `A1 and A2`, `A1, A2 and A9` — an English list, not a comma-joined array. */
function listOf(labels: readonly string[]): string {
  const escaped = labels.map(escapeHtml);
  if (escaped.length < 3) return escaped.join(" and ");
  return `${escaped.slice(0, -1).join(", ")} and ${escaped.at(-1)}`;
}

/**
 * The overview drawn above the cards when more than one pattern is selected.
 *
 * ## Why a comparison and not eight full analyses
 *
 * Stacking the five cards once per selected pattern is the obvious build and it is not usable: the
 * page becomes a scroll of near-identical sections, and comparing anything means holding a number
 * in your head while you travel past four charts to find its neighbour. **A comparison has to put
 * the compared values next to each other or it is not one.** So this draws the structural figures
 * across all of them, and the full analysis stays where it was — on the pattern clicked last, which
 * is the one the caret in the chart points at.
 *
 * ## The bars are steps, and the clock times are not comparable
 *
 * Bar length is master steps, because that is the structure. Every pattern carries its own tempo,
 * so the time printed beside each bar is at *that* pattern's BPM — two equal bars can be different
 * durations. That is worth a sentence rather than a footnote, so when the tempos differ this says
 * so in the prose instead of hoping the reader checks the column.
 */
function comparisonCard(rows: readonly ComparisonRow[], refusals: readonly InsightsRefusal[]): string {
  const s = summariseComparison(rows);
  const tempoTile = s.tempos.length === 1
    ? `<span class="v">${s.tempos[0]!.toFixed(s.tempos[0]! % 1 ? 1 : 0)}</span>
       <span class="u">BPM</span><span class="note">all ${rows.length} agree</span>`
    : `<span class="v">${s.tempos.length}</span><span class="u">tempos</span>
       <span class="note">${s.tempos.map((t) => t.toFixed(t % 1 ? 1 : 0)).join(", ")} BPM</span>`;

  const bars = rows.map((row, i) => ({
    label: row.label,
    cycle: row.cycle,
    polymeter: row.polymeter,
    bounded: row.bounded,
    lostTrigs: row.lostTrigs,
    seconds: row.seconds,
    // The last selected is the one whose full analysis follows, and the caret is what ties the
    // two halves of the page together.
    ...(i === rows.length - 1 ? { focused: true } : {}),
  }));

  return card(`Comparing ${rows.length} patterns`, `
    <div class="tiles">
      <div class="tile"><span class="k">Selected</span>
        <span class="v">${rows.length}</span><span class="u">patterns</span>
        <span class="note">in the order you clicked them${s.silent.length
          ? ` · ${s.silent.length} sequence nothing` : ""}</span></div>
      <div class="tile"><span class="k">Tempo</span>${tempoTile}</div>
      <div class="tile"><span class="k">Shortest cycle</span>
        <span class="v">${s.shortest ? barsOf(s.shortest.cycle).replace(/ bars?$/, "") : "—"}</span>
        <span class="u">bars</span>
        <span class="note">${s.shortest ? escapeHtml(s.shortest.label) : "nothing plays"}</span></div>
      <div class="tile ${s.losing.length ? "flag" : ""}"><span class="k">Losing notes</span>
        <span class="v">${s.losing.length}</span><span class="u">of ${rows.length}</span>
        <span class="note">${s.losing.length
          ? `${s.losing.reduce((n, r) => n + r.lostTrigs, 0)} trigs never sound`
          : "no reset clips a figure"}</span></div>
    </div>

    ${rows.every((r) => r.silent) ? "" : `
    <figure style="margin-top:.9rem">
      <figcaption>How long each runs before it repeats, on <b>one linear scale</b>${
        /*
         * The sentence justifying the scale is only earned when the spread is wide enough to look
         * like a mistake. Printed against five patterns within a factor of two it reads as a
         * warning about something that is not happening — and a caption that describes a different
         * chart than the one under it is how a reader learns to stop reading them.
         */
        s.longest && s.shortest && s.longest.cycle >= s.shortest.cycle * 8
          ? ` — so a four-bar loop beside a hundred-bar one really does draw as a sliver` : ""}.
        ${s.longest && s.shortest && s.longest !== s.shortest
          ? `<b>${escapeHtml(s.longest.label)}</b> runs ${barsOf(s.longest.cycle)} against
             <b>${escapeHtml(s.shortest.label)}</b> at ${barsOf(s.shortest.cycle)}.`
          : ""}${
          /*
           * The caret is only promised when it is drawn. A silent pattern clicked last is filtered
           * off the chart, so the sentence pointed at a mark that was not there — read on the page,
           * with the caption naming a caret and the chart carrying none.
           */
          rows.at(-1)!.silent ? "" : " The caret marks the pattern analysed in full below."
        }</figcaption>
      <div class="chart" id="i-cycles"></div>
    </figure>
    ${legend([["Repeats cleanly", "--q4"], ["Analysed below", "--s3"],
              ["Loses notes to the reset", "--crit"]])}`}

    ${s.tempos.length > 1 ? `
      <p class="hint" style="margin-top:.6rem">These patterns <b>do not share a tempo</b>. The bars
        are master steps, so they compare structure honestly; the clock times beside them are each
        at that pattern's own BPM, and two bars of equal length are not equal durations.</p>` : ""}

    ${s.reset.length ? `
      <div class="inferred" style="margin-top:.9rem">
        <span class="h">${s.reset.length} of ${rows.length} never finish their polymeter</span>
        <p class="why">${groupBy(s.reset, (r) => `${r.polymeter}/${r.cycle}`).map((group) => {
          const many = group.length > 1;
          return `<b>${listOf(group.map((r) => r.label))}</b> would ${many ? "each " : ""}take
            ${barsOf(group[0]!.polymeter)} for ${many ? "their" : "its"} tracks to come round
            together and ${many ? "are" : "is"} restarted after ${barsOf(group[0]!.cycle)}`;
        }).join("; ")}. Everything past
          the reset is the same stretch again, so the phasing beyond it is never heard.</p>
        ${s.losing.length ? `<p class="why" style="margin-top:.35rem"><b>Of those,
          ${s.losing.length} lose notes</b>: ${
            groupBy(s.losing, (r) => `${r.lostTrigs}/${r.cutTracks}`).map((group) => {
              const [r] = group;
              return `${listOf(group.map((g) => g.label))} ${group.length > 1 ? "each drop" : "drops"}
                ${r!.lostTrigs} trig${r!.lostTrigs === 1 ? "" : "s"} across
                ${r!.cutTracks} track${r!.cutTracks === 1 ? "" : "s"}`;
            }).join(", ")}.${
            // Only when there IS a rest. With every reset pattern losing notes this printed "the
            // rest are cut on a boundary that costs nothing" about an empty set — read on the page,
            // where it says the opposite of what the sentence before it just established.
            s.reset.length > s.losing.length
              ? ` The other ${s.reset.length - s.losing.length} are cut on a boundary that costs
                 nothing.` : ""}</p>` : `<p class="why" style="margin-top:.35rem">None of
          them lose a note to it — every cut lands where nothing was going to play.</p>`}
      </div>` : ""}

    ${s.conditional.length ? `
      <p class="hint" style="margin-top:.6rem"><b>${s.conditional.length} of these
        ${s.conditional.length === 1 ? "carries" : "carry"} conditional trigs</b>
        (${s.conditional.reduce((n, r) => n + r.conditional, 0)} in all), so
        ${s.conditional.length === 1 ? "its cycle figure is" : "their cycle figures are"} a
        <b>floor</b>. A trig set to 2:3 plays on one pass in three; the codes are decoded but
        this page does not yet work out what they do to the cycle &mdash; and a percentage
        condition has no exact answer in any case.</p>` : ""}

    ${s.silent.length ? `
      <p class="hint" style="margin-top:.6rem">${s.silent.map((r) =>
        `<b>${escapeHtml(r.label)}</b>`).join(", ")} sequence${s.silent.length === 1 ? "s" : ""}
        nothing, so ${s.silent.length === 1 ? "it has" : "they have"} no cycle to draw and
        ${s.silent.length === 1 ? "is" : "are"} left off the chart rather than drawn as zero.</p>`
      : ""}

    ${refusalNote(refusals)}

    ${table(
      ["Pattern", "Tempo", "Tracks", "Window", "RESET", "Repeats every", "Polymeter", "Heard",
       "Cut", "Notes lost"],
      rows.map((r) => [
        r.label,
        r.tempo.toFixed(r.tempo % 1 ? 1 : 0),
        r.silent ? "—" : `${r.playing} of ${r.tracks}`,
        r.masterLength,
        r.resetSteps ?? "INF",
        r.silent ? "—" : `${r.cycle.toLocaleString()} (${barsOf(r.cycle)})`,
        r.silent ? "—" : r.bounded ? r.polymeter.toLocaleString() : "> 1M",
        r.silent || !r.bounded ? "—" : `${Math.round((r.cycle / r.polymeter) * 100)}%`,
        r.cutTracks || "—",
        r.lostTrigs || "—",
      ]))}
  `);
}

/**
 * Draw the analysis for the selected subjects into `host`.
 *
 * `host` must carry `.viz`; every rule in `viz.css` is scoped under it, because `charts.ts` emits
 * a `.legend` and so does the pattern grid.
 *
 * ## One subject or several
 *
 * **The last subject is the one analysed in full**, because in this mode clicking a slot is how you
 * change what you are looking at, and the most recent click is the answer to "what am I looking
 * at". Selecting more adds a comparison above the cards; it does not replace them, and with one
 * subject the page is exactly what it always was.
 *
 * `refusals` are patterns the reader selected that could not be read — a Digitone 1 pattern, or a
 * storage version this project refuses. They are **named in the panel** rather than dropped: a
 * selection of eight that silently analyses six is the same fault as a chart that filters tracks
 * without saying so.
 */
export function renderInsights(
  host: HTMLElement,
  subjects: readonly AnalysisSubject[],
  refusals: readonly InsightsRefusal[] = [],
): void {
  /*
   * **Scroll position is restored, not merely left alone.**
   *
   * Replacing the content shortens the document for an instant, and a browser clamps the scroll
   * offset to whatever the document can currently support — so a repaint at the bottom of a long
   * page lands you somewhere else even though nothing asked it to.
   */
  const scroll = window.scrollY;

  const tipEl = document.getElementById("tip");
  if (tipEl && !tooltipAttached) {
    attachTooltip(tipEl);
    tooltipAttached = true;
  }

  const subject = subjects.at(-1);
  if (subject === undefined) {
    /*
     * **"Select a pattern above" is wrong when patterns were selected and all of them were
     * refused.** The reader did exactly what it asks; telling them to do it again reads as the page
     * not having noticed. The refusals are the answer in that case, on their own.
     */
    host.innerHTML = refusals.length
      ? card("Nothing here can be read", refusalNote(refusals))
      : card("Insights", `<p class="hint">Select a pattern above to analyse it.</p>`);
    return;
  }

  /*
   * Built before anything else so it survives every early return below. A silent pattern clicked
   * last must not take the comparison down with it — the comparison is about the other seven too,
   * and losing it on a click would make the mode feel broken rather than empty.
   */
  const rows = subjects.length > 1 ? compareSubjects(subjects) : [];
  const overview = rows.length
    ? comparisonCard(rows, refusals)
    : refusals.length ? card("Not read", refusalNote(refusals)) : "";
  /*
   * **Tagged focused first, filtered second.** A pattern with nothing sequenced has no cycle —
   * `cycleSteps` returns 1 for it, the identity — so a bar for it would be a 2px stub reading
   * "0.06 bars": a measurement of nothing that looks like one. Those are named in the card's prose
   * instead. Tagging before filtering keeps the caret on the last *selected* pattern rather than on
   * the last one that happens to play.
   */
  const cycleRows = rows
    .map((row, i) => ({
      label: row.label, cycle: row.cycle, polymeter: row.polymeter, bounded: row.bounded,
      lostTrigs: row.lostTrigs, seconds: row.seconds, silent: row.silent,
      ...(i === rows.length - 1 ? { focused: true } : {}),
    }))
    .filter((row) => !row.silent);
  const drawOverview = () => {
    if (cycleRows.length) {
      mount(document.getElementById("i-cycles")!, (w) => cycleBars(cycleRows, w));
    }
  };

  const live = playing(subject);
  if (live.length === 0) {
    host.innerHTML = overview + card("Insights", `<p class="hint">
      <strong>${escapeHtml(subject.label)}</strong> has no trigs on any track, so there is nothing
      to measure. Select a pattern that plays something.</p>`);
    drawOverview();
    window.scrollTo({ top: scroll });
    return;
  }

  /*
   * **Two different numbers, and the one a musician hears is `repeat`.**
   *
   * `polymeter` is the least common multiple of the track lengths — when the tracks would come
   * round if nothing interrupted them. `repeat` is that bounded by the sequencer's PATTERN RESET,
   * which pulls every track back to step one whether or not it has finished. Reporting the first
   * as "true cycle" was arithmetically right and musically false: a pattern this page announced as
   * 1,984 steps and 12:24 long is restarted by the device every 128 steps, which is 48 seconds.
   */
  const polymeter = cycleSteps(live);
  const cycle = repeatSteps(live, subject.resetSteps);
  const cut = polymeter > cycle;
  const cycleSec = stepsToSeconds(cycle, subject.tempo);
  const pitch = pitchByPreset(live);
  const micro = microBuckets(live);
  const allTrigs = live.reduce((a, t) => a + t.trigs.length, 0);
  const accents = live.reduce(
    (a, t) => a + t.trigs.filter((g) => g.velocity > subject.defaultVelocity).length, 0);
  const locks = live.reduce(
    (a, t) => a + t.trigs.filter((g) => g.lockPreset !== undefined).length, 0);

  const tonal = harmonic(live);
  /*
   * **Windowed over what can be drawn, not over what the arithmetic returned.** A pattern whose
   * tracks never come round has a saturated cycle, and asking for a window per bar of a million
   * steps is 62,500 windows — eight minutes of work, or a frozen tab. `PRESETS` `FUCHSIA` is one:
   * tracks of 128, 124, 74, 88 and a 103 at half speed, with RESET at INF.
   */
  const drawn = drawableWindow(cycle);
  const keyWindows = tonal.length ? pitchWindows(tonal, drawn.steps, 16, 16) : [];
  const whole = keyWindows.length
    ? fitKey(keyWindows.reduce((acc, v) => acc.map((x, i) => x + v.counts[i]!), new Array(12).fill(0)))
    : undefined;
  const changes = keyWindows.filter((v, i) => i && v.fit.name !== keyWindows[i - 1]!.fit.name).length;

  const masterFit = tonal.length
    ? fitKey(pitchWindows(tonal, subject.masterLength, subject.masterLength, subject.masterLength)[0]!.counts)
    : undefined;
  const rowsBeat = tonal.length ? trackWindows(tonal, subject.masterLength, 4, 4, () => masterFit) : [];
  const rowsBar = tonal.length
    ? trackWindows(tonal, drawn.steps, 16, 16, (i): KeyFit | undefined => keyWindows[i]?.fit)
    : [];

  const bars = cycle / 16;
  const lengths = new Set(live.map((track) => track.length));
  /*
   * **The phase strip draws the master length, except when the master is shorter than a track.**
   *
   * `017 PRESETS.dn2prj` declares a master length of **1** on every pattern while its tracks run
   * 14 to 64 steps, so the strip drew a one-step window: four dots stacked on a single pixel
   * column, a chart of nothing. Widening it to the longest track means every track shows at least
   * one complete pass, which is the thing the chart is for. A track length is 1..128 by spec, so
   * this cannot run away.
   */
  const longest = Math.max(...live.map((track) => track.length));
  /*
   * **One loop of what actually plays.** With a reset, that is the reset — everything past it is a
   * repeat of what came before, so drawing more draws the same thing twice. Without one, the
   * longest track is the least that shows every track completing a pass; the master length wins
   * when it is longer still.
   */
  const windowSteps = subject.resetSteps ?? Math.max(subject.masterLength, longest);
  const cuts = resetCuts(live, subject.resetSteps);
  const groups = periodGroups(live);
  const options = resetOptions(live);
  /*
   * The shortest reset that leaves every track whole. It is always the last option — the list is
   * ascending and Pareto-optimal, so the most complete answer is the longest one offered.
   */
  const completes = options.at(-1);
  const alreadyWhole = subject.resetSteps === undefined || cuts.length === 0;
  /*
   * Sixteen coprime track lengths have a least common multiple past what a double holds exactly, so
   * the count saturates. Printing the saturation point as though it were the answer would be
   * inventing a number, and every windowing loop downstream takes it as a bound.
   */
  const bounded = polymeterIsBounded(live);
  // Conditional trigs make the figure above a floor rather than the answer. See `AnalysisTrig`.
  const conditional = live.reduce((n, t2) => n + t2.trigs.filter((g) => g.conditional).length, 0);
  /*
   * **A worked example, taken from this pattern rather than written.** A grid of numbers with a
   * key is still a grid of numbers until somebody has read one cell out loud; naming the soonest
   * pair and the latest one turns the whole thing from a table into a sentence.
   */
  const pairs = groups.flatMap((a2, i) =>
    groups.slice(i + 1).map((b2) => ({ a: a2, b: b2, steps: alignmentOf(a2.period, b2.period) })));
  const soonest = pairs.length ? pairs.reduce((m, p) => (p.steps < m.steps ? p : m)) : undefined;
  const latest = pairs.length ? pairs.reduce((m, p) => (p.steps > m.steps ? p : m)) : undefined;
  const rampTop = pairs.length ? Math.max(...pairs.map((p) => p.steps)) : 1;
  const chip = (steps: number) => {
    const band = rampBand(steps, rampTop);
    return `<span style="display:inline-block;width:.62rem;height:.62rem;border-radius:2px;` +
      `background:var(--q${band + 1});vertical-align:baseline;margin-right:.25rem"></span>`;
  };
  void rampIsLight;
  const reach = reachableSteps(live, subject.resetSteps);
  const unreachable = reach.total - reach.reachable;
  const machinesUsed = MACHINE_ORDER.filter((m) => live.some((t) => t.machine === m));
  /*
   * **Drawn since 2026-09-06**, when the note-length byte was captured. Everything here reads a
   * gate; all of it was written long before and deliberately left undrawn, because a plausible
   * mapping would have produced a voice chart indistinguishable from a measured one.
   */
  const voices = voicesPerStep(live, windowSteps);
  const peak = Math.max(...voices, 0);
  const over = voices.filter((v) => v > subject.voiceBudget).length;
  const overlaps = live.reduce((n, t) => n + overlappingNotes(t).length, 0);
  const longestGate = Math.max(...live.flatMap((t) => t.trigs.map((g) => g.length)), 0);

  /*
   * **Read from every track, not from `live`.** A track whose only trigs are past its end has none
   * that play, so `playing` drops it — and that is the case most worth reporting, because on the
   * instrument the track looks empty and the notes are still in the file.
   */
  const dormant = dormantTrigs(subject.tracks);
  const dormantTotal = dormant.reduce((n, d) => n + d.steps.length, 0);

  host.innerHTML = overview +
    (dormant.length ? card("Trigs the sequencer never reaches", `
      <p class="why"><b>${dormantTotal} note${dormantTotal === 1 ? "" : "s"} on
        ${dormant.length} track${dormant.length === 1 ? "" : "s"}</b> sit past the end of the track
        holding them, so ${dormantTotal === 1 ? "it does" : "they do"} not play. Shortening a track
        keeps whatever was written on the pages it drops; raise its LEN again and
        ${dormantTotal === 1 ? "it comes" : "they come"} back.</p>
      <p class="why" style="margin-top:.35rem">${dormant.map((d) =>
        `<b>T${d.track.number}</b> is ${d.track.length} steps and holds
         ${d.steps.length} on step${d.steps.length === 1 ? "" : "s"}
         ${listOf(d.steps.slice(0, 8).map(String))}${d.steps.length > 8 ? " and more" : ""} —
         <b>LEN ${d.reachAt}</b> reaches ${d.steps.length === 1 ? "it" : "the last of them"}` +
        (d.track.trigs.length ? "" : ", and nothing on it plays today")).join(". ")}.</p>
      <p class="why" style="margin-top:.35rem">Everything else on this page counts only the trigs
        that sound. The instrument cannot show you this: LEN lives on one screen and the trig pages
        on another, and a page past the last one looks unlit whether it is empty or out of
        reach.</p>`) : "") +
    card(`Play time and cycle — ${subject.label}`, `
      <div class="tiles">
        <div class="tile"><span class="k">Tempo</span>
          <span class="v">${subject.tempo.toFixed(subject.tempo % 1 ? 1 : 0)}</span>
          <span class="u">BPM</span></div>
        <div class="tile"><span class="k">${subject.perTrackLengths
            ? "Longest track" : "Master length"}</span>
          <span class="v">${subject.masterLength}</span><span class="u">steps</span>
          <span class="note">${clock(stepsToSeconds(subject.masterLength, subject.tempo))} ·
            ${barsOf(subject.masterLength)}${subject.perTrackLengths
              ? " · no master length in PER TRACK" : ""}</span></div>
        <div class="tile ${cut ? "flag" : ""}"><span class="k">Repeats every</span>
          <span class="v">${cycle.toLocaleString()}</span><span class="u">steps</span>
          <span class="note">${clock(cycleSec)} · ${bars} bar${bars === 1 ? "" : "s"}${cut
            ? ` · RESET cuts a ${polymeter.toLocaleString()}-step polymeter` : ""}</span></div>
        <div class="tile"><span class="k">Tracks in play</span><span class="v">${live.length}</span>
          <span class="u">of ${subject.tracks.length}</span>
          <span class="note">${lengths.size} distinct
            length${lengths.size === 1 ? "" : "s"}</span></div>
      </div>

      <div class="ctrl" style="margin-top:.9rem">
        <label for="i-mode">Dots show</label>
        <select id="i-mode">
          <option value="velocity">Velocity — accents ringed</option>
          <option value="length">Note length — how long each gate holds</option>
          <option value="overlap">Overlapping notes</option>
          <option value="locks">Preset locks</option>
        </select>
      </div>
      <figure>
        <figcaption>Each tick is a track restarting and each dot is a trig, so the polymeter is
          read against the actual rhythm. <b>${accents} of ${allTrigs} trigs are above the default
          velocity of ${subject.defaultVelocity}</b> and are drawn brighter and ringed.${
            windowSteps === subject.masterLength ? "" : ` Drawn over <b>${windowSteps} steps</b>
            rather than the ${subject.perTrackLengths ? "longest track pass" : "master length"} of
            ${subject.masterLength}, so every track completes at least one pass.`}</figcaption>
        <div class="chart" id="i-phase"></div>
      </figure>
      ${legend(machinesUsed.map((m) => [machineLabel(m), machineVar(m)] as [string, string]))}

      ${cut ? `
        <div class="inferred" style="margin-top:1rem">
          <span class="h">The polymeter never finishes — PATTERN RESET restarts it</span>
          <p class="why">These track lengths would take
            <b>${polymeter.toLocaleString()} steps</b> to come round together, but this pattern sets
            <b>RESET to ${subject.resetSteps}</b> — and the manual is explicit that RESET is
            <em>the number of steps the pattern plays before all tracks reset and restart from the
            first step</em>. So it repeats every <b>${cycle} steps</b>, and the tracks below never
            reach the repeat counts the arithmetic alone would give them.</p>

        </div>` : ""}
      ${lengths.size === 1 ? `
        <p class="hint" style="margin-top:1rem">Every playing track is
          <b>${[...lengths][0]} steps</b> long, so they all wrap together and the pattern realigns
          every <b>${cycle} steps, ${clock(cycleSec)}</b>. There is no polymeter to chart — which
          is the common case: per-track lengths were switched on in 13 of the 64 corpus patterns
          measured.</p>` : `
        <figure style="margin-top:1rem">
          <figcaption>${cut
            ? `How far each track gets before <b>RESET at ${subject.resetSteps} steps</b> pulls them
               all back. The counts are against the ${polymeter.toLocaleString()}-step polymeter, so
               a track showing more repeats than the pattern can reach is one the reset interrupts.`
            : `Nothing realigns until every track has wrapped together —
               <b>${cycle.toLocaleString()} steps, ${clock(cycleSec)}</b>. This pattern sets no
               RESET, so the polymeter runs to the end.`}</figcaption>
          <div class="chart" id="i-realign"></div>
        </figure>`}
      ${table(["Track", "Preset", "Length", "Speed", "Machine", "Trigs", "Repeats per cycle"],
        live.map((t) => [`T${t.number}`, t.preset, t.length,
          t.speed === undefined ? "unknown" : `${t.speed}x`,
          machineLabel(t.machine), t.trigs.length, polymeter / t.length]))}
    `) +

    card("Polymeter and the reset", `
      <div class="tiles">
        <div class="tile"><span class="k">Pattern reset</span>
          <span class="v">${subject.resetSteps ?? "INF"}</span>
          <span class="u">${subject.resetSteps === undefined ? "" : "steps"}</span>
          <span class="note">${subject.resetSteps === undefined
            ? "tracks are never pulled back to step one"
            : `every track restarts here · ${barsOf(subject.resetSteps)}`}</span></div>
        <div class="tile"><span class="k">Hands over after</span>
          <span class="v">${subject.changeSteps ?? "—"}</span>
          <span class="u">${subject.changeSteps === undefined ? "" : "steps"}</span>
          <span class="note">${subject.changeSteps === undefined
            ? "CHANGE is off; a cued pattern arrives at the end of the pattern"
            : `a cued pattern takes over here`}</span></div>
        <div class="tile"><span class="k">Polymeter</span>
          <span class="v">${bounded ? reach.total.toLocaleString() : "&gt; 1M"}</span>
          <span class="u">steps</span>
          <span class="note">${bounded
            ? "the track lengths alone, ignoring the reset"
            : "these lengths do not come round inside a million steps — counting stops there"}</span></div>
        <div class="tile ${unreachable ? "flag" : ""}"><span class="k">Reachable</span>
          <span class="v">${Math.round((reach.reachable / reach.total) * 100)}</span>
          <span class="u">%</span>
          <span class="note">${unreachable
            ? `${unreachable.toLocaleString()} steps never play`
            : "the whole polymeter is heard"}</span></div>
      </div>

      ${subject.resetSteps === undefined ? `
        <div class="inferred" style="margin-top:.9rem">
          <span class="h">No reset — the polymeter runs to the end</span>
          <p class="why">Nothing pulls the tracks back, so this pattern really does take
            <b>${reach.total.toLocaleString()} steps</b> to come round.${
              subject.changeSteps === undefined ? `
            <b> And CHANGE is off.</b> Elektron's manual is explicit about that combination: with no
            CHANGE setting and RESET at INF, <em>the pattern plays infinitely and the next cued
            pattern will never play</em>. If you chain or sequence this pattern, that is the setting
            to look at.` : `
            With CHANGE at <b>${subject.changeSteps} steps</b>, a cued pattern takes over long
            before then — in a chain you hear the first
            <b>${subject.changeSteps} steps</b> of ${reach.total.toLocaleString()} and no more.`}</p>
        </div>` : `
        <figure style="margin-top:.9rem">
          <figcaption>Each track's passes before the reset.
            ${cuts.length
              ? `<b>${cuts.filter((c) => c.lost).length} of ${live.length} tracks lose notes</b> to
                 the reset${cuts.some((c) => !c.lost)
                   ? `, and ${cuts.filter((c) => !c.lost).length} ${
                       cuts.filter((c) => !c.lost).length === 1 ? "is cut" : "are cut"} without
                     losing any — those are outlined rather than filled` : ""}. The dots are trigs:
                 a stub with dots in it is a part being clipped, an empty one is only untidy
                 arithmetic.`
              : `Every track's period divides ${subject.resetSteps}, so each finishes its last pass
                 exactly as the reset lands. Nothing is interrupted.`}
            ${live.length === subject.tracks.length ? "" : `<b>${live.length} of
              ${subject.tracks.length} tracks are drawn</b> — the other
              ${subject.tracks.length - live.length} carry a preset but nothing sequenced, and a
              track with no notes cannot be heard realigning or be cut.`}</figcaption>
          <div class="chart" id="i-ruler"></div>
        </figure>
        ${legend([["Complete pass", "--q4"], ["Cut, and notes lost", "--crit"]])}
        <p class="hint" style="margin:.35rem 0 0;font-size:.72rem">A <b>dashed outline</b> is a cut
          that loses nothing — every trig on that track is before it. The dots are the trigs
          themselves.</p>`}

      ${cuts.length ? `
        <div class="inferred">
          <span class="h">What the reset interrupts</span>
          <p class="why">${cuts.map((c) =>
            `<b>T${c.track.number}</b> is ${c.track.length} steps: ${c.passes} complete
             pass${c.passes === 1 ? "" : "es"}, then <b>${c.cutAfter} of ${c.track.length}
             steps</b> before it is pulled back` +
            (c.lost
              ? ` — <b>${c.lost} trig${c.lost === 1 ? "" : "s"} never sound</b>`
              : `, and <b>nothing is lost</b>: every trig on it is before the cut`)).join(". ")}.</p>
          <p class="why" style="margin-top:.35rem">Not necessarily wrong — a clipped figure is a
            legitimate thing to want. It is listed because the instrument shows track lengths and
            the reset on different rows and never their remainder, so an unintended one is easy to
            live with for months.</p>
        </div>` : ""}
      ${groups.length < 2 ? "" : `
        <figure style="margin-top:1.1rem">
          <figcaption>When each pair of track periods starts together again.
            ${soonest && latest ? `Read one cell and the rest follow:
              <b>${soonest.a.period} and ${soonest.b.period} master steps</b> come back into phase every
              <b>${barsOf(soonest.steps)}</b>, while
              <b>${latest.a.period} and ${latest.b.period}</b> take <b>${barsOf(latest.steps)}</b>.`
              : ""}
            The diagonal is a period on its own. Keyed on periods rather than tracks, because two
            tracks that share a period are always in phase.
            ${live.length === subject.tracks.length ? "" : ` Only the ${live.length} tracks with
              notes on them are counted; the other ${subject.tracks.length - live.length} are
              silent and cannot phase against anything.`}</figcaption>
          <div class="chart" id="i-align"></div>
        </figure>
        ${rampLegend(soonest?.steps ?? 0, latest?.steps ?? 0)}

        <div class="inferred" style="margin-top:.7rem">
          <span class="h">When everything lines up</span>
          <p class="why"><b>All ${live.length} tracks align after
            ${reach.total.toLocaleString()} steps — ${barsOf(reach.total)}</b>
            (${clock(stepsToSeconds(reach.total, subject.tempo))} at ${subject.tempo} BPM)${
            subject.resetSteps === undefined
              ? `, and with RESET at INF the pattern is allowed to get there.`
              : reach.reachable < reach.total
                ? `. <b>It never gets there</b>: RESET restarts every track after
                   ${subject.resetSteps} steps — ${barsOf(subject.resetSteps)} — so the pattern
                   repeats long before the tracks come round together. That cell is outlined in the
                   grid above.`
                : `, which is on or before the reset, so it does happen.`}</p>
          ${conditional === 0 ? "" : `<p class="why" style="margin-top:.35rem">
            <b>${conditional} of ${allTrigs} trigs carry a trig condition</b>, so the pattern does
            not sound the same on every pass and the figure above is a <b>floor</b>, not the answer.
            A trig set to 2:3 plays on one pass in three, which multiplies the musical cycle by
            three. <b>The codes are decoded</b> — <code>+0x100</code> was solved on hardware and
            <code>+0x180</code> is the FILL family — but this page does not yet work out what a
            mixture of them does to the cycle, and a <b>percentage</b> condition has no exact
            answer at all. So the figure above is a floor, and saying which conditions are present
            is as far as this goes today.</p>`}
          ${latest === undefined ? "" : latest.steps === reach.total ? `
            <p class="why" style="margin-top:.35rem">The pairing that decides it is
              <b>${latest.a.period} against ${latest.b.period}</b> — every other pair comes round
              sooner, and that cell is the outlined one above.</p>` : `
            <p class="why" style="margin-top:.35rem"><b>No pair reaches that on its own</b> — the
              longest is ${latest.a.period} against ${latest.b.period} at
              ${barsOf(latest.steps)}, well short of ${barsOf(reach.total)}. It takes all
              ${groups.length} lengths together, which is why no cell in the grid is marked: the
              answer is not in any one of them.</p>`}
        </div>

        <div class="inferred">
          <span class="h">Setting a reset that lets the polyrhythm finish</span>
          <p class="why">${alreadyWhole
            ? `Nothing is being cut here. ${subject.resetSteps === undefined
                ? "With RESET at INF the tracks run until they realign on their own, after"
                : `RESET at ${subject.resetSteps} divides every track length, so each finishes its
                   last pass exactly as everything restarts. The tracks fully realign after`}
               <b>${reach.total.toLocaleString()} steps</b>.`
            : `<b>${completes && !completes.beyondField
                ? `Set RESET to ${completes.steps} — ${barsOf(completes.steps)} — or to INF.`
                : `Only INF completes it:`}</b>
               every track finishes a whole number of passes after
               <b>${reach.total.toLocaleString()} steps</b>${completes?.beyondField
                 ? `, which is past the 1,024 the field holds`
                 : ""}. At the current <b>${subject.resetSteps}</b>,
               ${cuts.length} of ${live.length} tracks ${cuts.length === 1 ? "is" : "are"} cut.`}</p>
          ${options.length < 2 ? "" : `
            <p class="why" style="margin-top:.45rem">The values in between, and what each leaves
              whole:</p>
            <p class="why" style="margin-top:.2rem">${options.map((o) => {
              const here = o.steps === subject.resetSteps;
              const whole = o.complete.length === live.length;
              // Same swatch as the grid, so a value read in one place is recognised in the other.
              return `${chip(o.steps)}<b style="color:var(${whole ? "--s3" : "--ink2"})"
                >${o.steps}</b>` +
                `<span style="color:var(--ink3)"> (${barsOf(o.steps)})</span> ` +
                `${o.complete.length}/${live.length} whole` +
                (o.beyondField ? ` <span style="color:var(--ink3)">· INF only</span>` : "") +
                (here ? ` <span style="color:var(--crit)">· current</span>` : "");
            }).join(" &nbsp;·&nbsp; ")}</p>`}
          <p class="why" style="margin-top:.45rem"><b>A longer reset is not automatically better.</b>
            Letting a polymeter run its full length is one musical choice and cutting it on a bar
            line is another — this says what each costs, not which to pick.</p>
        </div>`}
      ${table(["Track", "Length", "Speed", "Period", "Passes before reset", "Cut after", "Notes lost"],
        live.map((t) => {
          const hit = cuts.find((c) => c.track === t);
          const period = masterPeriod(t);
          return [`T${t.number}`, t.length, speedLabel(t.speed ?? 1), period,
            // Divides by the period, not the length: the reset counts master steps. This column
            // was still using the raw length after the rest of the file moved to the master clock.
            subject.resetSteps === undefined ? "—" : Math.floor(subject.resetSteps / period),
            hit ? `${hit.cutAfter} of ${period}` : "—",
            hit ? (hit.lost || "none") : "—"];
        }))}
    `) +

    card("What is on each track", `
      <div class="tiles">
        <div class="tile"><span class="k">Note trigs</span><span class="v">${allTrigs}</span>
          <span class="note">the grid counts records, which include trigless lock trigs</span></div>
        <div class="tile"><span class="k">Accented</span><span class="v">${accents}</span>
          <span class="u">trigs</span>
          <span class="note">above velocity ${subject.defaultVelocity}</span></div>
        <div class="tile"><span class="k">Preset locks</span><span class="v">${locks}</span></div>
        <div class="tile"><span class="k">Microtimed</span>
          <span class="v">${allTrigs - micro.onGrid}</span><span class="u">trigs</span></div>
      </div>
      <figure style="margin-top:.9rem">
        <figcaption>Tracks are identified by <b>lane and label</b>, never by colour — sixteen is
          twice what a categorical palette can carry.</figcaption>
        <div class="chart" id="i-density"></div>
      </figure>
      ${legend([["Note trigs", "--s3"], ["Microtimed or accented", "--s4"],
                ["Preset locks", "--s7"]])}
      ${micro.buckets.length ? `
        <figure style="margin-top:1rem">
          <figcaption>Microtiming, for the <b>${allTrigs - micro.onGrid} trigs off the grid</b> —
            the other ${micro.onGrid} sit on it and are left out of the plot rather than flattening
            it.</figcaption>
          <div class="chart" id="i-micro"></div>
        </figure>` : `
        <p class="hint" style="margin-top:.8rem">Every trig in this pattern sits on the grid, so
          there is no microtiming to plot.</p>`}
    `) +

    card("Pitch content", `
      <figure>
        <figcaption>Every note in the pattern by pitch class, stacked by the machine that plays it.
          <b>Hover a column to see which presets sound that note.</b> This is a fact.</figcaption>
        <div class="chart" id="i-pitch"></div>
      </figure>
      ${legend(machinesUsed.map((m) => [machineLabel(m), machineVar(m)] as [string, string]))}
      ${tonal.length === 0 ? `
        <p class="hint" style="margin-top:.9rem">No track in this pattern plays more than one pitch
          class, so there is no harmony to fit a key to. That is the measurement, not a failure —
          a pattern of one-note drum parts genuinely has no key.</p>` : `
        <div class="ctrl" style="margin-top:1.1rem">
          <label for="i-keymode">Timeline</label>
          <select id="i-keymode">
            <option value="pitch">By pitch class &mdash; what is sounding</option>
            <option value="track">By track &mdash; who is playing it</option>
          </select>
          <span id="i-spanctrl" hidden>
            <label for="i-keyspan" style="margin-left:.4rem">Span</label>
            <select id="i-keyspan">
              <option value="beat">${barsOf(subject.masterLength)} — a column per beat</option>
              <option value="bar">Full cycle — a column per bar</option>
            </select>
          </span>
        </div>
        <figure>
          <figcaption id="i-keycap"></figcaption>
          <div class="chart" id="i-keytime"></div>
        </figure>
        <div id="i-keylegend"></div>
        <div class="inferred">
          <span class="h">Best fit over the whole cycle. An inference.</span>
          <p class="fit">${escapeHtml(whole!.name)}
            <span style="color:var(--ink2);font-size:.8rem">margin
            ${whole!.margin.toFixed(2)} over ${escapeHtml(whole!.runnerUp)}</span></p>
          <p class="why">Krumhansl–Schmuckler correlation against the standard profiles.
            <b>Read the margin, not the score.</b> A relative minor shares six of seven notes with
            its major, so most patterns score high on two keys at once and the margin is what
            separates them. The device stores no key. ${tonal.length} of ${live.length} playing
            tracks fed this fit; the rest sound one pitch class each and would swamp it. The
            <b>arpeggiator</b> transposes, and nothing decodes its settings, so a track using one is
            read short here.</p>
        </div>`}
      ${table(["Pitch class", "Notes", "Presets"], pitch.filter((c) => c.total).map((c) =>
        [c.name, c.total, Object.entries(c.byPreset).sort((a, b) => b[1] - a[1])
          .map(([p, n]) => `${p} x${n}`).join(", ")]))}
    `) +

    card("Voice pressure", `
      <div class="tiles">
        <div class="tile ${peak > subject.voiceBudget ? "flag" : ""}">
          <span class="k">Peak voices</span><span class="v">${peak}</span>
          <span class="u">of ${subject.voiceBudget}</span>
          <span class="note">${over
            ? `over budget on ${over} step${over === 1 ? "" : "s"}`
            : "never over budget"}</span></div>
        <div class="tile"><span class="k">Overlapping notes</span>
          <span class="v">${overlaps}</span><span class="u">pairs</span>
          <span class="note">two notes sounding at once on one track</span></div>
        <div class="tile"><span class="k">Longest gate</span>
          <span class="v">${longestGate === Infinity ? "INF" : longestGate}</span>
          <span class="u">${longestGate === Infinity ? "" : "steps"}</span>
          <span class="note">${longestGate === Infinity
            ? "a gate that never closes"
            : "the note that holds longest"}</span></div>
      </div>
      <figure style="margin-top:.9rem">
        <figcaption>Voices held at each step against the
          <b>${subject.voiceBudget}</b> this device has.${over
            ? ` <b>The budget is passed on ${over} of ${windowSteps} steps</b> — past it the
               sequencer steals a voice, and the note you lose is not the one you would choose.`
            : " Nothing here asks for more than the device can give."}
          A chord spends one voice per note.</figcaption>
        <div class="chart" id="i-voices"></div>
      </figure>
      ${overlaps === 0 ? "" : `
        <div class="inferred" style="margin-top:.8rem">
          <span class="h">Overlaps are the geometric half of a glide, and only that half</span>
          <p class="why"><b>${overlaps} pair${overlaps === 1 ? "" : "s"}</b> of notes overlap on one
            track. A glide is an overlap on a <em>monophonic</em> track with <em>portamento</em> on
            — and while per-trig <code>PORT</code> is readable, the track's mono/poly setting and
            its portamento default live on the preset's SETUP page, which no capture has covered.
            So this says the notes overlap and stops there. Set <b>Dots show</b> to
            <b>Overlapping notes</b> to see which.</p>
        </div>`}
      ${table(["Track", "Preset", "Trigs", "Longest gate", "Overlapping pairs"],
        live.map((t) => {
          const longest = Math.max(...t.trigs.map((g) => g.length), 0);
          return [`T${t.number}`, t.preset, t.trigs.length,
            longest === Infinity ? "INF" : Number(longest.toFixed(3)),
            overlappingNotes(t).length || "—"];
        }))}
    `)

  drawOverview();
  mount(document.getElementById("i-voices")!, (w) =>
    voiceArea(voices, subject.voiceBudget, w));
  mount(document.getElementById("i-phase")!, (w) =>
    phaseStrip(live, windowSteps, controls.phase, subject.defaultVelocity, w));
  if (subject.resetSteps !== undefined) {
    mount(document.getElementById("i-ruler")!, (w) =>
      resetRuler(live, subject.resetSteps!, w));
  }
  if (groups.length >= 2) {
    mount(document.getElementById("i-align")!, (w) =>
      alignmentGrid(groups, w, reach.total));
  }
  if (lengths.size > 1) {
    mount(document.getElementById("i-realign")!, (w) => realignBars(live, polymeter, w));
  }
  mount(document.getElementById("i-density")!, (w) =>
    densityBars(live, subject.defaultVelocity, w));
  if (micro.buckets.length) {
    mount(document.getElementById("i-micro")!, (w) => microDiverging(micro.buckets, w));
  }
  mount(document.getElementById("i-pitch")!, (w) => pitchBars(pitch, w));

  const modeEl = document.getElementById("i-mode") as HTMLSelectElement;
  modeEl.value = controls.phase;
  modeEl.addEventListener("change", () => {
    controls.phase = modeEl.value as PhaseMode;
    repaint(document.getElementById("i-phase")!, (w) =>
      phaseStrip(live, windowSteps, controls.phase, subject.defaultVelocity, w));
  });

  if (tonal.length) {
    const keyEl = document.getElementById("i-keymode") as HTMLSelectElement;
    const spanEl = document.getElementById("i-keyspan") as HTMLSelectElement;
    keyEl.value = controls.key;
    spanEl.value = controls.span;

    const drawKey = (w: number) => controls.key === "track"
      ? trackTimeline(controls.span === "beat" ? rowsBeat : rowsBar,
                      controls.span === "beat" ? 4 : 16, w)
      : keyTimeline(keyWindows, w);

    const caption = () => controls.key === "track"
      ? (controls.span === "beat"
        ? `Every note each track has sounding, stacked low to high. Spacing is even rather than
           tonal — a triad is three lines whatever the voicing. <b>Hover a stack for a possible
           chord name.</b>`
        : `The same stacks across the whole ${bars}-bar cycle, a column per bar, with the chord read
           against the key fitted around it. Good for finding <b>where a track changes</b>.`)
      : `${drawn.capped
          ? `<b>The first ${barsOf(drawn.steps)} of a pattern that never comes round.</b> These
             track lengths do not share a common multiple inside a million steps, so there is no
             whole cycle to draw — this is the opening of it. ` : ""}A key belongs to a
         <b>moment</b>, not to a pattern${cycle > subject.masterLength
          ? `. With per-track lengths the tracks phase against one another, so what sounds together
             changes bar by bar with nothing edited` : ""} — across
         ${bars} bar${bars === 1 ? "" : "s"} the fit moves <b>${changes}
         time${changes === 1 ? "" : "s"}</b>. Above, the pitch classes sounding in each bar; below,
         the best fit, <b>faded where it cannot really tell</b>.`;

    const legendFor = () => controls.key === "track"
      ? pcLegend()
      : legend([["Minor fit", "--s7"], ["Major fit", "--s4"], ["More notes", "--q6"],
                ["Fewer notes", "--q2"]]);

    const refresh = () => {
      document.getElementById("i-keylegend")!.innerHTML = legendFor();
      document.getElementById("i-keycap")!.innerHTML = caption();
      (document.getElementById("i-spanctrl") as HTMLElement).hidden = controls.key !== "track";
    };

    mount(document.getElementById("i-keytime")!, drawKey);
    refresh();
    keyEl.addEventListener("change", () => {
      controls.key = keyEl.value as Controls["key"];
      repaint(document.getElementById("i-keytime")!, drawKey);
      refresh();
    });
    spanEl.addEventListener("change", () => {
      controls.span = spanEl.value as Controls["span"];
      repaint(document.getElementById("i-keytime")!, drawKey);
      refresh();
    });
  }

  window.scrollTo({ top: scroll });
}
