/**
 * Reading a real Digitone 1 pattern as an analysis subject.
 *
 * Against real projects, for the reason `patternsubject.test.ts` gives: the risk here is not what
 * the code does with bytes it was handed, it is what a Digitone 1 actually stores.
 *
 * The producer's own rule is what most of these check. It reports what the format supports and
 * says so where it does not — no gate lengths, no speed multiplier, no RESET — and the value of
 * the feature is exactly that those absences survive contact with 53 real projects.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DN1_PROJECTS, NO_CORPUS, corpusFiles, requireCorpusFile } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN1_DEVICE, DN2_DEVICE } from "../src/librarian/device.js";
import { MACHINE } from "../src/project/machine.js";
import { readPattern } from "../src/project/dn1.js";
import { dn1PatternSubject } from "../web/src/dn1subject.js";
import { PatternSubjectError } from "../web/src/patternsubject.js";
import { playing, trackLabel } from "../web/src/analysis/model.js";

const PROJECT = "002 MORNING_JAM.dnprj";

function imageOf(name: string): Uint8Array {
  const path = requireCorpusFile(DN1_PROJECTS, name);
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

test("a Digitone II is refused rather than read with the wrong offsets", () => {
  // The mirror of the guard in the other producer, and for the same reason: a subject drawn from
  // the wrong family's offsets is not a wrong chart, it is a chart of nothing.
  assert.throws(() => dn1PatternSubject(new Uint8Array(16), DN2_DEVICE, 0), PatternSubjectError);
});

test("a pattern reads as eight tracks, four of them MIDI named A to D", { skip: NO_CORPUS }, () => {
  /*
   * **The MIDI tracks are the reason `AnalysisTrack.label` exists.** The instrument calls them A,
   * B, C and D; every chart used to print `T` and the track number, which would have put "T5" on
   * screen for a track the Digitone 1 has never called that.
   */
  const subject = dn1PatternSubject(imageOf(PROJECT), DN1_DEVICE, 0);
  assert.equal(subject.tracks.length, 8);
  assert.deepEqual(subject.tracks.map(trackLabel), ["T1", "T2", "T3", "T4", "A", "B", "C", "D"]);
  const expected: number[] = [
    MACHINE.fmTone, MACHINE.fmTone, MACHINE.fmTone, MACHINE.fmTone,
    MACHINE.midi, MACHINE.midi, MACHINE.midi, MACHINE.midi,
  ];
  assert.deepEqual(subject.tracks.map((t) => t.machine), expected);
});

test("the subject carries the Digitone 1's eight voices, not the Digitone II's sixteen",
  { skip: NO_CORPUS }, () => {
    const subject = dn1PatternSubject(imageOf(PROJECT), DN1_DEVICE, 0);
    assert.equal(subject.voiceBudget, 8);
  });

test("no gate is claimed, because the note-length byte has never been captured",
  { skip: NO_CORPUS }, () => {
    /*
     * The Digitone II's table was measured against the instrument on 2026-09-06; the Digitone 1's
     * is listed UNKNOWN in `docs/dn1-project-format.md`. Until somebody reads known note lengths
     * back off a Digitone 1, every gate here is a placeholder and the subject has to say so, or
     * the voice pressure card draws a fabricated number that looks exactly like a measured one.
     */
    const subject = dn1PatternSubject(imageOf(PROJECT), DN1_DEVICE, 0);
    assert.equal(subject.gateLengthKnown, false);
    for (const track of subject.tracks) {
      for (const trig of track.trigs) assert.equal(trig.length, 1);
    }
  });

test("no speed multiplier is claimed either", { skip: NO_CORPUS }, () => {
  // `+0x0D` is SPECULATIVE: six values seen where the instrument offers seven settings, and the
  // mapping is a guess. `undefined` is the subject's word for an enum nothing has named.
  const subject = dn1PatternSubject(imageOf(PROJECT), DN1_DEVICE, 0);
  for (const track of subject.tracks) assert.equal(track.speed, undefined);
});

test("a chord's offsets become absolute notes, and a padding zero is not a unison",
  { skip: NO_CORPUS }, () => {
    /*
     * The Digitone 1 stores a chord as a root plus signed semitone offsets, where the Digitone II
     * stores absolute notes. Reading the offsets as notes would put every chord down near MIDI 0.
     */
    const image = imageOf(PROJECT);
    const subject = dn1PatternSubject(image, DN1_DEVICE, 0);
    const pattern = readPattern(image, 0);

    let checked = 0;
    for (const track of pattern.tracks) {
      const out = subject.tracks[track.index]!;
      for (const trig of track.trigs) {
        if (!trig.hasNote || trig.note === undefined) continue;
        const drawn = [...out.trigs, ...(out.dormant ?? [])].find((t) => t.step === trig.step);
        if (!drawn) continue;
        assert.equal(drawn.notes[0], trig.note, "the root comes first");
        const extra = trig.chord.filter((o) => o !== 0);
        assert.equal(drawn.notes.length, 1 + extra.length, "one note per non-zero offset");
        for (const note of drawn.notes) assert.ok(note >= 0 && note <= 127);
        checked += 1;
      }
    }
    assert.ok(checked > 0, "MORNING_JAM A1 has no note trigs; pick another pattern");
  });

test("trigs past the end of a track are held apart from the ones that play",
  { skip: NO_CORPUS }, () => {
    // The same split the Digitone II producer makes. Counting them among the playing trigs
    // overstates the note count and the pitch content of the pattern.
    const image = imageOf(PROJECT);
    for (let slot = 0; slot < 16; slot++) {
      const subject = dn1PatternSubject(image, DN1_DEVICE, slot);
      for (const track of subject.tracks) {
        for (const trig of track.trigs) assert.ok(trig.step < track.length);
        for (const trig of track.dormant ?? []) assert.ok(trig.step >= track.length);
      }
    }
  });

test("every Digitone 1 project in the corpus produces a drawable subject",
  { skip: NO_CORPUS }, () => {
    /*
     * **The test that would have caught the Digitone II's own worst bug.** `PRESETS.dn2prj` read
     * back as 422 trigs on a pattern of length 0 and exhausted a 4 GB heap in a chart, and it was
     * rendering the whole corpus that found it. Every chart here divides by a length, so a length
     * of zero reaching one is the failure that matters.
     */
    const files = corpusFiles(DN1_PROJECTS, ".dnprj");
    assert.ok(files.length >= 50, `expected the DN1 corpus, found ${files.length} files`);

    let withNotes = 0;
    for (const path of files) {
      const image = decodeProjectImage(
        parseProject(new Uint8Array(readFileSync(path))).payload.raw,
      ).image;
      for (let slot = 0; slot < DN1_DEVICE.patternCount; slot++) {
        const subject = dn1PatternSubject(image, DN1_DEVICE, slot);
        assert.ok(subject.masterLength >= 1 && subject.masterLength <= 64,
          `${path} ${slot}: master length ${subject.masterLength}`);
        assert.ok(subject.tempo > 0, `${path} ${slot}: tempo ${subject.tempo}`);
        for (const track of subject.tracks) {
          assert.ok(track.length >= 1 && track.length <= 64,
            `${path} ${slot} ${trackLabel(track)}: length ${track.length}`);
        }
        if (playing(subject).length > 0) withNotes += 1;
      }
    }
    assert.ok(withNotes > 0, "not one pattern in the DN1 corpus plays a note; the reader is wrong");
  });
