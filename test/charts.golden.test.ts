/**
 * Every chart, rendered from one fixed subject and compared byte for byte with a committed copy.
 *
 * The other chart tests ask one question each: no `NaN`, the right colour on the culprit, a clipped
 * label. None of them says the markup as a whole is unchanged, and several charts had no test at
 * all: the voice charts, the reset ruler, the alignment grid, the legends, and two of the four
 * phase-strip modes. `charts.ts` is about to be split into a folder by moving code, and a move is
 * only a move if what it draws is the same to the byte. This is what says so.
 *
 * The subject is synthetic and built with the model's own helpers, so it runs without the corpus
 * and every chart gets data shaped the way a producer shapes it. It is chosen to reach the cases
 * that are easy to break: a speed that makes a fractional period, an INF gate, a gate that wraps,
 * a chord, an overrun of the voice budget, a reset that cuts a track with notes in the lost part
 * and one that cuts a track with none, an unknown machine, a MIDI track with its own label, and a
 * preset name that has to be escaped.
 *
 * **Numbers printed through `toLocaleString` stay below 1,000.** `cycleBars` formats with the
 * default locale, which is the machine's: this one groups thousands with a comma, a Spanish locale
 * does not group four digits, and a CI runner may differ again. Below 1,000 every locale that
 * writes Latin digits prints the same string.
 *
 * To regenerate after a deliberate change to what a chart draws:
 *
 *   DNX_UPDATE_GOLDEN=1 npx tsx --test test/charts.golden.test.ts
 *
 * and read the diff of `test/fixtures/charts/` before committing it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as charts from "../web/src/analysis/charts.js";
import {
  cycleSteps, fitKey, harmonic, microBuckets, periodGroups, pitchByPreset, pitchWindows, playing,
  trackWindows, voicesPerStep,
  type AnalysisSubject, type AnalysisTrack, type AnalysisTrig,
} from "../web/src/analysis/model.js";
import { MACHINE } from "../src/project/machine.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "charts");
const UPDATE = process.env["DNX_UPDATE_GOLDEN"] === "1";

/** A trig with the boring fields filled in, as `analysis.test.ts` builds them. */
function trig(step: number, notes: number[], over: Partial<AnalysisTrig> = {}): AnalysisTrig {
  return { step, notes, velocity: 100, length: 1, microTiming: 0, ...over };
}

const TRACKS: AnalysisTrack[] = [
  {
    number: 1, length: 16, speed: 1, machine: MACHINE.fmDrum, preset: "KICK", trigs: [
      trig(0, [36], { velocity: 120 }), trig(4, [36]), trig(8, [36], { microTiming: -12 }),
      trig(12, [36], { microTiming: -5 }),
    ],
  },
  {
    // 12 steps at 3/2x: a period of 8 master steps, so the speed changes what the charts draw.
    number: 2, length: 12, speed: 1.5, machine: MACHINE.fmTone, preset: "BASS", trigs: [
      trig(0, [48], { length: 3 }), trig(2, [50], { lockPreset: "SUB LOCK" }),
      trig(7, [55], { length: 6, microTiming: 23 }),
    ],
  },
  {
    number: 3, length: 16, speed: 1, machine: MACHINE.wavetone, preset: "PAD", trigs: [
      trig(0, [60, 64, 67], { length: 4 }),
      trig(8, [57, 60, 64], { length: 8, velocity: 110, lockPreset: "PAD LOCK" }),
    ],
  },
  {
    // 14 steps at 3/4x: a period of 18⅔, the fractional case the alignment arithmetic exists for.
    number: 4, length: 14, speed: 0.75, machine: MACHINE.swarmer, preset: "LEAD", trigs: [
      trig(0, [72]), trig(5, [74], { microTiming: 6 }), trig(10, [76], { length: Infinity }),
      trig(13, [79], { microTiming: -18 }),
    ],
  },
  {
    number: 5, label: "A", length: 7, speed: 1, machine: MACHINE.midi, preset: "EXT SYNTH", trigs: [
      trig(0, [62]), trig(3, [65], { conditional: true }),
    ],
  },
  {
    // An unknown machine, and a preset name a tooltip must print rather than parse.
    number: 6, length: 12, speed: 1, machine: undefined, preset: "<b>&", trigs: [
      trig(2, [45], { length: 2 }),
    ],
  },
  // Silent. `playing` drops it, as every caller does.
  { number: 7, length: 16, speed: 1, machine: MACHINE.fmTone, preset: "EMPTY", trigs: [] },
];

