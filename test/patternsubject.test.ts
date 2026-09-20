/**
 * Reading a real pattern as an analysis subject.
 *
 * The producer is where the format meets the charts, so these run against **real projects**. A
 * synthetic image would test that the code does what it does; the whole risk here is what a
 * Digitone II actually stores, and only the corpus knows that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";
import { DN2_PROJECTS, NO_CORPUS, requireCorpusFile, requireCorpusFiles } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { readDn2Pattern } from "../src/project/dn2pattern.js";
import { DN1_DEVICE, DN2_DEVICE, deviceFor } from "../src/librarian/device.js";
import { noteLengthSteps } from "../src/project/dn2pattern.js";
import { patternSubject, PatternSubjectError } from "../src/analysis/patternsubject.js";
import {
  cycleSteps,
  drawableWindow, harmonic, pitchByPreset, pitchWindows, playing, repeatSteps, trackWindows,
} from "../src/analysis/model.js";
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
    // Matched on step rather than position: the subject drops the trigs stored past the end of
    // the track, so the two lists are the same order and not the same length.
    const notes = track.trigs.filter((g) => g.hasNote && g.notes.length > 0 && g.step < out.length);
    for (const g of notes) {
      const read = out.trigs.find((t) => t.step === g.step);
      assert.ok(read, `T${out.number} step ${g.step + 1} is within its length and was not read`);
      assert.equal(read.velocity, g.velocity ?? track.settings.defaultVelocity);
      if (g.velocity === undefined) checked++;
    }
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

test("gate length is known, and every gate is a real duration", { skip: NO_CORPUS }, () => {
  /*
   * **This test asserted the opposite until 2026-09-06**, and it was right to: nothing mapped the
   * note-length byte to a duration, so voice pressure and overlap detection had no honest input and
   * the flag is what stopped a caller drawing them anyway.
   *
   * The byte was then captured against the instrument — `dn2-pattern-format.md` §3.3 — so the flag
   * flips and the charts draw. Every gate must now be a positive number of steps or `Infinity`,
   * which is the INF setting and a real one.
   */
  const subject = patternSubject(image(), DN2_DEVICE, 0);
  assert.equal(subject.gateLengthKnown, true);
  for (const track of subject.tracks) {
    for (const trig of track.trigs) {
      assert.ok(trig.length > 0, `T${track.number} step ${trig.step} has a gate of ${trig.length}`);
      assert.ok(!Number.isNaN(trig.length), "a NaN gate would silently empty every voice chart");
    }
  }
});

