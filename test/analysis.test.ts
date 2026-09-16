/**
 * The analysis derivations, and the boundary that keeps them testable.
 *
 * These functions used to live inside `web/mockups/metrics.html`, where none of them could be
 * tested at all: a chart is a string, the data was one seeded blob, and the only check available
 * was a person looking at the page. Several of the facts asserted below were found by looking, and
 * this is where they stop depending on anyone remembering to look again.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  chordName, clock, cycleSteps, fitKey, harmonic, holdersAt, machineLabel, microBuckets,
  overlappingNotes, pitchByPreset, pitchWindows, pitchClass, playing, presetOf, stepsToSeconds,
  POLYMETER_LIMIT, MICRO_MAX, alignmentOf, masterPeriod, microFraction, periodGroups,
  polymeterIsBounded, reachableSteps, dormantTrigs,
  repeatSteps, resetCuts, resetOptions, trackWindows, voicesPerStep,
  type AnalysisSubject, type AnalysisTrack, type AnalysisTrig,
} from "../web/src/analysis/model.js";
import { cycleBars, microDiverging, realignBars } from "../web/src/analysis/charts.js";
import { compareSubjects, summariseComparison } from "../web/src/analysis/compare.js";
import { MACHINE } from "../src/project/machine.js";
import { noteLengthSteps } from "../src/project/dn2pattern.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A trig with the boring fields filled in, so a test states only what it is about. */
function trig(step: number, notes: number[], over: Partial<AnalysisTrig> = {}): AnalysisTrig {
  return { step, notes, velocity: 100, length: 1, microTiming: 0, ...over };
}

function track(over: Partial<AnalysisTrack> = {}): AnalysisTrack {
  return {
    number: 1, length: 16, speed: 1, machine: MACHINE.fmTone, preset: "TEST", trigs: [], ...over,
  };
}

/* ---- geometry -------------------------------------------------------------------------- */

test("the cycle is the least common multiple of the track lengths", () => {
  const tracks = [track({ length: 16 }), track({ number: 2, length: 12 }),
                  track({ number: 3, length: 7 })];
  // 16, 12 and 7 realign at 336 — and a 7 is exactly the kind of length that stretches a cycle
  // from four bars to twenty-one, which is the whole point of drawing it.
  assert.equal(cycleSteps(tracks), 336);
});

test("one track is its own cycle", () => {
  assert.equal(cycleSteps([track({ length: 64 })]), 64);
});

test("steps become seconds at the sequencer's sixteenths, and speed divides", () => {
  // 16 steps is one bar; at 120 BPM a bar of 4/4 is 2 seconds.
  assert.equal(stepsToSeconds(16, 120), 2);
  // Half speed takes twice as long to get through the same steps.
  assert.equal(stepsToSeconds(16, 120, 0.5), 4);
});

test("the clock pads the seconds so times line up in a column", () => {
  assert.equal(clock(7), "0:07.0");
  assert.equal(clock(146.1), "2:26.1");
});

/* ---- the voice budget ------------------------------------------------------------------ */

test("a chord trig spends one voice per note, not one per trig", () => {
  /*
   * **This is the bug that moved a real number.** Counting a trig once instead of counting its
   * notes under-reported every chord in the pattern, and the voice budget is exactly where that
   * matters: the peak read 17 against a budget of 16 when it was really 21.
   */
  const chord = track({ length: 4, trigs: [trig(0, [60, 64, 67, 71])] });
  assert.deepEqual(voicesPerStep([chord], 4), [4, 0, 0, 0]);
});

test("a gate holds its voices for its whole length, and stops at the window", () => {
  const held = track({ length: 8, trigs: [trig(6, [60], { length: 4 })] });
  assert.deepEqual(voicesPerStep([held], 8), [0, 0, 0, 0, 0, 0, 1, 1]);
});

test("a short track repeats into the window and stacks with itself", () => {
  // A 4-step track inside a 16-step window sounds four times. This is how a single short track
  // pushes the total over a budget that looks fine when you only read the pattern's first bar.
  const short = track({ length: 4, trigs: [trig(0, [60])] });
  assert.deepEqual(voicesPerStep([short], 16),
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
});

test("the holders at a step name the tracks, so a peak can be acted on", () => {
  const a = track({ number: 3, length: 4, trigs: [trig(0, [62], { length: 3 })] });
  const b = track({ number: 9, length: 4, trigs: [trig(2, [69])] });
  const at = holdersAt([a, b], 4, 2);
  assert.deepEqual(at.map((h) => h.track.number), [3, 9]);
  assert.deepEqual(at.map((h) => h.note), ["D", "A"]);
});

/* ---- overlaps, which are not glides ---------------------------------------------------- */

test("a note still sounding when the next one starts is an overlap", () => {
  const t = track({ length: 16, trigs: [trig(0, [60], { length: 3 }), trig(2, [62])] });
  const pairs = overlappingNotes(t);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.a.step, 0);
  assert.equal(pairs[0]!.b.step, 2);
  assert.equal(pairs[0]!.wrap, undefined);
});

test("a gate that runs off the end of the track overlaps the first note of the next pass", () => {
  // The wrap case: the track is 8 long, the last note starts at 6 and holds 4, so it is still
  // sounding at step 10 — which is step 2 of the repetition, where the first note is not.
  const t = track({ length: 8, trigs: [trig(0, [60]), trig(6, [67], { length: 4 })] });
  const wrapped = overlappingNotes(t).filter((p) => p.wrap);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0]!.a.step, 6);
  assert.equal(wrapped[0]!.b.step, 0);
});

