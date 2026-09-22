/**
 * The arpeggiator, and what it does to a pattern's pitch.
 *
 * Two kinds of test here. The first reads the **hardware captures** in the corpus: fourteen
 * presets saved from one baseline with a single control moved each time, which is what named the
 * fields in the first place. The second pins the **consequence** — that an arped track's offsets
 * reach the key fit, and that they stay out of the voice budget.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ARP, arpIntervals, readArp } from "@noiseandmatter/dnx-core/project/arp.js";
import {
  type AnalysisSubject, type AnalysisTrack, type AnalysisTrig, fitKey, harmonic, pitchByPreset,
  pitchWindows, sounded, voicesPerStep,
} from "@noiseandmatter/dnx-core/analysis/model.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const CAPTURES = "99_HardwareTest/arp-dn2-2026-09-16";

/** A capture from the corpus, or `undefined` when the corpus is not on this machine. */
function capture(name: string): Uint8Array | undefined {
  if (NO_CORPUS) return undefined;
  return new Uint8Array(readFileSync(join(CORPUS!, "..", CAPTURES, name)));
}

/* ---- the format, against the instrument ----------------------------------------------- */

test("a short sound object has no arp region, rather than one that is switched off",
  { skip: NO_CORPUS && SKIP_REASON }, () => {
  /*
   * `ARP BASE` is a version-0 object: 319 bytes of content, terminator at 315, which is **exactly
   * where MODE would begin**. Reading its zero at 331 as `MODE = OFF` would be reading padding
   * past the end of the object and reporting it as a setting.
   */
  const base = capture("H131_ARP_BASE_359B.bin");
  if (!base) return;
  assert.equal(readArp(base), undefined);
});

test("each control moved by one step moved exactly one field",
  { skip: NO_CORPUS && SKIP_REASON }, () => {
  const one = (file: string) => readArp(capture(file)!)!;

  const off = one("H136_MODE_OFF_359B.bin");
  assert.deepEqual(
    { mode: off.mode, speed: off.speed, range: off.range, noteLength: off.noteLength,
      length: off.length },
    { mode: 0, speed: 13, range: 0, noteLength: 14, length: 16 },
    "the baseline every other capture is one step from",
  );

  assert.equal(one("H137_SPD_359B.bin").speed, 14, "SPD");
  assert.equal(one("H138_RNG_359B.bin").range, 1, "RNG");
  assert.equal(one("H139_NLEN_359B.bin").noteLength, 15, "N.LEN");
  assert.equal(one("H140_LEN_359B.bin").length, 15, "LEN, stored zero-based");

  // MODE 0..4 against the instrument's five menu entries, and the firmware's own 0..4 clamp.
  assert.deepEqual(
    ["H136_MODE_OFF_359B.bin", "H132_ARP_MODE_B_359B.bin", "H133_ARP_MODE_C_359B.bin",
     "H134_ARP_MODE_D_359B.bin", "H135_ARP_MODE_E_359B.bin"].map((f) => one(f).modeName),
    ["OFF", "TRUE", "UP", "DOWN", "CYCL"],
  );
});

test("the enable mask runs LSB first, so bit 0 is step 1",
  { skip: NO_CORPUS && SKIP_REASON }, () => {
  const off1 = readArp(capture("H141_STEP1_OFF_359B.bin")!)!;
  assert.equal(off1.steps[0]!.on, false, "step 1 is the one switched off");
  assert.ok(off1.steps.slice(1).every((s) => s.on), "and nothing else moved");

  /*
   * **The bit and the byte index the same step independently.** This capture has step 1 off *and*
   * step 2 at +7, which is what separates "off" from "on at zero semitones": both store `0x00` in
   * the offset map, and only the mask tells them apart.
   */
  const both = readArp(capture("H144_STEP1_OFF_STEP2_PLUS7_359B.bin")!)!;
  assert.deepEqual(both.steps.slice(0, 2), [{ on: false, offset: 0 }, { on: true, offset: 7 }]);
});

test("offsets are two's complement, confirmed in both directions",
  { skip: NO_CORPUS && SKIP_REASON }, () => {
  assert.equal(readArp(capture("H142_STEP1_PLUS7_359B.bin")!)!.steps[0]!.offset, 7);
  assert.equal(readArp(capture("H143_STEP1_MINUS7_359B.bin")!)!.steps[0]!.offset, -7);
});

/** A synthetic sound object carrying an arp region, for the cases no capture covers. */
function withArp(fields: { mode: number; length: number; enable: number; offsets: number[] }) {
  const sound = new Uint8Array(359);
  sound.set([0xba, 0xce, 0xf0, 0x0c], ARP.terminatorOffset);
  sound[ARP.modeOffset] = fields.mode;
  sound[ARP.lengthOffset] = fields.length - 1;
  sound[ARP.enableOffset] = (fields.enable >> 8) & 0xff;
  sound[ARP.enableOffset + 1] = fields.enable & 0xff;
  fields.offsets.forEach((v, i) => { sound[ARP.offsetsOffset + i] = v & 0xff; });
  return sound;
}

