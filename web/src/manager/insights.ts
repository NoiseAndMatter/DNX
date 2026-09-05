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
  clock, cycleSteps, fitKey, harmonic, machineLabel, microBuckets, pitchByPreset, pitchWindows,
  playing, repeatSteps, stepsToSeconds, trackWindows, type AnalysisSubject, type KeyFit,
} from "../analysis/model.js";
import {
  densityBars, keyTimeline, legend, machineVar, microDiverging, pcLegend, phaseStrip, pitchBars,
  realignBars, table, trackTimeline, type PhaseMode,
} from "../analysis/charts.js";
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

/**
 * Draw the analysis for one subject into `host`.
 *
 * `host` must carry `.viz`; every rule in `viz.css` is scoped under it, because `charts.ts` emits
 * a `.legend` and so does the pattern grid.
 */
export function renderInsights(host: HTMLElement, subject: AnalysisSubject): void {
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

  const live = playing(subject);
  if (live.length === 0) {
    host.innerHTML = card("Insights", `<p class="hint">
      <strong>${escapeHtml(subject.label)}</strong> has no trigs on any track, so there is nothing
      to measure. Select a pattern that plays something.</p>`);
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
  const keyWindows = tonal.length ? pitchWindows(tonal, cycle, 16, 16) : [];
  const whole = keyWindows.length
    ? fitKey(keyWindows.reduce((acc, v) => acc.map((x, i) => x + v.counts[i]!), new Array(12).fill(0)))
    : undefined;
  const changes = keyWindows.filter((v, i) => i && v.fit.name !== keyWindows[i - 1]!.fit.name).length;

  const masterFit = tonal.length
    ? fitKey(pitchWindows(tonal, subject.masterLength, subject.masterLength, subject.masterLength)[0]!.counts)
    : undefined;
  const rowsBeat = tonal.length ? trackWindows(tonal, subject.masterLength, 4, 4, () => masterFit) : [];
  const rowsBar = tonal.length
    ? trackWindows(tonal, cycle, 16, 16, (i): KeyFit | undefined => keyWindows[i]?.fit)
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
  const windowSteps = Math.max(subject.masterLength, longest);
  const machinesUsed = MACHINE_ORDER.filter((m) => live.some((t) => t.machine === m));

  host.innerHTML =
    card(`Play time and cycle — ${subject.label}`, `
      <div class="tiles">
        <div class="tile"><span class="k">Tempo</span>
          <span class="v">${subject.tempo.toFixed(subject.tempo % 1 ? 1 : 0)}</span>
          <span class="u">BPM</span></div>
        <div class="tile"><span class="k">Master length</span>
          <span class="v">${subject.masterLength}</span><span class="u">steps</span>
          <span class="note">${clock(stepsToSeconds(subject.masterLength, subject.tempo))} ·
            ${subject.masterLength / 16} bars</span></div>
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
          <option value="locks">Preset locks</option>
        </select>
      </div>
      <figure>
        <figcaption>Each tick is a track restarting and each dot is a trig, so the polymeter is
          read against the actual rhythm. <b>${accents} of ${allTrigs} trigs are above the default
          velocity of ${subject.defaultVelocity}</b> and are drawn brighter and ringed.${
            windowSteps === subject.masterLength ? "" : ` Drawn over <b>${windowSteps} steps</b>
            rather than the master length of ${subject.masterLength}, so every track completes at
            least one pass.`}</figcaption>
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
          <p class="why" style="margin-top:.35rem"><b>One reading here is not yet confirmed on
            hardware</b>: a RESET field of <code>1</code> is taken to mean INF — never restart —
            by analogy with CHANGE, where <code>1</code> is documented as off. If that is wrong,
            the patterns affected are the ones this page reports as never being reset.</p>
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
              <option value="beat">${subject.masterLength / 16} bars — a column per beat</option>
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
          <span class="h">Best fit over the whole cycle — an inference, not a reading</span>
          <p class="fit">${escapeHtml(whole!.name)}
            <span style="color:var(--ink2);font-size:.8rem">— margin
            ${whole!.margin.toFixed(2)} over ${escapeHtml(whole!.runnerUp)}</span></p>
          <p class="why">Krumhansl–Schmuckler correlation against the standard profiles, named so
            the method is attributable. <b>The margin is the confidence, not the correlation</b> — a
            relative minor shares six of seven notes with its major, so a high score with a small
            margin is the normal case rather than the exception. The device stores no key, and
            ${tonal.length} of ${live.length} playing tracks were used: the rest sound one pitch
            class each and would swamp the fit. The <b>arpeggiator</b> transposes and its settings
            are not decoded, so a track using one is not fully read here.</p>
        </div>`}
      ${table(["Pitch class", "Notes", "Presets"], pitch.filter((c) => c.total).map((c) =>
        [c.name, c.total, Object.entries(c.byPreset).sort((a, b) => b[1] - a[1])
          .map(([p, n]) => `${p} x${n}`).join(", ")]))}
    `) +

    (subject.gateLengthKnown ? "" : card("Not drawn, and why", `
      <div class="inferred">
        <span class="h">Voice pressure needs a gate length, and a gate length is not decoded</span>
        <p class="why">Three things this surface can draw are missing from the cards above:
          <b>voice pressure</b>, <b>note length</b> and <b>overlapping notes</b>. All three need to
          know how long a note sounds, and a Digitone II project does not say. The trig carries a
          note-length byte and the track a default — <code>0x0E</code> in 1,577 of the 1,725 tracks
          that play a note across the corpus, and <b>24 other values</b> in the rest — but
          <b>nothing maps any of them to a duration</b>. <code>docs/dn2-pattern-format.md</code>
          marks even the name of the track default as inferred from its position in the Digitone 1
          block rather than from a capture.</p>
        <p class="why" style="margin-top:.4rem">A plausible mapping would make a voice-count chart
          that looks exactly like a measured one and is not, which is the single failure this whole
          surface is arranged to avoid. <b>It is on the capture list</b>: set one trig to each
          <code>LEN</code> value on the instrument, save, and diff. The charts are already written
          and will draw the moment the mapping exists — the synthetic harness at
          <code>/mockups/metrics.html</code> shows them working.</p>
      </div>
    `));

  mount(document.getElementById("i-phase")!, (w) =>
    phaseStrip(live, windowSteps, controls.phase, subject.defaultVelocity, w));
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
      : `A key belongs to a <b>moment</b>, not to a pattern${cycle > subject.masterLength
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