test("a trig with no length of its own inherits the track default", { skip: NO_CORPUS }, () => {
  /*
   * `0xFF` is the most common value in the whole corpus — 10,424 of the note trigs — so this is the
   * ordinary case, not the edge one. The default byte `0x0E` decodes to exactly **1 step**, which
   * is the quiet corroboration that the table is right: a wrong table would not put the value the
   * device uses everywhere on a round number.
   */
  assert.equal(noteLengthSteps(0x0e), 1);
  assert.equal(noteLengthSteps(0xff), undefined, "no lock — the caller must fall back");
  assert.equal(noteLengthSteps(0x7f), Infinity, "INF is a setting, not an error");
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

test("a version-2 project reads, and reads correctly", { skip: NO_CORPUS }, () => {
  /*
   * **This test asserted the opposite until 2026-09-06.** `PRESETS.dn2prj` is version 2 in all 128
   * of its records, and reading one as version 3 does not fail — it produced 422 trigs on a pattern
   * whose master length read 0, at speeds no table names. Refusing was right while that was all we
   * knew.
   *
   * Version 2 is now decoded: a version-3 record with a 31-byte track settings block, normalised on
   * read (`dn2-pattern-format.md` §3.5). It is the **factory presets project on every Digitone II**,
   * so refusing it was refusing the first file a new owner opens.
   *
   * The assertions are the ones an off-by-64 could not satisfy: real names, sane lengths, and trigs
   * whose steps fall inside the pattern.
   */
  const path = requireCorpusFile(DN2_PROJECTS, "PRESETS.dn2prj");
  const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
  let playing = 0;
  for (let index = 0; index < 128; index++) {
    const subject = patternSubject(img, DN2_DEVICE, index);
    /*
     * **1..128 in both modes, since 2026-09-06.** `+0x14` is the pattern length in PER PATTERN mode
     * and the RESET in PER TRACK, and `masterLength` used to carry the raw field either way — so
     * PER TRACK patterns reported a 1-step "master length" when RESET was INF, and values above
     * 128 otherwise. It is now the pattern length or the longest track pass, and both are
     * sequencer steps.
     */
    assert.ok(subject.masterLength >= 1 && subject.masterLength <= 128,
      `${subject.label} has a master length of ${subject.masterLength}`);
    assert.ok(subject.tempo > 0 && subject.tempo < 1000, `${subject.label} tempo ${subject.tempo}`);
    for (const track of subject.tracks) {
      assert.ok(track.length >= 1 && track.length <= 128, `${subject.label} T${track.number} len`);
      for (const trig of track.trigs) {
        assert.ok(trig.step >= 0 && trig.step < 128, `${subject.label} step ${trig.step}`);
      }
    }
    if (subject.tracks.some((t) => t.trigs.length)) playing++;
  }
  assert.equal(playing, 33, "the factory project ships 33 demo patterns");
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
      // Bounded exactly as the page bounds it. A pattern whose tracks never come round saturates
      // the cycle, and windowing a million steps per bar is what turned this sweep into eight
      // minutes the moment version-2 projects became readable.
      const drawn = drawableWindow(cycle).steps;
      const keyWin = tonal.length ? pitchWindows(tonal, drawn, 16, 16) : [];
      const rows = tonal.length ? trackWindows(tonal, drawn, 16, 16, (i) => keyWin[i]?.fit) : [];
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
  /*
   * **The refusal path moved rather than vanished.** Every DN2 record in the corpus is version 2 or
   * 3 and both now read, so this sweep no longer refuses anything — which is the point of the
   * change. The refusal is still exercised, by the Digitone 1 test above and by a record at a
   * version neither table names.
   */
  assert.equal(refusals, 0, "every DN2 record in the corpus is a version we read");
});

test("trigs past the end of a track are held apart, not counted", { skip: NO_CORPUS }, () => {
  /*
   * **The device keeps the trigs when you shorten a track, and never plays them.** Confirmed at
   * the instrument on 2026-09-06: `MORNING_JAM` A4 T1 is 16 steps and expanding its LEN reveals
   * notes on 33, 37, 41 and 45, which are in the file and silent until it is expanded.
   *
   * A reader that counts those counts music nobody hears. 7,543 of them sit across 521 tracks of
   * the corpus, so this is the normal condition of a project rather than a curiosity.
   */
  const path = requireCorpusFile(DN2_PROJECTS, "MORNING_JAM.dn2prj");
  const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
  const subject = patternSubject(img, DN2_DEVICE, 3);
  const t1 = subject.tracks[0]!;

  assert.equal(t1.length, 16, "the corpus pattern this asserts against has changed");
  assert.deepEqual((t1.dormant ?? []).map((g) => g.step + 1), [33, 37, 41, 45]);
  assert.ok(t1.trigs.every((g) => g.step < 16), "a trig the sequencer never reaches is not playing");

  // The raw record holds both sets, which is what makes the split a decision rather than a filter
  // applied by the format.
  const raw = readDn2Pattern(img, 3);
  const notes = raw.tracks[0]!.trigs.filter((g) => g.hasNote && g.notes.length > 0);
  assert.equal(notes.length, t1.trigs.length + 4);
});

test("every subject holds its trigs inside the track length", { skip: NO_CORPUS }, () => {
  // A dormant trig reaching `trigs` would inflate the note count, the voice pressure and the pitch
  // histogram of the pattern holding it, and nothing downstream re-checks the step against the
  // length. Swept over a whole project rather than one pattern.
  const img = image();
  for (let index = 0; index < 128; index++) {
    const subject = patternSubject(img, DN2_DEVICE, index);
    for (const track of subject.tracks) {
      for (const trig of track.trigs) {
        assert.ok(trig.step < track.length,
          `${subject.label} T${track.number} is ${track.length} steps and plays step ${trig.step + 1}`);
      }
    }
  }
});

test("the first step past the end is dormant, not the last one that plays", { skip: NO_CORPUS }, () => {
  /*
   * **The boundary, on real music.** A track of LEN 16 walks step 1 to step 16, which are trig
   * indices 0 to 15. A trig at index 16 is step 17: the first one the sequencer never reaches.
   * Off by one here moves a note from silent to sounding and nothing downstream would notice.
   *
   * `006 GLITCH_EXPLORE` B1 T2 is 16 steps and carries one there.
   */
  const path = requireCorpusFile(DN2_PROJECTS, "006 GLITCH_EXPLORE.dn2prj");
  const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
  const t2 = patternSubject(img, DN2_DEVICE, 16).tracks[1]!;

  assert.equal(t2.length, 16, "the corpus pattern this asserts against has changed");
  assert.ok((t2.dormant ?? []).some((g) => g.step === 16), "step 17 is past the end of 16 steps");
  assert.ok(t2.trigs.some((g) => g.step === 15), "step 16 is the last one that plays");
  assert.ok(!t2.trigs.some((g) => g.step === 16));
});

test("a per-track pattern has no master length, and does not report the reset as one",
  { skip: NO_CORPUS }, () => {
  /*
   * **`+0x14` is the pattern LENGTH in PER PATTERN mode and the RESET in PER TRACK mode**, and this
   * reader used to hand over the raw field in both. The consequences were on the page: 49 of the
   * 829 playing patterns in the corpus reported a **master length of 1 step**, because RESET at INF
   * stores `1`, and 22 more reported a value above the 128 a pattern length can hold. `PRESETS` A5
   * printed "MASTER LENGTH 512 steps" beside "PATTERN RESET 512 steps" — one field, twice.
   *
   * A one-step window is not only a wrong label. It is what `pitchWindows` was given to fit a key
   * in.
   */
  const path = requireCorpusFile(DN2_PROJECTS, "PRESETS.dn2prj");
  const img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;

  let perTrack = 0, flat = 0;
  for (let index = 0; index < 128; index++) {
    const raw = readDn2Pattern(img, index);
    const subject = patternSubject(img, DN2_DEVICE, index);
    assert.equal(subject.perTrackLengths, raw.perTrackScale);

    if (raw.perTrackScale) {
      perTrack++;
      // The longest track pass: the shortest window in which every track completes at least once.
      const longest = Math.max(...subject.tracks.map((t) => t.length));
      assert.equal(subject.masterLength, longest,
        `${subject.label} should draw over its longest track, not over the RESET field`);
      // Not asserted as *different* from the raw field: a per-track pattern may have a longest
      // track of 128 under a RESET of 128, and the two coinciding is not the bug.
      assert.ok(subject.masterLength <= 128, `${subject.label} draws over ${subject.masterLength}`);
    } else {
      flat++;
      assert.equal(subject.masterLength, raw.length, "PER PATTERN keeps the pattern's own length");
    }
  }
  assert.ok(perTrack > 0 && flat > 0,
    `this project has ${flat} flat and ${perTrack} per-track patterns; the test needs both`);
});

test("no pattern in the corpus draws over a window of one step", { skip: NO_CORPUS }, () => {
  // The failure this guards is silent: a one-step window produces a key fit over one note and a
  // beat view with a single column, both of which render without complaining.
  for (const path of requireCorpusFiles(DN2_PROJECTS, ".dn2prj")) {
    let img: Uint8Array;
    try {
      img = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
      if (deviceFor(img).kind !== "dn2") continue;
    } catch { continue; }
    for (let index = 0; index < 128; index++) {
      let subject;
      try { subject = patternSubject(img, DN2_DEVICE, index); } catch { continue; }
      if (playing(subject).length === 0) continue;
      assert.ok(subject.masterLength > 1,
        `${basename(path)} ${subject.label} draws over ${subject.masterLength} step`);
    }
  }
});
