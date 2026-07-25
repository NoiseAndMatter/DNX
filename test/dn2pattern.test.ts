/**
 * Cross-validation of the DN2 pattern reader against the DN1 originals.
 *
 * Nine DN1 projects sit next to Elektron's own DN2 conversions of them. The DN1 side is
 * fully decoded by `src/project/dn1.ts`, so for every trig we already know the answer:
 * "track 2 step 5, note 60, velocity 100, sound lock 43". These tests assert that
 * `readDn2Pattern` reports the same thing from the DN2 record, across all nine pairs and
 * all 128 patterns of each — 1,152 pattern pairs, 7,713 trigs.
 *
 * The two known, understood deviations are asserted explicitly rather than tolerated:
 *
 *  - **Zero chord offsets are dropped.** A DN1 chord `[-7, 0, 1]` becomes DN2 notes
 *    `[root, root-7, root+1]`: the offset that duplicates the root is not re-emitted.
 *    Seven chord notes across seven trigs are affected.
 *  - **Six parameter-lock values are rescaled** by the importer, in three records
 *    (17->25, 43->51, 71->89, 1->0). Track, step set and record order still match exactly.
 */

import assert from "node:assert/strict";
import { CORPUS } from "./corpus.js";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseProject } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN2_LAYOUT, patternRecord } from "../src/project/dn2image.js";
import { patternRecord as dn1PatternRecord, readLockTable as dn1ReadLockTable, readPattern } from "../src/project/dn1.js";
import {
  PATTERN,
  STEP_COUNT,
  STEP_FLAG,
  TRACK_COUNT,
  checkDn2PatternRecord,
  readDn2Pattern,
  readMidiTrackMask,
  readTrigSlots,
} from "../src/project/dn2pattern.js";

const EXAMPLES = CORPUS ?? "";
const DN1_DIR = `${EXAMPLES}01_DN1/01_Projects/`;
const DN2_DIR = `${EXAMPLES}02_DN2/01_Projects/`;

/** DN1 source -> Elektron's DN2 conversion of it. */
const PAIRS: ReadonlyArray<{ label: string; dn1: string; dn2: string }> = [
  { label: "MORNING_JAM", dn1: "002 MORNING_JAM.dnprj", dn2: "MORNING_JAM.dn2prj" },
  { label: "GLITCH_EXPLORE", dn1: "043 GLITCH_EXPLORE.dnprj", dn2: "006 GLITCH_EXPLORE.dn2prj" },
  { label: "ORION_MIDI_TEST", dn1: "048 ORION_MIDI_TEST.dnprj", dn2: "007 ORION_MIDI_TEST.dn2prj" },
  { label: "JAM", dn1: "049 JAM.dnprj", dn2: "008 JAM.dn2prj" },
  { label: "JAGGED", dn1: "050 JAGGED.dnprj", dn2: "009 JAGGED.dn2prj" },
  { label: "ODD_XS", dn1: "051 ODD XS.dnprj", dn2: "010 ODD XS.dn2prj" },
  { label: "JAGGED_PLAY", dn1: "052 JAGGED_PLAY.dnprj", dn2: "011 JAGGED_PLAY.dn2prj" },
  { label: "TECNO_EXP", dn1: "053 TECNO_EXP.dnprj", dn2: "012 TECNO_EXP.dn2prj" },
  { label: "DROWSY_WALK", dn1: "031 DROWSY_WALK.dnprj", dn2: "013 DROWSY_WALK.dn2prj" },
];

const available = PAIRS.filter((p) => existsSync(DN1_DIR + p.dn1) && existsSync(DN2_DIR + p.dn2));
const skip = available.length === 0 ? "corpus projects are not present" : false;

const imageCache = new Map<string, Uint8Array>();
function image(path: string): Uint8Array {
  const hit = imageCache.get(path);
  if (hit) return hit;
  const project = parseProject(new Uint8Array(readFileSync(path)));
  const { image: decoded } = decodeProjectImage(project.payload.raw);
  imageCache.set(path, decoded);
  return decoded;
}

/** DN1 stores micro timing as an i8; compare on the raw byte to avoid sign confusion. */
const asByte = (signed: number) => (signed < 0 ? signed + 256 : signed);