test("notes that merely touch do not overlap", () => {
  const t = track({ length: 16, trigs: [trig(0, [60], { length: 2 }), trig(2, [62])] });
  assert.deepEqual(overlappingNotes(t), []);
});

/* ---- what plays what ------------------------------------------------------------------- */

test("a sound lock names the preset on that trig, and only that trig", () => {
  const t = track({
    preset: "DEEP BASS",
    trigs: [trig(0, [36]), trig(4, [36], { lockPreset: "CLAP TAIL" })],
  });
  assert.equal(presetOf(t, t.trigs[0]!), "DEEP BASS");
  assert.equal(presetOf(t, t.trigs[1]!), "CLAP TAIL");

  const cells = pitchByPreset([t]);
  assert.deepEqual(cells[0]!.byPreset, { "DEEP BASS": 1, "CLAP TAIL": 1 });
});

test("every note of a chord is counted in the pitch histogram", () => {
  const t = track({ trigs: [trig(0, [60, 64, 67])] });
  const cells = pitchByPreset([t]);
  assert.equal(cells[0]!.total, 1);   // C
  assert.equal(cells[4]!.total, 1);   // E
  assert.equal(cells[7]!.total, 1);   // G
  assert.equal(cells.reduce((s, c) => s + c.total, 0), 3);
});

test("an unnameable machine is counted apart and prints as its number", () => {
  // `machine.ts` only knows the five its capture covered, and is explicit that the DN2's list is
  // longer. An unknown value must never be shown as a plausible name.
  const t = track({ machine: 9, trigs: [trig(0, [60])] });
  assert.equal(pitchByPreset([t])[0]!.byMachine[9], 1);
  assert.equal(machineLabel(9), "machine 9");
  assert.equal(machineLabel(undefined), "unknown machine");
  assert.equal(machineLabel(MACHINE.swarmer), "SWARMER");
});

test("on-grid trigs are counted but kept out of the microtiming buckets", () => {
  // They hold most of the trigs, and leaving them in flattened every deviation into a stub.
  const t = track({
    trigs: [trig(0, [60]), trig(1, [60]), trig(2, [60], { microTiming: -11 }),
            trig(3, [60], { microTiming: 13 })],
  });
  const m = microBuckets([t]);
  assert.equal(m.onGrid, 2);
  assert.deepEqual(m.buckets, [{ at: -12, n: 1 }, { at: 12, n: 1 }]);
});

test("a track with nothing on it is not a row on any chart", () => {
  const subject: AnalysisSubject = {
    label: "x", tempo: 120, masterLength: 16, perTrackLengths: false, voiceBudget: 16,
    defaultVelocity: 100,
    gateLengthKnown: true, patternTimingKnown: true,
    tracks: [track({ number: 1, trigs: [trig(0, [60])] }), track({ number: 2 })],
  };
  assert.deepEqual(playing(subject).map((t) => t.number), [1]);
});

/* ---- key, and why it is only ever a fit ------------------------------------------------ */

test("key analysis ignores tracks that play one pitch class", () => {
  /*
   * **Found by looking at a flat timeline.** With every track included the fit never moved once
   * across 84 bars, because a hat on one pitch every step is an immovable spike no melodic line
   * can outvote — the key analysis was measuring the drum kit.
   */
  const hat = track({ number: 1, trigs: [trig(0, [66]), trig(1, [66]), trig(2, [66])] });
  const lead = track({ number: 2, trigs: [trig(0, [62]), trig(4, [65]), trig(8, [69])] });
  assert.deepEqual(harmonic([hat, lead]).map((t) => t.number), [2]);
});

test("a drone is caught by the same test as a drum", () => {
  // The rule is measured, not assumed: it does not need to know which machine is a drum.
  const drone = track({ machine: MACHINE.swarmer, trigs: [trig(0, [48]), trig(8, [48])] });
  assert.deepEqual(harmonic([drone]), []);
});

test("the margin is the confidence, and it is the gap to the runner-up", () => {
  // A plain D minor triad. The fit should be a D-rooted minor, and `margin` must be exactly the
  // distance to the second-placed candidate rather than the winning correlation itself.
  const counts = new Array<number>(12).fill(0);
  counts[2] = 8; counts[5] = 6; counts[9] = 6;   // D, F, A
  const fit = fitKey(counts);
  assert.equal(fit.notes, 20);
  assert.ok(fit.margin >= 0, "the winner cannot score below the runner-up");
  assert.notEqual(fit.name, fit.runnerUp);
  assert.ok(fit.margin < fit.r, "a margin equal to the correlation would mean the pair are unrelated");
});

test("an empty window fits nothing rather than throwing", () => {
  const fit = fitKey(new Array<number>(12).fill(0));
  assert.equal(fit.notes, 0);
  assert.equal(fit.r, 0);
});

test("a window is counted across every repetition of a short track", () => {
  const short = track({ length: 4, trigs: [trig(0, [60])] });
  const windows = pitchWindows([short], 16, 16, 16);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.counts[0], 4);
});

/* ---- naming a chord, which is an inference on an inference ----------------------------- */

test("the same notes are named against the key around them", () => {
  /*
   * D F A is `i` in D minor and `vi` in F major. This is the behaviour the per-track timeline
   * exists for: the fitted key underneath moves bar to bar, so the same stack is read differently
   * in different places — and that is a finding, not an inconsistency.
   */
  const dMinor = fitKey(Object.assign(new Array<number>(12).fill(0),
    { 2: 10, 5: 7, 7: 5, 9: 7, 0: 4 }));
  const named = chordName([2, 5, 9], dMinor);
  assert.equal(named!.name, "Dm");
  assert.match(named!.kind, /in D minor/);

  const fMajor = { name: "F major", root: 5, minor: false, r: 1, margin: 1, runnerUp: "", notes: 1 };
  assert.equal(chordName([2, 5, 9], fMajor)!.kind, "vi in F major");
});

