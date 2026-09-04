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
  trackWindows, voicesPerStep,
  type AnalysisSubject, type AnalysisTrack, type AnalysisTrig,
} from "../web/src/analysis/model.js";
import { MACHINE } from "../src/project/machine.js";

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
    label: "x", tempo: 120, masterLength: 16, voiceBudget: 16, defaultVelocity: 100,
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

const PURE = ["charts", "model"] as const;

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