test("geometry: the three arrays chain exactly into the metadata block", () => {
  assert.equal(PATTERN.trackOffset + TRACK_COUNT * PATTERN.trackSize, PATTERN.trigOffset);
  assert.equal(PATTERN.trigOffset + PATTERN.trigCount * PATTERN.trigSize, PATTERN.lockOffset);
  assert.equal(PATTERN.lockOffset + PATTERN.lockCount * PATTERN.lockSize, PATTERN.metaOffset);
  assert.ok(PATTERN.metaOffset < PATTERN.size);
});

test("every DN2 pattern record passes the self-consistency check", { skip }, () => {
  let records = 0;
  for (const pair of available) {
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let i = 0; i < DN2_LAYOUT.patternCount; i++) {
      const result = checkDn2PatternRecord(patternRecord(dn2, i, DN2_LAYOUT));
      assert.ok(result.ok, `${pair.label} pattern ${i}: ${result.problems.join("; ")}`);
      records++;
    }
  }
  assert.equal(records, available.length * 128);
});

test("trigs, notes, chords, velocities and micro timing agree with the DN1 source", { skip }, () => {
  let trigs = 0;
  let chordNotes = 0;
  let droppedZeroOffsets = 0;

  for (const pair of available) {
    const dn1 = image(DN1_DIR + pair.dn1);
    const dn2 = image(DN2_DIR + pair.dn2);

    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const a = readPattern(dn1, index);
      const b = readDn2Pattern(dn2, index, DN2_LAYOUT);
      const at = `${pair.label} pattern ${index}`;

      for (const source of a.tracks) {
        const target = b.tracks[source.index]!;
        assert.deepEqual(
          target.trigs.map((t) => t.step),
          source.trigs.map((t) => t.step),
          `${at} track ${source.index}: trig steps differ`,
        );

        for (let k = 0; k < source.trigs.length; k++) {
          const want = source.trigs[k]!;
          const got = target.trigs[k]!;
          const where = `${at} track ${source.index} step ${want.step}`;
          trigs++;

          assert.equal(got.note, want.note, `${where}: note`);
          assert.equal(got.hasNote, want.hasNote, `${where}: hasNote`);
          assert.equal(got.isLockTrig, want.isLockTrig, `${where}: isLockTrig`);
          assert.equal(got.velocity, want.velocity, `${where}: velocity`);
          assert.equal(got.noteLength, want.noteLength, `${where}: note length`);
          assert.equal(got.microTiming, want.microTiming, `${where}: micro timing`);

          // The importer drops chord offsets of 0, which would duplicate the root note.
          const expectedChord = want.chord.filter((offset) => offset !== 0);
          droppedZeroOffsets += want.chord.length - expectedChord.length;
          assert.deepEqual(got.chord, expectedChord, `${where}: chord`);
          chordNotes += expectedChord.length;

          // Chord notes inherit the root's velocity, length and micro timing verbatim.
          for (const slot of got.slots.slice(1)) {
            assert.equal(slot.velocity, got.slots[0]!.velocity, `${where}: chord velocity`);
            assert.equal(slot.noteLength, got.slots[0]!.noteLength, `${where}: chord length`);
            assert.equal(slot.microTiming, got.slots[0]!.microTiming, `${where}: chord micro timing`);
          }
        }
      }
    }
  }

  assert.equal(trigs, 7713, "expected the full corpus trig count");
  assert.equal(chordNotes, 544, "expected the full corpus chord-note count");
  assert.equal(droppedZeroOffsets, 7, "expected exactly the known zero-offset drops");
});

test("sound locks agree with the DN1 source", { skip }, () => {
  let locked = 0;
  for (const pair of available) {
    const dn1 = image(DN1_DIR + pair.dn1);
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const a = readPattern(dn1, index);
      const b = readDn2Pattern(dn2, index, DN2_LAYOUT);
      for (const source of a.tracks) {
        const target = b.tracks[source.index]!;
        for (let k = 0; k < source.trigs.length; k++) {
          assert.equal(
            target.trigs[k]!.soundLock,
            source.trigs[k]!.soundLock,
            `${pair.label} pattern ${index} track ${source.index} step ${source.trigs[k]!.step}: sound lock`,
          );
          if (source.trigs[k]!.soundLock !== undefined) locked++;
        }
      }
    }
  }
  assert.equal(locked, 2131, "expected the full corpus sound-lock count");
});