const SUBJECT: AnalysisSubject = {
  label: "A1 · GOLDEN", tempo: 120, masterLength: 64, perTrackLengths: true, resetSteps: 64,
  voiceBudget: 6, defaultVelocity: 100, gateLengthKnown: true, patternTimingKnown: true,
  arpKnown: true, tracks: TRACKS,
};

const W = 900;
const LIVE = playing(SUBJECT);
const WINDOW = SUBJECT.masterLength;
const CYCLE = cycleSteps(LIVE);
const SERIES = voicesPerStep(LIVE, WINDOW);
const BUDGET = SUBJECT.voiceBudget;
const GROUPS = periodGroups(LIVE);
const KEYED = harmonic(LIVE);
const WINDOWS = pitchWindows(KEYED, 128, 16, 16);

/** Each fixture's file name, and what goes in it. */
const CASES: [string, () => string][] = [
  ["phaseStrip-velocity.svg", () => charts.phaseStrip(LIVE, WINDOW, "velocity", SUBJECT.defaultVelocity, W)],
  ["phaseStrip-length.svg", () => charts.phaseStrip(LIVE, WINDOW, "length", SUBJECT.defaultVelocity, W)],
  ["phaseStrip-locks.svg", () => charts.phaseStrip(LIVE, WINDOW, "locks", SUBJECT.defaultVelocity, W)],
  ["phaseStrip-overlap.svg", () => charts.phaseStrip(LIVE, WINDOW, "overlap", SUBJECT.defaultVelocity, W)],

  ["realignBars.svg", () => charts.realignBars(LIVE, CYCLE, W)],
  ["realignBars-flat.svg", () => {
    const flat = [LIVE[0]!, { ...LIVE[2]!, number: 3 }];
    return charts.realignBars(flat, cycleSteps(flat), W);
  }],

  ["cycleBars.svg", () => charts.cycleBars([
    { label: "A1 · GOLDEN", cycle: 64, polymeter: 336, bounded: true, lostTrigs: 3, seconds: 8,
      focused: true },
    { label: "A2", cycle: 48, polymeter: 48, bounded: true, lostTrigs: 0, seconds: 6 },
    { label: "A3 · CUT BUT NOTHING LOST", cycle: 128, polymeter: 896, bounded: true, lostTrigs: 0,
      seconds: 16 },
    // Unbounded: in a real comparison `cycle` is `POLYMETER_LIMIT`. See the header on locales.
    { label: "A4 · SIXTEEN COPRIME LENGTHS", cycle: 960, polymeter: 960, bounded: false,
      lostTrigs: 0, seconds: 120 },
    { label: "A5", cycle: 24, polymeter: 24, bounded: true, lostTrigs: 0, seconds: 3.2 },
  ], W)],
  ["cycleBars-empty.svg", () => charts.cycleBars([], W)],

  ["voiceArea.svg", () => charts.voiceArea(SERIES, BUDGET, W)],
  ["voiceLanes.svg", () => charts.voiceLanes(LIVE, WINDOW, SERIES, BUDGET, W)],

  ["densityBars.svg", () => charts.densityBars(LIVE, SUBJECT.defaultVelocity, W)],
  ["pitchBars.svg", () => charts.pitchBars(pitchByPreset(LIVE), W)],
  ["microDiverging.svg", () => charts.microDiverging(microBuckets(LIVE).buckets, W)],

  ["keyTimeline.svg", () => charts.keyTimeline(WINDOWS, W)],
  ["trackTimeline-beats.svg", () => {
    const merged = fitKey(WINDOWS.reduce(
      (acc, win) => acc.map((v, pc) => v + win.counts[pc]!), new Array<number>(12).fill(0)));
    return charts.trackTimeline(trackWindows(LIVE, WINDOW, 4, 4, () => merged), 4, W);
  }],
  ["trackTimeline-bars.svg", () =>
    charts.trackTimeline(trackWindows(LIVE, 128, 16, 16, (i) => WINDOWS[i]?.fit), 16, W)],
  ["trackTimeline-empty.svg", () => charts.trackTimeline([], 16, W)],

  ["resetRuler.svg", () => charts.resetRuler(LIVE, SUBJECT.resetSteps!, W)],
  ["resetRuler-nospeed.svg", () =>
    charts.resetRuler(LIVE.filter((t) => t.speed === 1), SUBJECT.resetSteps!, W)],

  // 168 is where the 12-step and the 18⅔-step periods meet, so one pair is outlined.
  ["alignmentGrid-speeds-everything.svg", () => charts.alignmentGrid(GROUPS, W, 168)],
  ["alignmentGrid-plain.svg", () =>
    charts.alignmentGrid(periodGroups(LIVE.filter((t) => t.speed === 1)), W)],
  ["alignmentGrid-narrow.svg", () => charts.alignmentGrid(GROUPS, 300, 168)],
  ["alignmentGrid-empty.svg", () => charts.alignmentGrid([], W)],

  ["legend.html", () => charts.legend([["FM TONE", "--s1"], ["<unknown> & more", "--ink3"]])],
  ["pcLegend.html", () => charts.pcLegend()],
  ["rampLegend.html", () => charts.rampLegend(8, 1344)],
  ["table.html", () => charts.table(
    ["Track", "Preset", "Notes"],
    [["T1", "KICK", 4], ["T6", "<b>&", 1], ["A", "EXT SYNTH", 2]],
  )],

  // The exports that are values rather than charts, so a move cannot change one silently.
  ["tokens.json", () => JSON.stringify({
    T: charts.T,
    W: charts.W,
    GRID_OP: charts.GRID_OP,
    TIP_SELECTOR: charts.TIP_SELECTOR,
    machineVar: [...Object.values(MACHINE), 99, undefined].map((m) => charts.machineVar(m)),
    rampBand: [[1, 1], [0, 10], [2, 124], [16, 124], [48, 124], [124, 124]]
      .map(([s, w]) => charts.rampBand(s!, w!)),
    rampIsLight: [0, 1, 2, 3, 4, 5].map((b) => charts.rampIsLight(b)),
    pcHue: [0, 1, 11].map((pc) => charts.pcHue(pc)),
  }, null, 2) + "\n"],
];