test("a triad is named without a key, just without a degree", () => {
  const named = chordName([0, 4, 7]);
  assert.equal(named!.name, "C");
  assert.equal(named!.kind, "");
});

test("one and two notes are described rather than named as chords", () => {
  assert.deepEqual(chordName([7]), { name: "G", kind: "single note" });
  assert.deepEqual(chordName([0, 7]), { name: "C+G", kind: "5th" });
  assert.equal(chordName([]), null);
});

test("a seventh is recognised and an added note makes the reading approximate", () => {
  assert.equal(chordName([0, 4, 7, 10])!.name, "C7");
  assert.equal(chordName([0, 3, 7])!.name, "Cm");
  // A stray note the shape cannot explain still names the shape, and says it is approximate.
  assert.match(chordName([0, 4, 7, 1])!.kind, /approximate/);
});

/* ---- the per-track timeline ------------------------------------------------------------ */

test("a repeated note is one line in a cell, however often it sounds", () => {
  /*
   * The stack answers *what is sounding here*, not how busy the track is — density has its own
   * chart. A bass repeating one note eight times in a bar is one line.
   */
  const bass = track({ length: 16, trigs: [0, 2, 4, 6].map((s) => trig(s, [36])) });
  const rows = trackWindows([bass], 16, 16, 16);
  const cell = rows[0]!.cells[0]!;
  assert.deepEqual(cell.stack, [36]);
  assert.equal(cell.n, 4, "the count is still available, it is just not the stack");
});

test("a stack is ordered low to high, which pitch classes could not do", () => {
  const t = track({ trigs: [trig(0, [72, 60, 67])] });
  assert.deepEqual(trackWindows([t], 16, 16, 16)[0]!.cells[0]!.stack, [60, 67, 72]);
});

test("the key a cell is read against is chosen by the caller, per window", () => {
  // A four-bar view uses the fit over all four; a per-bar view uses that bar's own. A key fitted
  // to one beat would be noise, so the scale of the context is the caller's decision.
  const t = track({ length: 16, trigs: [trig(0, [62]), trig(8, [65])] });
  const seen: number[] = [];
  trackWindows([t], 32, 16, 16, (i) => { seen.push(i); return undefined; });
  assert.deepEqual(seen, [0, 1]);
});

test("pitch class wraps, including below zero", () => {
  assert.equal(pitchClass(60), 0);
  assert.equal(pitchClass(71), 11);
  assert.equal(pitchClass(-1), 11);
});

/* ---- what actually decides when a pattern repeats --------------------------------------- */

test("PATTERN RESET bounds the polymeter, because the sequencer restarts every track", () => {
  /*
   * **The least common multiple is not when a pattern repeats.** Elektron's manual on the PAGE
   * SETUP menu: RESET *"controls the number of steps the pattern plays before all tracks resets and
   * restarts from the first step on the first page. An INF setting makes the tracks of the pattern
   * loop infinitely, without ever being restarted."*
   *
   * So tracks of 12, 16 and 64 have a 192-step polymeter, and with RESET at 64 they never reach it.
   * The page reported one corpus pattern as repeating every 1,984 steps — 12 minutes 24 — when the
   * device restarts it every 128, which is 48 seconds. Arithmetically right, musically false, and
   * 40 of the 352 playing patterns were overstated the same way.
   */
  const tracks = [track({ number: 1, length: 12 }), track({ number: 2, length: 16 }),
                  track({ number: 3, length: 64 })];
  assert.equal(cycleSteps(tracks), 192, "the polymeter arithmetic is unchanged");
  assert.equal(repeatSteps(tracks, 64), 64, "RESET cuts it");
  assert.equal(repeatSteps(tracks, undefined), 192, "INF lets it run");
});

test("a RESET longer than the polymeter changes nothing", () => {
  // The bound is a minimum, not a replacement: a pattern that comes round before it is reset is
  // already repeating, and the reset lands on a boundary it would have hit anyway.
  const tracks = [track({ number: 1, length: 16 }), track({ number: 2, length: 8 })];
  assert.equal(cycleSteps(tracks), 16);
  assert.equal(repeatSteps(tracks, 64), 16);
});

test("a track whose length divides the reset is clean, and is not reported", () => {
  const tracks = [track({ number: 1, length: 16 }), track({ number: 2, length: 32 })];
  assert.deepEqual(resetCuts(tracks, 64), []);
});

test("a track the reset interrupts says how far it got", () => {
  /*
   * **The one thing on this surface a musician can act on.** A 12-step track under a 64-step reset
   * plays five whole passes and four steps of a sixth, then is pulled back — in the same place on
   * every repeat. Audible as a part that goes wrong at the same moment each time round, and
   * invisible on the instrument, which shows lengths and the reset on different rows and never
   * their remainder. 41 of the 352 playing corpus patterns have at least one.
   */
  const tracks = [track({ number: 1, length: 12 }), track({ number: 4, length: 24 }),
                  track({ number: 2, length: 16 })];
  const cuts = resetCuts(tracks, 64);
  assert.deepEqual(cuts.map((c) => [c.track.number, c.passes, c.cutAfter]),
    [[1, 5, 4], [4, 2, 16]]);
});