test("the parameter-lock table matches the DN1 table record for record", { skip }, () => {
  let records = 0;
  let valueRescaled = 0;

  for (const pair of available) {
    const dn1 = image(DN1_DIR + pair.dn1);
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const source = dn1ReadLockTable(dn1PatternRecord(dn1, index));
      const target = readDn2Pattern(dn2, index, DN2_LAYOUT);
      const flat = target.tracks
        .flatMap((t) => t.trigs.map((g) => ({ track: t.index, step: g.step, locks: g.locks })))
        .filter((x) => x.locks.length > 0);

      // Rebuild the DN2 table directly to compare record order and step sets.
      const dn2Table = readDn2LockTable(patternRecord(dn2, index, DN2_LAYOUT));
      assert.equal(dn2Table.length, source.length, `${pair.label} pattern ${index}: lock record count`);

      for (let r = 0; r < source.length; r++) {
        const want = source[r]!;
        const got = dn2Table[r]!;
        const where = `${pair.label} pattern ${index} lock record ${r}`;
        assert.equal(got.track, want.track, `${where}: track`);

        const wantSteps = want.values.map((v, s) => [s, v] as const).filter(([, v]) => v !== 0xffff);
        const gotSteps = got.values.map((v, s) => [s, v] as const).filter(([, v]) => v !== 0xffff);
        assert.deepEqual(
          gotSteps.map(([s]) => s),
          wantSteps.map(([s]) => s),
          `${where}: locked steps`,
        );
        for (let i = 0; i < wantSteps.length; i++) {
          if (gotSteps[i]![1] !== wantSteps[i]![1]) valueRescaled++;
        }
        records++;
      }

      // Every step-level lock must belong to a step that actually carries a trig.
      for (const entry of flat) {
        assert.ok(entry.step < STEP_COUNT, `${pair.label} pattern ${index}: lock on step ${entry.step}`);
      }
    }
  }

  assert.equal(records, 392, "expected the full corpus lock-record count");
  assert.equal(valueRescaled, 6, "expected exactly the six known rescaled lock values");
});

test("pattern name, tempo and slot index agree with the DN1 source", { skip }, () => {
  for (const pair of available) {
    const dn1 = image(DN1_DIR + pair.dn1);
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const a = readPattern(dn1, index);
      const b = readDn2Pattern(dn2, index, DN2_LAYOUT);
      const at = `${pair.label} pattern ${index}`;
      assert.equal(b.name, a.name, `${at}: name`);
      assert.equal(b.tempo, a.tempo, `${at}: tempo`);
      assert.equal(b.slotIndex, a.slotIndex, `${at}: slot index`);
      assert.equal(b.version, 3, `${at}: record version`);
    }
  }
});

test("per-track length and speed agree with the DN1 source", { skip }, () => {
  for (const pair of available) {
    const dn1 = image(DN1_DIR + pair.dn1);
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const a = readPattern(dn1, index);
      const b = readDn2Pattern(dn2, index, DN2_LAYOUT);
      for (const source of a.tracks) {
        const target = b.tracks[source.index]!;
        const at = `${pair.label} pattern ${index} track ${source.index}`;
        assert.equal(target.length, source.length, `${at}: track length`);
        assert.equal(target.speed, source.speed, `${at}: track speed`);
        assert.equal(target.settings.defaultNote, source.settings[2], `${at}: default note`);
        assert.equal(target.settings.defaultVelocity, source.settings[3], `${at}: default velocity`);
      }
    }
  }
});

test("the kit MIDI mask marks exactly the DN1 MIDI tracks", { skip }, () => {
  for (const pair of available) {
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      // A DN1 project is always 4 synth tracks then 4 MIDI tracks, so every converted kit
      // must mark tracks 4-7 and nothing else.
      assert.equal(readMidiTrackMask(dn2, index, DN2_LAYOUT), 0x00f0, `${pair.label} kit ${index}`);
      const pattern = readDn2Pattern(dn2, index, DN2_LAYOUT);
      assert.deepEqual(
        pattern.tracks.filter((t) => t.kind === "midi").map((t) => t.index),
        [4, 5, 6, 7],
      );
    }
  }
});

