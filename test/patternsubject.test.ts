/**
 * Reading a real pattern as an analysis subject.
 *
 * The producer is where the format meets the charts, so these run against **real projects**. A
 * synthetic image would test that the code does what it does; the whole risk here is what a
 * Digitone II actually stores, and only the corpus knows that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DN2_PROJECTS, NO_CORPUS, requireCorpusFile, requireCorpusFiles } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { readDn2Pattern } from "../src/project/dn2pattern.js";
import { DN1_DEVICE, DN2_DEVICE, deviceFor } from "../src/librarian/device.js";
import { patternSubject, PatternSubjectError } from "../web/src/patternsubject.js";
import {
  cycleSteps, harmonic, pitchByPreset, pitchWindows, playing, repeatSteps, trackWindows,
} from "../web/src/analysis/model.js";
import {
  densityBars, keyTimeline, phaseStrip, pitchBars, realignBars, trackTimeline,
} from "../web/src/analysis/charts.js";

const PROJECT = "012 TECNO_EXP.dn2prj";

function image(): Uint8Array {
  const path = requireCorpusFile(DN2_PROJECTS, PROJECT);
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

test("a Digitone 1 is refused rather than read with the wrong offsets", () => {
  // Walking DN2 offsets over DN1 bytes would draw charts of something that is not there, which is
  // worse than drawing nothing — the reader cannot tell a wrong number from a right one.
  assert.throws(
    () => patternSubject(new Uint8Array(16), DN1_DEVICE, 0),
    PatternSubjectError,
  );
});

test("a trigless lock trig is not a note", { skip: NO_CORPUS }, () => {
  /*
   * **The grid and the charts count different things, and both are right.**
   *
   * A slot reading "36 trigs" counts sequencer *records*; pattern A2 of this project is 8 note
   * trigs and 28 trigless lock trigs, which carry parameter automation and sound nothing. Counting
   * those as notes would put 28 phantom notes into the pitch histogram and the voice budget.
   */
  const img = image();
  const raw = readDn2Pattern(img, 1);
  const subject = patternSubject(img, DN2_DEVICE, 1);

  const records = raw.tracks.reduce((n, t) => n + t.trigs.length, 0);
  const notes = subject.tracks.reduce((n, t) => n + t.trigs.length, 0);
  assert.equal(records, 36, "the corpus pattern this asserts against has changed");
  assert.equal(notes, 8);
  assert.ok(
    raw.tracks.some((t) => t.trigs.some((g) => g.isLockTrig)),
    "this test is only meaningful on a pattern that has lock trigs",
  );
});

test("a trig with no velocity lock is read at its track default", { skip: NO_CORPUS }, () => {
  // Most trigs in the corpus carry no velocity lock of their own, so this is the normal case
  // rather than the edge one: reading `undefined` as 0 would silence most of a project.
  const img = image();
  const raw = readDn2Pattern(img, 0);
  const subject = patternSubject(img, DN2_DEVICE, 0);

  let checked = 0;
  for (const track of raw.tracks) {
    const out = subject.tracks[track.index]!;
    const notes = track.trigs.filter((g) => g.hasNote && g.notes.length > 0);
    notes.forEach((g, i) => {
      assert.equal(out.trigs[i]!.velocity, g.velocity ?? track.settings.defaultVelocity);
      if (g.velocity === undefined) checked++;
    });
  }
  assert.ok(checked > 0, "no trig in this pattern inherits its velocity, so this proved nothing");
});

test("per-track lengths are used only when the pattern says so", { skip: NO_CORPUS }, () => {
  /*
   * Every track record carries a length whether the pattern uses it or not. With SCALE set
   * per-pattern the sequencer plays every track at the master length and the stored per-track
   * values are leftovers, and drawing those would invent a polymeter the instrument is not
   * playing. Corpus-wide, 69% of the patterns that play something do have real per-track lengths,
   * so both branches are the normal case rather than one being an edge.
   */
  const img = image();
  let flat = 0, perTrack = 0;
  for (let index = 0; index < 16; index++) {
    const raw = readDn2Pattern(img, index);
    const subject = patternSubject(img, DN2_DEVICE, index);
    if (raw.perTrackScale) {
      perTrack++;
      for (const t of raw.tracks) {
        assert.equal(subject.tracks[t.index]!.length, t.length);
      }
    } else {
      flat++;
      for (const t of subject.tracks) assert.equal(t.length, raw.length);
    }
  }
  assert.ok(flat > 0 && perTrack > 0,
    `this project has ${flat} flat and ${perTrack} per-track patterns; the test needs both`);
});