test("no reset means nothing is cut", () => {
  const tracks = [track({ number: 1, length: 7 }), track({ number: 2, length: 12 })];
  assert.deepEqual(resetCuts(tracks, undefined), []);
});

test("a track reports the trigs stored past its own end, and where they start playing", () => {
  /*
   * Shortening a track on a Digitone II keeps whatever was written on the pages it drops.
   * `MORNING_JAM` A4 T1 is the case this was measured against: 16 steps, holding notes on 33, 37,
   * 41 and 45. `reachAt` is the LEN that brings the last of them back.
   */
  const t = track({
    length: 16,
    trigs: [trig(0, [60]), trig(4, [62])],
    dormant: [trig(32, [64]), trig(40, [67]), trig(36, [65]), trig(44, [69])],
  });
  const [found] = dormantTrigs([t]);
  assert.ok(found);
  assert.deepEqual(found.steps, [33, 37, 41, 45], "reported 1-based and ascending, as the grid is");
  assert.equal(found.reachAt, 45);
});

test("a track with nothing stored past its end is not reported", () => {
  // The finding has to stay rare enough to be worth reading. Most tracks have no dormant trigs at
  // all, and a card listing every track would be a card nobody opens.
  assert.deepEqual(dormantTrigs([track({ trigs: [trig(0, [60])] })]), []);
  assert.deepEqual(dormantTrigs([track({ dormant: [] })]), []);
});

test("a reset makes most of a long polymeter unreachable, not shorter", () => {
  /*
   * Every track returns to step one together at the reset, so the pattern is exactly periodic from
   * there. You do not hear less of the polymeter — you hear the **same** first stretch forever, and
   * the phasing past it never happens at all.
   */
  const tracks = [track({ number: 1, length: 12 }), track({ number: 2, length: 16 }),
                  track({ number: 3, length: 64 })];
  assert.deepEqual(reachableSteps(tracks, 64), { reachable: 64, total: 192 });
  assert.deepEqual(reachableSteps(tracks, undefined), { reachable: 192, total: 192 });
});

/* ---- SPEED, and the master clock ---------------------------------------------------------- */

test("a track's period is its length divided by its speed", () => {
  /*
   * **A length is not a period.** SPEED is a multiple of the tempo — Elektron's manual: *"a setting
   * of 1/8X plays back the track at one-eighth of the set tempo"* — so twelve steps at 3/2x take
   * eight master steps and sixteen at 1/2x take thirty-two.
   */
  assert.equal(masterPeriod(track({ length: 12, speed: 1.5 })), 8);
  assert.equal(masterPeriod(track({ length: 16, speed: 0.5 })), 32);
  assert.equal(masterPeriod(track({ length: 16, speed: 1 })), 16);
  assert.equal(masterPeriod(track({ length: 16 })), 16, "no speed means 1x");
});

test("the polymeter is measured on the master clock, not on track lengths", () => {
  /*
   * **This was wrong for 60 of the 352 playing patterns in the corpus.** `GLITCH_EXPLORE` B5 has
   * tracks of 12@3/2x, 16@1x, 64@1x and 24@3/2x. Read as raw lengths that is a 192-step polymeter
   * with two tracks cut by its 64-step reset. On the master clock the periods are 8, 16, 64 and 16,
   * the polymeter is **64** — exactly the reset — and nothing is cut at all.
   */
  const b5 = [track({ number: 1, length: 12, speed: 1.5 }), track({ number: 2, length: 16 }),
              track({ number: 3, length: 64 }), track({ number: 4, length: 24, speed: 1.5 })];
  assert.equal(cycleSteps(b5), 64);
  assert.deepEqual(resetCuts(b5, 64), [], "nothing is interrupted");
});