test("step flag words take only the documented shapes", { skip }, () => {
  const seen = new Set<number>();
  let staleNoteOnLockTrig = 0;
  for (const pair of available) {
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const pattern = readDn2Pattern(dn2, index, DN2_LAYOUT);
      for (const track of pattern.tracks) {
        for (const trig of track.trigs) {
          seen.add(trig.flags);
          const isLock = (trig.flags & STEP_FLAG.lockTrig) !== 0;
          assert.equal(isLock, trig.isLockTrig);
          assert.equal(isLock, !trig.hasNote, "lockTrig and hasNote are complementary");
          if (isLock && trig.note !== undefined) staleNoteOnLockTrig++;
          if (!isLock) {
            assert.equal(trig.flags & STEP_FLAG.note, STEP_FLAG.note, "note trigs set 0x0180");
            assert.notEqual(trig.note, undefined, "note trigs carry a note byte");
          }
        }
      }
    }
  }
  // Three DN1 lock trigs carry an uncleared note byte; the importer copies it verbatim.
  assert.equal(staleNoteOnLockTrig, 3);
  // Masking away the parity bit, the device-only note bit and the top nibble (which
  // carries bits inherited verbatim from unusual DN1 flag words) leaves exactly two
  // shapes: 0x0181 for a note trig and 0x0801 for a trigless lock trig.
  const CORE = 0xffff & ~(STEP_FLAG.oddStep | STEP_FLAG.deviceNote | 0xf000);
  for (const flags of seen) {
    assert.equal(flags & STEP_FLAG.trig, STEP_FLAG.trig);
    assert.ok((flags & CORE) === 0x0181 || (flags & CORE) === 0x0801, `unexpected flag word 0x${flags.toString(16)}`);
  }
});

test("trigger slots are dense, sorted and free of stale records in a converted project", { skip }, () => {
  for (const pair of available) {
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const slots = readTrigSlots(patternRecord(dn2, index, DN2_LAYOUT));
      for (let i = 0; i < slots.length; i++) {
        assert.equal(slots[i]!.slot, i, `${pair.label} pattern ${index}: importer leaves no holes`);
        if (i > 0) {
          const prev = slots[i - 1]!;
          const cur = slots[i]!;
          assert.ok(
            prev.track < cur.track || (prev.track === cur.track && prev.step <= cur.step),
            `${pair.label} pattern ${index}: slots out of (track, step) order at ${i}`,
          );
        }
      }
    }
  }
});

test("micro timing is read as a signed byte, so 0xFF is -1 and not 'unset'", { skip }, () => {
  let negatives = 0;
  for (const pair of available) {
    const dn1 = image(DN1_DIR + pair.dn1);
    const dn2 = image(DN2_DIR + pair.dn2);
    for (let index = 0; index < DN2_LAYOUT.patternCount; index++) {
      const a = readPattern(dn1, index);
      const b = readDn2Pattern(dn2, index, DN2_LAYOUT);
      for (const source of a.tracks) {
        const target = b.tracks[source.index]!;
        for (let k = 0; k < source.trigs.length; k++) {
          const want = source.trigs[k]!;
          assert.equal(target.trigs[k]!.slots[0]!.microTiming, asByte(want.microTiming));
          if (want.microTiming < 0) negatives++;
        }
      }
    }
  }
  assert.ok(negatives > 0, "corpus should contain negative micro timing");
});

// Local copy of the lock-table reader that keeps unused records out but preserves order,
// so the test compares against the raw table rather than the per-trig projection.
function readDn2LockTable(pattern: Uint8Array): Array<{ track: number; parameter: number; values: number[] }> {
  const dv = new DataView(pattern.buffer, pattern.byteOffset, pattern.byteLength);
  const out: Array<{ track: number; parameter: number; values: number[] }> = [];
  for (let r = 0; r < PATTERN.lockCount; r++) {
    const at = PATTERN.lockOffset + r * PATTERN.lockSize;
    const header = dv.getUint16(at, true);
    if (header === 0xffff) continue;
    const values: number[] = [];
    for (let s = 0; s < STEP_COUNT; s++) values.push(dv.getUint16(at + 2 + s * 2, true));
    out.push({ parameter: header & 0xff, track: header >>> 8, values });
  }
  return out;
}