test("a flat pattern has a cycle equal to its master length", { skip: NO_CORPUS }, () => {
  const img = image();
  for (let index = 0; index < 16; index++) {
    const raw = readDn2Pattern(img, index);
    if (raw.perTrackScale) continue;
    const subject = patternSubject(img, DN2_DEVICE, index);
    const live = playing(subject);
    if (live.length === 0) continue;
    assert.equal(cycleSteps(live), raw.length,
      `pattern ${index} has no per-track scale, so nothing can stretch its cycle`);
  }
});

test("gate length is declared unknown, because it is", { skip: NO_CORPUS }, () => {
  /*
   * The trig carries a note-length byte and nothing maps it to a duration —
   * `docs/dn2-pattern-format.md` marks even the name of the track default as inferred. Until a
   * capture settles it, voice pressure and overlap detection have no honest input, and the flag is
   * what stops a caller drawing them anyway.
   */
  const subject = patternSubject(image(), DN2_DEVICE, 0);
  assert.equal(subject.gateLengthKnown, false);
  for (const track of subject.tracks) {
    for (const trig of track.trigs) assert.equal(trig.length, 1);
  }
});

test("the accent threshold is read from the pattern", { skip: NO_CORPUS }, () => {
  /*
   * **100 is the device default, and it is not universal.** 1,712 of the 1,725 tracks that play a
   * note across the corpus read 100; the rest read 127, 102, 79 and 89. A first sample of four
   * projects showed 100 everywhere and would have justified a constant, which is why the threshold
   * is taken from each pattern's own tracks instead.
   */
  const img = image();
  for (let index = 0; index < 16; index++) {
    assert.equal(patternSubject(img, DN2_DEVICE, index).defaultVelocity, 100);
  }
});

test("a preset lock names a preset, and an unlocked trig does not", { skip: NO_CORPUS }, () => {
  const img = image();
  let locked = 0, plain = 0;
  for (let index = 0; index < 16; index++) {
    for (const track of patternSubject(img, DN2_DEVICE, index).tracks) {
      for (const trig of track.trigs) {
        if (trig.lockPreset === undefined) plain++;
        else {
          locked++;
          assert.notEqual(trig.lockPreset, "", "a lock resolving to an empty name is not a lock");
        }
      }
    }
  }
  assert.ok(plain > 0, "no unlocked trigs to compare against");
  assert.ok(locked > 0, `this project has no sound locks, so the resolver was never exercised`);
});

test("RESET is read only in per-track mode, and 1 is taken as INF", { skip: NO_CORPUS }, () => {
  /*
   * The stored field at pattern metadata `+0x14` is the **pattern length** in PER PATTERN mode and
   * the **RESET** in PER TRACK mode — the guidebook shows the PATTERN column carrying LENGTH and
   * SPEED in one and CHANGE and RESET in the other, with no pattern length in per-track mode at
   * all. Reading it as a reset in the wrong mode would cut every flat pattern to its own length,
   * which is harmless, and reading it as a length in per-track mode is what produced cycle figures
   * up to fifteen times too long.
   *
   * `1` meaning INF is the one guess left in this file and is unconfirmed on hardware — see
   * `Tests_To_Run.html` T41.
   */
  const img = image();
  let perTrackFinite = 0, perTrackInf = 0, flat = 0;
  for (let index = 0; index < DN2_DEVICE.patternCount; index++) {
    const raw = readDn2Pattern(img, index);
    const subject = patternSubject(img, DN2_DEVICE, index);
    if (!raw.perTrackScale) {
      flat++;
      assert.equal(subject.resetSteps, undefined,
        "per-pattern mode has no RESET; that field is the pattern length there");
    } else if (raw.length > 1) {
      perTrackFinite++;
      assert.equal(subject.resetSteps, raw.length);
    } else {
      perTrackInf++;
      assert.equal(subject.resetSteps, undefined, "1 is taken as INF");
    }
  }
  assert.ok(flat > 0 && perTrackFinite > 0,
    `needs both modes present; saw ${flat} flat and ${perTrackFinite} per-track`);
  void perTrackInf;
});

