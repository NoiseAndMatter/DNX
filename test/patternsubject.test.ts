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
import { DN2_PROJECTS, NO_CORPUS, requireCorpusFile } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { readDn2Pattern } from "../src/project/dn2pattern.js";
import { DN1_DEVICE, DN2_DEVICE } from "../src/librarian/device.js";
import { patternSubject, PatternSubjectError } from "../web/src/patternsubject.js";
import { cycleSteps, playing } from "../web/src/analysis/model.js";

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
  // 599 of the 695 trigs measured across four projects carry no lock of their own, so this is the
  // normal case rather than the edge one: reading `undefined` as 0 would silence most of a project.
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
   * per-pattern — 51 of the 64 corpus patterns measured — the sequencer plays every track at the
   * master length, and the stored per-track values are leftovers. Drawing those would invent a
   * polymeter the instrument is not playing.
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

test("the accent threshold is read from the pattern, and it is 100", { skip: NO_CORPUS }, () => {
  // Measured: every one of the 1,024 tracks across four corpus projects carries a default velocity
  // of exactly 100. The mockup assumed that number; this is the reading that confirms it.
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