test("tracks of different lengths can share a period, and never drift", () => {
  // 16 at 1x and 24 at 3/2x both take sixteen master steps. Grouping on length would have split
  // them; grouping on period keeps them where they belong, which is together.
  const groups = periodGroups([track({ number: 2, length: 16 }),
                               track({ number: 4, length: 24, speed: 1.5 })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.period, 16);
  assert.deepEqual(groups[0]!.lengths, [16, 24]);
  assert.deepEqual(groups[0]!.tracks, [2, 4]);
});

test("the same length at two speeds does not stay in phase", () => {
  // The mirror of the case above, and the reason grouping on length was wrong.
  const groups = periodGroups([track({ number: 1, length: 16 }),
                               track({ number: 2, length: 16, speed: 2 })]);
  assert.deepEqual(groups.map((g) => g.period), [8, 16]);
  assert.equal(alignmentOf(8, 16), 16);
});

test("a fractional period still gives an exact alignment", () => {
  // 16 steps at 3/4x is 21⅓ master steps. Asking a float for the least common multiple of that and
  // 16 gives nonsense; the arithmetic is done in twenty-fourths.
  const period = masterPeriod(track({ length: 16, speed: 0.75 }));
  assert.ok(Math.abs(period - 64 / 3) < 1e-9);
  assert.equal(alignmentOf(period, 16), 64);
});

/* ---- the reset calculator ---------------------------------------------------------------- */

test("alignment is a property of periods, so tracks are grouped by those", () => {
  const tracks = [track({ number: 1, length: 16 }), track({ number: 2, length: 12 }),
                  track({ number: 5, length: 16 })];
  assert.deepEqual(periodGroups(tracks).map((g) => [g.period, g.tracks]),
    [[12, [2]], [16, [1, 5]]]);
});

test("two lengths come back into phase at their least common multiple", () => {
  assert.equal(alignmentOf(12, 16), 48);
  assert.equal(alignmentOf(16, 64), 64, "one dividing the other means they never drift");
  assert.equal(alignmentOf(16, 16), 16);
});

test("the reset ladder offers only values that leave more tracks whole", () => {
  /*
   * The question is *what do I set so the polyrhythm runs its full length*, and the answer is a
   * short list: the least common multiples of subsets of the distinct lengths. Anything else leaves
   * the same tracks whole as the next value down and is strictly worse, so it is not offered.
   */
  const tracks = [track({ number: 1, length: 12 }), track({ number: 2, length: 16 }),
                  track({ number: 4, length: 24 }), track({ number: 3, length: 64 })];
  const ladder = resetOptions(tracks);
  assert.deepEqual(ladder.map((o) => [o.steps, o.complete.length]),
    [[12, 1], [24, 2], [48, 3], [192, 4]]);
  assert.ok(ladder.at(-1)!.full, "the last option is the full polymeter");
  assert.deepEqual(ladder.at(-1)!.cut, [], "and it cuts nothing");
});

test("one length means one option, and it is already whole", () => {
  const tracks = [track({ number: 1, length: 16 }), track({ number: 2, length: 16 })];
  assert.deepEqual(resetOptions(tracks).map((o) => o.steps), [16]);
});

test("sixteen near-coprime lengths are legal, and must not overflow or hang", () => {
  /*
   * **Track lengths are not ours to choose.** A Digitone II allows 1..128 on each of sixteen
   * tracks, so sixteen pairwise-coprime lengths are a legal pattern — and their least common
   * multiple is of the order of 10^30, past what a double holds exactly. Nothing in the corpus
   * looks like this; the format allows it, which is the only bar that matters.
   *
   * Unbounded, the count would flow into every windowing loop as a limit, which is the same class
   * of fault as the zero-length stride that exhausted a heap.
   */
  const nasty = [128, 127, 125, 121, 119, 117, 113, 109, 107, 103, 101, 97, 89, 83, 79, 73];
  const tracks = nasty.map((length, i) => track({ number: i + 1, length }));

  assert.equal(cycleSteps(tracks), POLYMETER_LIMIT, "saturates rather than losing precision");
  assert.equal(polymeterIsBounded(tracks), false, "and says that it did");

  const started = Date.now();
  const ladder = resetOptions(tracks);
  assert.ok(Date.now() - started < 2000, "65,536 subsets must not be slow enough to notice");
  assert.ok(ladder.every((o) => o.steps < POLYMETER_LIMIT),
    "a saturated value is not a reset anybody can dial in");
  assert.ok(ladder.length > 0);
});

test("a bounded polymeter says so", () => {
  assert.equal(polymeterIsBounded([track({ number: 1, length: 12 }),
                                   track({ number: 2, length: 16 })]), true);
});

/* ---- charts, where the geometry can go wrong without throwing --------------------------- */

test("every track the same length does not produce NaN geometry", () => {
  /*
   * **A log scale divides by the log of the largest value, which is zero when nothing varies.**
   * Every bar becomes `0/0`, an SVG rect with a `NaN` width draws nothing at all, and its label
   * lands at x=0 on top of the track name — a chart that silently disappears rather than failing.
   *
   * The synthetic data always had mixed track lengths, so this never happened in the mockup. The
   * very first real project hit it immediately, and it is the *common* case: 51 of the 64 corpus
   * patterns measured run every track at the master length.
   */
  const same = [16, 16, 16].map((length, i) => track({ number: i + 1, length }));
  const out = realignBars(same, cycleSteps(same), 800);
  assert.doesNotMatch(out, /NaN/, "a NaN width draws nothing and says nothing");
  assert.match(out, /width="800"/, "equal repetitions are equal, and are drawn full width");
});

test("mixed track lengths still scale, and the culprit is the longest cycle", () => {
  const mixed = [track({ number: 1, length: 16 }), track({ number: 2, length: 7 })];
  const out = realignBars(mixed, cycleSteps(mixed), 800);
  assert.doesNotMatch(out, /NaN/);
  // T2 repeats 16 times against T1's 7, so it is what stretches the cycle and takes the alert
  // colour. Reading the first bar drawn is reading the sorted order the chart puts them in.
  assert.match(out.slice(0, out.indexOf("</text>")), /--s2/);
});

/* ---- comparing several subjects at once ------------------------------------------------ */

/** A subject with the boring fields filled in, so a test states only what it is about. */
function subject(over: Partial<AnalysisSubject> = {}): AnalysisSubject {
  return {
    label: "A1", tempo: 120, masterLength: 16, perTrackLengths: false, voiceBudget: 16,
  defaultVelocity: 100,
    gateLengthKnown: false, patternTimingKnown: true,
    tracks: [track({ trigs: [trig(0, [60])] })], ...over,
  };
}

test("a comparison keeps the order the patterns were selected in", () => {
  /*
   * Selection order is the reader's order — it is what the caret and the "analysed below" row
   * depend on, and sorting by any column here would silently move the focused row somewhere else.
   */
  const rows = compareSubjects([subject({ label: "B3" }), subject({ label: "A1" }),
                                subject({ label: "C7" })]);
  assert.deepEqual(rows.map((r) => r.label), ["B3", "A1", "C7"]);
});

test("a comparison row reports the cycle the reset actually allows, not the polymeter", () => {
  /*
   * The correction that mattered most on this surface, asserted across subjects too: a comparison
   * that ranked patterns by their unbounded polymeter would put a pattern the device restarts every
   * 8 bars at the top of a chart of what runs longest.
   */
  const tracks = [track({ number: 1, length: 16, trigs: [trig(0, [60])] }),
                  track({ number: 2, length: 12, trigs: [trig(0, [64])] })];
  const [row] = compareSubjects([subject({ tracks, resetSteps: 64 })]);
  assert.equal(row!.polymeter, 48, "16 and 12 come round together at 48");
  assert.equal(row!.cycle, 48, "and 48 is inside the reset, so nothing is cut");

  const [longer] = compareSubjects([
    subject({
      tracks: [track({ length: 16, trigs: [trig(0, [60])] }),
               track({ number: 2, length: 14, trigs: [trig(0, [64])] })],
      resetSteps: 64,
    }),
  ]);
  assert.equal(longer!.polymeter, 112);
  assert.equal(longer!.cycle, 64, "the reset lands first, so the pattern repeats there");
});

test("a comparison counts the notes a reset silences, not merely the tracks it cuts", () => {
  /*
   * 19 of the 63 interrupted tracks in the corpus lose nothing. A comparison that flagged every cut
   * would put an alert on a third of them for an untidy remainder that costs no music — the same
   * crying-wolf fault the reset ruler had.
   */
  const clean = track({ number: 1, length: 12, trigs: [trig(0, [60]), trig(1, [62])] });
  const bleeding = track({ number: 2, length: 12, trigs: [trig(0, [60]), trig(9, [62])] });
  const [row] = compareSubjects([subject({ tracks: [clean, bleeding], resetSteps: 16 })]);
  assert.equal(row!.cutTracks, 2, "both are cut after 4 of 12 steps");
  assert.equal(row!.lostTrigs, 1, "and only the trig at step 9 was going to sound in the lost part");
});

test("a silent pattern is flagged, because its cycle is an identity and not a measurement", () => {
  /*
   * **This is the bug the test found.** `cycleSteps` returns 1 for a subject with nothing to take a
   * least common multiple of — correct, and not a length. The chart's first guard was `cycle < 1`,
   * which never fires for it, so a pattern sequencing nothing would have drawn a bar at its 2px
   * floor labelled "0.06 bars". `silent` is the flag that means "there is no measurement here", and
   * the view filters on that instead.
   */
  const [row] = compareSubjects([subject({ tracks: [track({ trigs: [] })] })]);
  assert.equal(row!.silent, true);
  assert.equal(row!.playing, 0);
  assert.equal(row!.cycle, 1, "the identity — which is exactly why `cycle` cannot be the flag");
});

test("the summary says INF last, because it is not a short reset", () => {
  /*
   * A list reading "INF, 16, 64" invites the eye to read the absence of a reset as the smallest
   * one. It is the opposite: the tracks are never pulled back at all.
   */
  const rows = compareSubjects([
    subject({ resetSteps: 64 }), subject({ label: "A2" }), subject({ label: "A3", resetSteps: 16 }),
  ]);
  assert.deepEqual(summariseComparison(rows).resets, [16, 64, undefined]);
});

test("the summary picks out the patterns a reset never lets finish", () => {
  const cut = subject({
    label: "cut",
    tracks: [track({ number: 1, length: 16, trigs: [trig(0, [60])] }),
             track({ number: 2, length: 14, trigs: [trig(0, [64])] })],
    resetSteps: 32,
  });
  const whole = subject({
    label: "whole", tracks: [track({ length: 16, trigs: [trig(0, [60])] })], resetSteps: 32,
  });
  const s = summariseComparison(compareSubjects([cut, whole]));
  assert.deepEqual(s.reset.map((r) => r.label), ["cut"]);
  assert.equal(s.shortest!.label, "whole");
  assert.equal(s.longest!.label, "cut");
});

test("a summary of nothing but silent patterns names no shortest or longest", () => {
  /*
   * `reduce` on an empty array throws, and a selection of empty patterns is a completely ordinary
   * thing to make in a project with a half-filled bank.
   */
  const s = summariseComparison(compareSubjects([
    subject({ tracks: [track({ trigs: [] })] }),
    subject({ label: "A2", tracks: [track({ trigs: [] })] }),
  ]));
  assert.equal(s.shortest, undefined);
  assert.equal(s.longest, undefined);
  assert.equal(s.silent.length, 2);
});

test("comparing one subject agrees with the single-pattern card about it", () => {
  /*
   * **The reason `compare.ts` derives nothing of its own.** Every figure in it is a call into
   * `model.ts`, so a comparison and the card below it cannot drift apart — this is what says the
   * two are still asking the same functions rather than two implementations that agree today.
   */
  const tracks = [track({ number: 1, length: 16, trigs: [trig(0, [60]), trig(8, [64])] }),
                  track({ number: 2, length: 12, trigs: [trig(3, [67])] })];
  const one = subject({ tracks, resetSteps: 64 });
  const live = playing(one);
  const [row] = compareSubjects([one]);

  assert.equal(row!.cycle, repeatSteps(live, one.resetSteps));
  assert.equal(row!.polymeter, cycleSteps(live));
  assert.equal(row!.cutTracks, resetCuts(live, one.resetSteps).length);
  assert.equal(row!.playing, live.length);
  assert.equal(row!.seconds, stepsToSeconds(repeatSteps(live, one.resetSteps), one.tempo));
});

test("the cycle chart scales on measurable cycles and lets a saturated one run off the end", () => {
  /*
   * **Found by reasoning about `POLYMETER_LIMIT`, then asserted so it stays true.** Sixteen coprime
   * lengths saturate at a million steps, and letting that set the maximum would squash every real
   * pattern beside it to its 2px floor — a chart of one bar and seven slivers, none of which is a
   * measurement.
   */
  const svg = cycleBars([
    { label: "A1", cycle: 64, polymeter: 64, bounded: true, lostTrigs: 0, seconds: 8 },
    { label: "A2", cycle: POLYMETER_LIMIT, polymeter: POLYMETER_LIMIT, bounded: false,
      lostTrigs: 0, seconds: 125_000 },
  ], 600);
  assert.match(svg, /&gt; 1M steps/, "the unbounded row says so rather than printing the limit");
  assert.match(svg, /4 bars/, "and the measurable one still reads at its real size");

  const widths = [...svg.matchAll(/<rect x="122" [^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 2);
  assert.ok(widths[0]! > 100,
    `the 64-step pattern must keep a readable bar, got ${widths[0]}px of ${600 - 122 - 156}`);
});

test("the cycle chart flags only the patterns that lose notes", () => {
  const svg = cycleBars([
    { label: "clean", cycle: 64, polymeter: 128, bounded: true, lostTrigs: 0, seconds: 8 },
    { label: "losing", cycle: 64, polymeter: 128, bounded: true, lostTrigs: 3, seconds: 8 },
  ], 600);
  assert.equal((svg.match(/--crit/g) ?? []).length, 1,
    "a cut that costs no music must not carry the alert colour");
});

test("the cycle chart draws nothing at all when handed no rows", () => {
  // The view filters silent patterns out, so an all-silent selection reaches this with an empty
  // list. `Math.max()` of nothing is -Infinity, and a chart is a good place for that not to be.
  const svg = cycleBars([], 600);
  assert.doesNotMatch(svg, /<rect|<text/);
  assert.match(svg, /height="0"/);
});

test("a long pattern name is clipped to the gutter and kept whole in the tooltip", () => {
  const svg = cycleBars([{
    label: "A1 · A VERY LONG PATTERN NAME", cycle: 64, polymeter: 64, bounded: true,
    lostTrigs: 0, seconds: 8,
  }], 600);
  assert.match(svg, /…</, "the drawn label is clipped rather than overrunning the bars");
  assert.match(svg, /data-tip-t="A1 · A VERY LONG PATTERN NAME"/, "and the tooltip carries it all");
});


/* ---- microtiming, in the device's own units ------------------------------------------- */

test("a microtiming offset prints the fraction the instrument shows", () => {
  /*
   * **One tick is 1/384 of a whole note** — 24 to a step, 96 to a quarter — and the device shows
   * the offset as that fraction, reduced. Confirmed on hardware 2026-09-06: a trig storing -12
   * reads `-1/32` on screen and one storing +23 reads `+23/384`.
   */
  assert.equal(microFraction(-12), "-1/32");
  assert.equal(microFraction(23), "+23/384");
  assert.equal(microFraction(-6), "-1/64");
  assert.equal(microFraction(12), "+1/32");
  assert.equal(microFraction(0), "on the grid");
});

test("the microtiming range stops one tick short of the next trig", () => {
  // 24/384 is 1/16 — one whole step, landing exactly on the following trig. That is why the
  // parameter offers 23 and not 24, and why nothing should ever be drawn past it.
  assert.equal(MICRO_MAX, 23);
  assert.equal(microFraction(24), "+1/16", "which is precisely why 24 is not offered");
});

test("the microtiming chart draws nothing past what the sequencer can do", () => {
  /*
   * **Found by capturing a trig at the maximum.** Buckets are six ticks wide and centred on a
   * multiple of six, so a trig at +23 lands in a bucket labelled 24 — a position meaning "on the
   * next trig", which the parameter cannot reach. The bucket is real; the label was not.
   */
  const svg = microDiverging([{ at: 24, n: 1 }, { at: -12, n: 1 }], 600);
  assert.doesNotMatch(svg, /ticks/, "no bucket is named by a tick count");
  assert.match(svg, /\+23\/384/, "the out-of-range bucket is clamped to the maximum the device offers");
  assert.doesNotMatch(svg, /1\/16/, "1/16 would be one whole step — the next trig");
  assert.match(svg, /-1\/32/, "an in-range bucket keeps its own readable value");
});

/* ---- the boundary that makes all of the above possible --------------------------------- */

/**
 * Every local module reachable from `entry`, as repo-relative paths.
 *
 * Deliberately not shared with the walk in `web.test.ts`: that one collects the *bare* specifiers
 * a page reaches, to prove nothing drags Node into the browser. This one collects the local files,
 * to prove `analysis/` stays pure. Same traversal, opposite question, and merging them would make
 * one function that answers neither clearly.
 */
function localGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) queue.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return [...seen].map((f) => relative(resolve(HERE, ".."), f).replaceAll("\\", "/"));
}

/** Source with comments removed, so prose about `document` is not read as a use of it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const PURE = ["charts", "compare", "model"] as const;

for (const name of PURE) {
  const entry = resolve(HERE, `../web/src/analysis/${name}.ts`);

  test(`analysis/${name}.ts reaches no page's own folder`, () => {
    /*
     * A page never imports another page's folder, and a module every page shares must not import
     * any of them. Without this the charts could quietly start depending on the manager, and the
     * Insights tool that is meant to reuse them would inherit a page it has nothing to do with.
     */
    const pageFolders = localGraph(entry).filter((f) =>
      /^web\/src\/(expander|manager|library|probe)\//.test(f));
    assert.deepEqual(pageFolders, [],
      `analysis/${name}.ts must not reach a page folder, but found:\n  ${pageFolders.join("\n  ")}`);
  });

  test(`analysis/${name}.ts touches no document`, () => {
    /*
     * **A pure thing inside a DOM module is a pure thing nobody can test** — the same reason
     * `selection.ts` is not part of `grid.ts`. Every test above this line exists because these
     * functions can run without a browser, and this is what keeps that true.
     *
     * `mount.ts` is the deliberate exception and is not in this list.
     *
     * **The pattern is an access, not a word.** Matching the bare name flagged
     * `"5 notes in this window"` — a tooltip string, in a module that touches nothing — and a
     * chart's whole subject is a *window* of steps, so the word is unavoidable in this vocabulary.
     * A global is only useful if something is read off it or constructed from it, so that is what
     * is looked for. Comments are stripped first regardless, because prose says `document` too.
     */
    const BROWSER_ONLY: [RegExp, string][] = [
      [/\bdocument\s*[.[]/, "document"],
      [/\bwindow\s*[.[]/, "window"],
      [/\blocalStorage\s*[.[]/, "localStorage"],
      [/\bnew\s+ResizeObserver\b/, "ResizeObserver"],
      [/\bHTML[A-Za-z]*Element\b/, "an HTML element type"],
      [/\bdocument\b\s*[),;]/, "document"],
    ];
    const offenders: string[] = [];
    for (const file of localGraph(entry)) {
      const source = code(resolve(HERE, "..", file));
      for (const [pattern, api] of BROWSER_ONLY) {
        if (pattern.test(source)) offenders.push(`${file} uses ${api}`);
      }
    }
    assert.deepEqual(offenders, [],
      `analysis/${name}.ts must stay renderable without a browser:\n  ${offenders.join("\n  ")}`);
  });
}

test("the browser-API check would actually catch one", () => {
  /*
   * **A test can pass by finding nothing.** The two checks above assert an empty list, which is
   * exactly what a broken detector also produces — and this one was broken once already, matching
   * the bare word `window` in a tooltip string.
   *
   * `mount.ts` is the known-positive: it exists to touch the document, so the same patterns run
   * over it must fire. If this fails, the checks above are worthless whatever they report.
   */
  const source = code(resolve(HERE, "../web/src/analysis/mount.ts"));
  const found = [
    [/\bdocument\s*[.[]/, "document"],
    [/\bnew\s+ResizeObserver\b/, "ResizeObserver"],
    [/\bHTML[A-Za-z]*Element\b/, "an HTML element type"],
  ].filter(([pattern]) => (pattern as RegExp).test(source)).map(([, api]) => api);
  assert.deepEqual(found, ["document", "ResizeObserver", "an HTML element type"],
    "mount.ts is meant to use the DOM; if these do not fire, the purity checks prove nothing");
});

test("the mockup draws its charts from the shared module, not from a copy of it", () => {
  /*
   * The extraction is only finished if the original copy is gone. An extraction that leaves the
   * old implementation in place has added a module and solved nothing — and the two would drift,
   * with the mockup being exactly the page nobody would notice had gone stale.
   */
  const page = readFileSync(resolve(HERE, "../web/mockups/metrics.html"), "utf8");
  assert.match(page, /from "\.\.\/dist\/web\/src\/analysis\/charts\.js"/,
    "the mockup must import the shared charts");
  assert.doesNotMatch(page, /^function (phaseStrip|voiceArea|keyTimeline|trackTimeline)\b/m,
    "a chart re-implemented in the mockup is a second copy that will drift");
});

/* ---- the note-length table, against the instrument ------------------------------------- */

test("every value dialled on the instrument decodes to what the screen showed", () => {
  /*
   * **The capture that proved the table.** Sixteen trigs of `DNX_CAP_01` A15 were dialled to round
   * values whose byte the model predicts — the eight band boundaries, six mid-band values, INF, and
   * one left alone. All sixteen landed, with nothing written down: the bytes come back in the file.
   *
   * Byte 0 gives 0.125, the minimum the manual documents and a value in no sample set. That is what
   * makes this a reading rather than a curve fit, so it is asserted first.
   */
  assert.equal(noteLengthSteps(0), 0.125, "the manual's documented minimum, predicted not fitted");
  const dialled: [number, number][] = [
    [0, 0.125], [30, 2], [46, 4], [62, 8], [78, 16], [94, 32], [110, 64], [126, 128],
    [38, 3], [54, 6], [70, 12], [86, 24], [102, 48], [118, 96],
  ];
  for (const [byte, steps] of dialled) {
    assert.equal(noteLengthSteps(byte), steps, `byte ${byte} should read ${steps} steps`);
  }
});

test("the step between values doubles every time the value doubles", () => {
  // Which is why the values available on the encoder change as you turn it — the thing that made
  // this look irregular before the bands were found.
  for (const [lo, expected] of [[0, 0.0625], [30, 0.125], [46, 0.25], [62, 0.5],
                                [78, 1], [94, 2], [110, 4]] as [number, number][]) {
    const step = noteLengthSteps(lo + 1)! - noteLengthSteps(lo)!;
    assert.equal(Number(step.toFixed(6)), expected, `band at byte ${lo}`);
  }
});

test("a gate is monotonic across the whole range, with no gaps or reversals", () => {
  // A lookup table that went backwards anywhere would make a note-length chart draw a gate ending
  // before it starts, and nothing else would notice.
  let previous = 0;
  for (let b = 0; b <= 126; b++) {
    const v = noteLengthSteps(b)!;
    assert.ok(v > previous, `byte ${b} gives ${v}, which is not above ${previous}`);
    previous = v;
  }
  assert.equal(noteLengthSteps(127), Infinity);
});