test("the table is read to LEN, never to the end", () => {
  /*
   * **The instrument keeps per-step state past the current LEN**, exactly as a shortened track
   * keeps the trigs on the pages it dropped: 60 of the 333 engaged tracks in the corpus carry
   * some. Reading all sixteen would add pitch classes the sequencer never sounds.
   */
  const arp = readArp(withArp({
    mode: 2, length: 4, enable: 0xffff,
    offsets: [0, 7, 0, 0, 0, 0, 0, 0, 0, 11],
  }))!;
  assert.equal(arp.steps.length, 4);
  assert.deepEqual(arpIntervals(arp), [0, 7], "the 11 is stored, and never sounds");
});

test("a switched-off step is skipped even though its offset is stored", () => {
  // Step 2 is off. Its +7 stays in the object and must not reach the pitch content.
  const arp = readArp(withArp({ mode: 1, length: 4, enable: 0xfffd, offsets: [0, 7, 3, 0] }))!;
  assert.deepEqual(arpIntervals(arp), [0, 3]);
});

test("an arp that is off contributes nothing, even with offsets stored", () => {
  // Switching the arp off leaves the offsets behind; 81 corpus records are in exactly this state.
  const arp = readArp(withArp({ mode: 0, length: 16, enable: 0xffff, offsets: [7] }))!;
  assert.equal(arp.steps[0]!.offset, 7, "the state is still readable");
  assert.deepEqual(arpIntervals(arp), [], "and none of it sounds");
});

/* ---- the consequence, in the analysis -------------------------------------------------- */

function track(over: Partial<AnalysisTrack> = {}): AnalysisTrack {
  return { number: 1, length: 16, speed: 1, preset: "P", trigs: [], ...over };
}

function trig(step: number, notes: number[]): AnalysisTrig {
  return { step, notes, velocity: 100, length: 1, microTiming: 0 };
}

test("a note is sounded at every live arp offset", () => {
  const t = track({ trigs: [trig(0, [60])], arpIntervals: [0, 4, 7] });
  assert.deepEqual([...sounded(t, t.trigs[0]!)], [60, 64, 67]);
});

test("a track with no arp hands back exactly what is written", () => {
  const t = track({ trigs: [trig(0, [60, 64])] });
  assert.equal(sounded(t, t.trigs[0]!), t.trigs[0]!.notes, "the same array, not a copy of it");
});

test("a one-note track becomes harmonic when its arp moves the pitch", () => {
  /*
   * The point of the whole change. This track writes one note on every trig, so by the written
   * notes it has a single pitch class and `harmonic` drops it, taking a major triad's worth of
   * pitch out of the key fit with it.
   */
  const plain = track({ trigs: [trig(0, [60]), trig(4, [60])] });
  assert.deepEqual(harmonic([plain]), [], "one written pitch class, so no harmony");

  const arped = { ...plain, arpIntervals: [0, 4, 7] };
  assert.deepEqual(harmonic([arped]), [arped], "three sounded pitch classes, so it has harmony");
});

test("the arped pitches reach the pitch table and the key fit", () => {
  const t = track({ trigs: [trig(0, [60])], arpIntervals: [0, 4, 7] });

  assert.deepEqual(
    pitchByPreset([t]).filter((c) => c.total).map((c) => c.name).sort(),
    ["C", "E", "G"],
    "one written C sounds a C major triad",
  );

  const counts = pitchWindows([t], 16, 16, 16)[0]!.counts;
  assert.equal(counts[0], 1, "C");
  assert.equal(counts[4], 1, "E");
  assert.equal(counts[7], 1, "G");
});

test("the arp stays out of the voice budget", () => {
  /*
   * **Deliberate, and the reason is in `sounded`.** An arp spreads a chord across time rather than
   * stacking it, so it moves the voice count in a direction that needs the arp's timing to
   * compute, and `SPD`'s units have never been measured. One trig holds one voice here whatever
   * the arp does; a six would be a fabricated number wearing a chart.
   */
  const t = track({ trigs: [trig(0, [60])], arpIntervals: [0, 4, 7], length: 4 });
  assert.deepEqual(voicesPerStep([t], 4), [1, 0, 0, 0]);
});

test("a subject that cannot read an arp still fits a key, and says which it is", () => {
  // `arpKnown` is required on the interface, so a new producer cannot quietly forget to answer it.
  const subject: AnalysisSubject = {
    label: "A1", tempo: 120, masterLength: 16, perTrackLengths: false, voiceBudget: 8,
    defaultVelocity: 100, gateLengthKnown: true, patternTimingKnown: false, arpKnown: false,
    tracks: [track({ trigs: [trig(0, [60]), trig(4, [64]), trig(8, [67])] })],
  };
  assert.equal(subject.arpKnown, false);
  assert.ok(fitKey(pitchWindows(subject.tracks, 16, 16, 16)[0]!.counts).name.length > 0);
});