test("the synthetic subject reaches the cases the fixtures are meant to cover", () => {
  // A fixture of a chart that never met its hard case would prove nothing about that case.
  assert.ok(SERIES.some((v) => v > BUDGET), "the voice series must overrun the budget somewhere");
  assert.ok(GROUPS.some((g) => !Number.isInteger(g.period)), "a fractional period");
  assert.ok(LIVE.length < TRACKS.length, "a silent track that `playing` drops");
  assert.ok(WINDOWS.length > 1, "more than one key window");
});

test("every export of charts.ts is rendered by a fixture", () => {
  // `PhaseMode` and `CycleBar` are types and have no runtime value to list.
  const exported = Object.keys(charts).sort();
  const source = CASES.map(([, render]) => render.toString()).join("\n");
  const missing = exported.filter((name) => !source.includes(`charts.${name}`));
  assert.deepEqual(missing, [], "add a case for each new export");
});

for (const [name, render] of CASES) {
  test(`charts golden: ${name}`, () => {
    const path = join(FIXTURES, name);
    const out = render();
    if (UPDATE) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(path, out);
      return;
    }
    assert.ok(existsSync(path), `no fixture ${name}; run with DNX_UPDATE_GOLDEN=1 to write it`);
    assert.equal(out, readFileSync(path, "utf8"), `${name} no longer matches its fixture`);
  });
}

test("no fixture is left over from a case that was removed", { skip: UPDATE }, () => {
  const names = new Set(CASES.map(([name]) => name));
  const stale = readdirSync(FIXTURES).filter((file) => !names.has(file));
  assert.deepEqual(stale, [], "delete the fixtures no case writes");
});