test("the corpus pattern that was overstated now reports what the device plays",
  { skip: NO_CORPUS }, () => {
    /*
     * `MORNING_JA 1640(2)` A2 has tracks of 16, 32, 62 and 64 steps — a 1,984-step polymeter, which
     * this page announced as 12 minutes 24 at its 40 BPM. RESET is 128. The device restarts every
     * track after 8 bars and the pattern repeats in 48 seconds.
     */
    const path = requireCorpusFile(DN2_PROJECTS, "MORNING_JA 1640(2).dn2prj");
    const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
    const subject = patternSubject(img, DN2_DEVICE, 1);
    const live = playing(subject);

    assert.deepEqual([...new Set(live.map((t) => t.length))].sort((a, b) => a - b), [16, 32, 62, 64]);
    assert.equal(cycleSteps(live), 1984, "the polymeter arithmetic");
    assert.equal(subject.resetSteps, 128);
    assert.equal(repeatSteps(live, subject.resetSteps), 128, "what the instrument actually plays");
  });

/* ---- the whole corpus, which is the only place these faults live ----------------------- */

test("a version we do not read is refused by version, not misread", { skip: NO_CORPUS }, () => {
  /*
   * **`PRESETS.dn2prj` is version 2 in all 128 of its pattern records** and every other DN2 project
   * we hold is version 3 — `device.ts` says so, and the grid already paints it as "storage version
   * we do not read".
   *
   * Reading one as version 3 does not fail. It produced 422 trigs on a pattern whose master length
   * read 0, tracks at speeds no table names, and default velocities of 3 and 255. Every one of
   * those numbers was fiction, and they polluted a corpus survey until this check existed.
   */
  const path = requireCorpusFile(DN2_PROJECTS, "PRESETS.dn2prj");
  const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
  let refused = 0;
  for (let index = 0; index < 128; index++) {
    assert.throws(
      () => patternSubject(img, DN2_DEVICE, index),
      (e: unknown) => e instanceof PatternSubjectError && /version 2/.test((e as Error).message),
    );
    refused++;
  }
  assert.equal(refused, 128, "every record in this project is an unreadable version");
});

test("every readable pattern in the corpus draws every chart without NaN", { skip: NO_CORPUS }, () => {
  /*
   * **The test that found the crash.** Rendering the corpus exhausted a 4 GB heap: a version-2
   * record read as version 3 gave a track length of 0, and `phaseStrip`'s repetition loop stepped
   * by zero forever. In a browser that is a frozen tab, and no unit test on synthetic data could
   * have produced it — the synthetic tracks always have a sane length because they were written to.
   *
   * `NaN`, `Infinity` and `undefined` are all checked because none of them throws. They reach the
   * SVG as an attribute value, the browser drops the mark, and the chart quietly draws less than
   * it should — which is the failure mode that hid the divide-by-zero in `realignBars` too.
   */
  const bad = /NaN|Infinity|undefined/;
  let charts = 0, patterns = 0, refusals = 0;

  for (const path of requireCorpusFiles(DN2_PROJECTS, ".dn2prj")) {
    const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
    if (deviceFor(img).kind !== "dn2") continue;
    for (let index = 0; index < DN2_DEVICE.patternCount; index++) {
      let subject;
      try { subject = patternSubject(img, DN2_DEVICE, index); }
      catch { refusals++; continue; }
      const live = playing(subject);
      if (!live.length) continue;
      patterns++;
      const cycle = cycleSteps(live);
      const tonal = harmonic(live);
      const keyWin = tonal.length ? pitchWindows(tonal, cycle, 16, 16) : [];
      const rows = tonal.length ? trackWindows(tonal, cycle, 16, 16, (i) => keyWin[i]?.fit) : [];
      const drawings = [
        phaseStrip(live, subject.masterLength, "velocity", subject.defaultVelocity, 900),
        phaseStrip(live, subject.masterLength, "locks", subject.defaultVelocity, 900),
        realignBars(live, cycle, 900),
        densityBars(live, subject.defaultVelocity, 900),
        pitchBars(pitchByPreset(live), 900),
        ...(keyWin.length ? [keyTimeline(keyWin, 900)] : []),
        ...(rows.length ? [trackTimeline(rows, 16, 900)] : []),
      ];
      for (const svg of drawings) {
        charts++;
        const m = svg.match(bad);
        assert.equal(m, null,
          `${path.split(/[\/]/).pop()} pattern ${index + 1} drew "${m?.[0]}"`);
      }
    }
  }
  assert.ok(patterns > 300, `only ${patterns} patterns rendered — the corpus is not being read`);
  assert.ok(charts > 2000, `only ${charts} charts drawn`);
  assert.ok(refusals > 0, "no pattern was refused, so the refusal path was never exercised");
});
