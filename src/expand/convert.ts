/**
 * Convert a Digitone 1 project image into a Digitone II one.
 *
 * ## Why this needs a template
 *
 * A DN2 image is 12.9 MB and we do not understand all of it — parts of the kit record, most
 * of the tail, several per-track arrays. Synthesising those bytes would mean inventing
 * values for fields whose meaning is unknown, and writing them to hardware.
 *
 * So conversion is a *transplant*, not a construction: take a DN2 project the device itself
 * wrote, and overwrite only the regions we have verified. Everything unidentified survives
 * untouched. This is the discipline elk-herd uses, and it is what makes a partial
 * understanding of a format safe to write with.
 *
 * The template can be any `.dn2prj`. A blank project exported from the device is the
 * cleanest choice, since nothing of its content survives except the regions we do not model.
 *
 * ## What gets written
 *
 * Per pattern: step flags, per-step velocity / note length / micro timing / trig conditions,
 * sound locks, per-track length and speed, the trigger slot array, the parameter-lock table
 * and the pattern metadata. Per kit: the four DN1 sounds into slots 0-3 and the MIDI-track
 * mask. Plus the 128-slot sound pool and the project name.
 *
 * ## Track layout
 *
 * Follows Elektron's own import, verified across nine matched pairs: DN1 synth track N to
 * DN2 track N, DN1 MIDI track N to DN2 track 4+N, and DN2 tracks 8-15 left untouched. Those
 * eight are the expansion budget.
 */

import {
  PATTERN as DN1_PATTERN,
  SYNTH_TRACK_COUNT,
  TRACK_COUNT as DN1_TRACK_COUNT,
  readKit,
  readPattern,
  readSoundPool,
  type Dn1Pattern,
  type Dn1Track,
} from "../project/dn1.js";
import { DN1_LAYOUT, DN2_LAYOUT } from "../project/dn2image.js";
import {
  KIT_MIDI_MASK_OFFSET,
  PATTERN as DN2_PATTERN,
  STEP_COUNT as DN2_STEP_COUNT,
  STEP_FLAG,
  TRACK as DN2_TRACK,
} from "../project/dn2pattern.js";
import {
  DN2_SOUND_SIZE,
  convertDn1SoundToDn2Detailed,
  type ConversionWarning as SoundWarning,
} from "../project/soundmap.js";
import { NO_CONDITION, translateParameterId, translateTrigCondition } from "./translate.js";

/** DN1 kit sound slots, and therefore the DN2 slots they occupy. */
const DN1_KIT_SOUNDS = SYNTH_TRACK_COUNT;
/** DN2 kit: 60-byte header, then 16 sound slots. */
const DN2_KIT_SOUND_OFFSET = 60;
/** DN2 sound pool sits after a full kit record at the head of the tail. */
const DN2_POOL_OFFSET = 10_756;
const POOL_SLOTS = 128;
/** Every DN1 project has four synth tracks then four MIDI tracks. */
const DN1_MIDI_MASK = 0x00f0;
const NO_BYTE = 0xff;
const NO_WORD = 0xffff;

export class ConversionError extends Error {}

export interface ConvertWarning {
  kind: "parameter" | "condition" | "sound" | "capacity";
  /** Pattern index, when the warning is pattern-scoped. */
  pattern?: number;
  track?: number;
  step?: number;
  message: string;
}

export interface ConversionReport {
  patternsWritten: number;
  trigsWritten: number;
  soundLocksWritten: number;
  lockRecordsWritten: number;
  soundsConverted: number;
  warnings: ConvertWarning[];
}

export interface ConvertOptions {
  /**
   * Stop after this many patterns. Only useful for narrowing down a diff during
   * development; leave unset to convert the whole project.
   */
  patternLimit?: number;
}

function assertImage(image: Uint8Array, expected: number, what: string): void {
  if (image.length !== expected) {
    throw new ConversionError(`${what} must be ${expected} bytes, got ${image.length}`);
  }
}

/**
 * DN1 step-flag bits we do not understand, which Elektron's importer passes through to the
 * same positions in the DN2 word rather than dropping. Unknown does not mean unwanted.
 *
 * Bits 9 and up: observed DN1 values include 0x0200, 0x2000 and 0x6000, and each appears
 * unchanged in the DN2 output (DN1 0x2201 becomes DN2 0x2381). The mask deliberately stops
 * below 0x0180, which is the DN2's own note marker and must not be inherited.
 */
const DN1_UNKNOWN_FLAG_BITS = 0xfe00;

/**
 * DN2 step flag word for a DN1 trig, or the empty-step word.
 *
 * The odd-step parity bit is set on every step of DN2 tracks 0-7, whether or not the track
 * carries trigs — measured across the corpus, an empty track still reads 0x0010 on odd
 * steps. `trackHasTrigs` is retained only for the one exception below.
 */
function stepFlagWord(
  trig: { hasNote: boolean; isLockTrig: boolean; flags: number } | undefined,
  step: number,
  trackHasTrigs: boolean,
): number {
  const parity = step % 2 === 1 ? STEP_FLAG.oddStep : 0;
  if (!trig) return parity;
  // The importer writes 0x0181 for a note trig and 0x0801 for a lock trig. The device also
  // sets 0x0200 on note trigs, but Elektron's own conversions load without it.
  const kind = trig.isLockTrig ? STEP_FLAG.lockTrig : STEP_FLAG.note;
  return parity | kind | STEP_FLAG.trig | (trig.flags & DN1_UNKNOWN_FLAG_BITS);
}

/** Write one DN1 track's per-step data into its DN2 track record. */
function writeTrack(
  out: Uint8Array,
  patternBase: number,
  track: Dn1Track,
  patternIndex: number,
  report: ConversionReport,
): void {
  const base = patternBase + DN2_PATTERN.trackOffset + track.index * DN2_TRACK.size;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const byStep = new Map(track.trigs.map((t) => [t.step, t]));
  const hasTrigs = track.trigs.length > 0;

  for (let step = 0; step < DN2_STEP_COUNT; step++) {
    const trig = byStep.get(step);
    view.setUint16(
      base + DN2_TRACK.flagsOffset + step * 2,
      stepFlagWord(trig, step, hasTrigs),
      false,
    );

    out[base + DN2_TRACK.soundLockOffset + step] = trig?.soundLock ?? NO_BYTE;
    if (trig?.soundLock !== undefined) report.soundLocksWritten++;

    let condition = NO_CONDITION;
    if (trig?.trigCondition !== undefined) {
      const translated = translateTrigCondition(trig.trigCondition);
      if (translated) {
        condition = translated;
      } else {
        report.warnings.push({
          kind: "condition",
          pattern: patternIndex,
          track: track.index,
          step,
          message: `DN1 trig condition ${trig.trigCondition} has no known DN2 equivalent; dropped`,
        });
      }
    }
    out[base + DN2_TRACK.conditionOffset + step] = condition.condition;
    out[base + DN2_TRACK.conditionAltOffset + step] = condition.conditionAlt;
    out[base + DN2_TRACK.probabilityOffset + step] = condition.probability;
  }

  // Per-track settings: only the fields we have verified are overwritten, so the template's
  // values survive everywhere else.
  const settings = base + DN2_TRACK.settingsOffset;
  out[settings + DN2_TRACK.settingsLengthOffset] = track.length;
  out[settings + DN2_TRACK.settingsSpeedOffset] = track.speed;
}

/** Build and write the trigger slot array from every track's trigs. */
function writeTrigSlots(
  out: Uint8Array,
  patternBase: number,
  pattern: Dn1Pattern,
  report: ConversionReport,
): void {
  const slots: number[][] = [];

  for (const track of pattern.tracks) {
    for (const trig of track.trigs) {
      const note = trig.hasNote && trig.note !== undefined ? trig.note : NO_BYTE;
      slots.push([
        track.index,
        trig.step,
        note,
        trig.velocity ?? NO_BYTE,
        trig.noteLength ?? NO_BYTE,
        trig.microTiming & 0xff,
      ]);
      // A chord is extra slots repeating (track, step) with absolute notes.
      if (trig.hasNote && trig.note !== undefined) {
        for (const offset of trig.chord) {
          if (offset === 0) continue; // the importer does not re-emit the root
          slots.push([
            track.index,
            trig.step,
            (trig.note + offset) & 0x7f,
            trig.velocity ?? NO_BYTE,
            trig.noteLength ?? NO_BYTE,
            trig.microTiming & 0xff,
          ]);
        }
      }
    }
  }

  if (slots.length > DN2_PATTERN.trigCount) {
    throw new ConversionError(
      `Pattern ${pattern.index} needs ${slots.length} trigger slots, capacity is ${DN2_PATTERN.trigCount}`,
    );
  }

  const base = patternBase + DN2_PATTERN.trigOffset;
  out.fill(NO_BYTE, base, base + DN2_PATTERN.trigCount * DN2_PATTERN.trigSize);
  slots.forEach((slot, i) => out.set(slot, base + i * DN2_PATTERN.trigSize));
  report.trigsWritten += slots.length;
}

/** Copy the parameter-lock table across, translating ids and widening 64 steps to 128. */
function writeLockTable(
  out: Uint8Array,
  patternBase: number,
  dn1Image: Uint8Array,
  patternIndex: number,
  report: ConversionReport,
): void {
  const dn1Base =
    DN1_LAYOUT.headerSize + patternIndex * DN1_PATTERN.size + DN1_PATTERN.lockOffset;
  const dn1View = new DataView(dn1Image.buffer, dn1Image.byteOffset, dn1Image.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const base = patternBase + DN2_PATTERN.lockOffset;

  for (let record = 0; record < DN2_PATTERN.lockCount; record++) {
    const from = dn1Base + record * DN1_PATTERN.lockSize;
    const to = base + record * DN2_PATTERN.lockSize;
    const parameter = dn1Image[from]!;

    if (parameter === NO_BYTE) {
      out[to] = NO_BYTE;
      out[to + 1] = NO_BYTE;
      for (let step = 0; step < DN2_STEP_COUNT; step++) {
        view.setUint16(to + 2 + step * 2, NO_WORD, true);
      }
      continue;
    }

    const translated = translateParameterId(parameter);
    if (translated === undefined) {
      report.warnings.push({
        kind: "parameter",
        pattern: patternIndex,
        track: dn1Image[from + 1]!,
        message: `DN1 parameter id ${parameter} has no known DN2 equivalent; lock record dropped`,
      });
      out[to] = NO_BYTE;
      out[to + 1] = NO_BYTE;
      for (let step = 0; step < DN2_STEP_COUNT; step++) {
        view.setUint16(to + 2 + step * 2, NO_WORD, true);
      }
      continue;
    }

    out[to] = translated;
    out[to + 1] = dn1Image[from + 1]!;
    for (let step = 0; step < DN2_STEP_COUNT; step++) {
      // The DN1 holds 64 steps; the DN2's upper half has no source and stays unset.
      const value = step < 64 ? dn1View.getUint16(from + 2 + step * 2, true) : NO_WORD;
      view.setUint16(to + 2 + step * 2, value, true);
    }
    report.lockRecordsWritten++;
  }
}

/**
 * Copy a name field verbatim rather than re-encoding the decoded string.
 *
 * Elektron never clears a name field on rename, so the bytes after the NUL keep whatever
 * the previous name left behind — "GROOVY JECT " is GROOVY written over NEW PROJECT.
 * Re-encoding would zero that residue and diverge from the device's own output, so the DN1
 * bytes are transplanted as they are.
 */
function copyNameField(out: Uint8Array, to: number, source: Uint8Array, from: number, size: number): void {
  out.set(source.subarray(from, from + size), to);
}

function writePatternMetadata(
  out: Uint8Array,
  patternBase: number,
  pattern: Dn1Pattern,
  dn1Image: Uint8Array,
): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const dn1Name =
    DN1_LAYOUT.headerSize + pattern.index * DN1_PATTERN.size + DN1_PATTERN.nameOffset;
  copyNameField(out, patternBase + DN2_PATTERN.nameOffset, dn1Image, dn1Name, DN2_PATTERN.nameSize);
  view.setUint16(patternBase + DN2_PATTERN.tempoOffset, Math.round(pattern.tempo * 120), false);
  // The DN1 record carries its own idea of which slot it occupies, and that is usually but
  // not always the array position. Elektron preserves the record's value, so we do too.
  out[patternBase + DN2_PATTERN.slotIndexOffset] = pattern.slotIndex;
}

/** Render a sound-mapping warning as one line, keeping its provenance visible. */
function describeSoundWarning(w: SoundWarning): string {
  return `${w.kind} at DN1+${w.dn1Offset} -> DN2+${w.dn2Offset} (value ${w.value}): ${w.detail}`;
}

/** Convert the four DN1 kit sounds into DN2 slots 0-3 and set the MIDI mask. */
function writeKit(
  out: Uint8Array,
  dn1Image: Uint8Array,
  index: number,
  report: ConversionReport,
): void {
  const kitBase = DN2_LAYOUT.kitBase + index * DN2_LAYOUT.kitSize;
  const dn1Kit = readKit(dn1Image, index);

  for (let slot = 0; slot < DN1_KIT_SOUNDS; slot++) {
    const source = dn1Kit.sounds[slot];
    if (!source) continue;
    const { sound, warnings } = convertDn1SoundToDn2Detailed(source.data);
    out.set(sound, kitBase + DN2_KIT_SOUND_OFFSET + slot * DN2_SOUND_SIZE);
    report.soundsConverted++;
    for (const w of warnings) {
      report.warnings.push({
        kind: "sound",
        pattern: index,
        track: slot,
        message: `kit sound ${slot}: ${describeSoundWarning(w)}`,
      });
    }
  }

  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
    kitBase + KIT_MIDI_MASK_OFFSET,
    DN1_MIDI_MASK,
    false,
  );
}

/** Convert the 128-slot sound pool. Sound locks index it, so it must travel intact. */
function writeSoundPool(
  out: Uint8Array,
  dn1Image: Uint8Array,
  report: ConversionReport,
): void {
  const pool = readSoundPool(dn1Image);
  const base = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET;

  for (let slot = 0; slot < POOL_SLOTS; slot++) {
    const source = pool[slot];
    if (!source) continue;
    const { sound, warnings } = convertDn1SoundToDn2Detailed(source.data);
    out.set(sound, base + slot * DN2_SOUND_SIZE);
    report.soundsConverted++;
    for (const w of warnings) {
      report.warnings.push({ kind: "sound", message: `pool slot ${slot}: ${describeSoundWarning(w)}` });
    }
  }
}

/**
 * Convert a DN1 project image into a DN2 one, using `template` for everything we do not
 * model. Neither input is modified.
 */
export function convertProject(
  dn1Image: Uint8Array,
  template: Uint8Array,
  options: ConvertOptions = {},
): { image: Uint8Array; report: ConversionReport } {
  assertImage(dn1Image, DN1_LAYOUT.imageSize, "DN1 image");
  assertImage(template, DN2_LAYOUT.imageSize, "DN2 template");

  const out = Uint8Array.from(template);
  const report: ConversionReport = {
    patternsWritten: 0,
    trigsWritten: 0,
    soundLocksWritten: 0,
    lockRecordsWritten: 0,
    soundsConverted: 0,
    warnings: [],
  };

  // The project name lives at image+8 on both devices, 16 bytes including residue.
  copyNameField(out, 8, dn1Image, 8, 16);

  const limit = Math.min(options.patternLimit ?? DN1_LAYOUT.patternCount, DN1_LAYOUT.patternCount);
  for (let index = 0; index < limit; index++) {
    const patternBase = DN2_LAYOUT.headerSize + index * DN2_LAYOUT.patternSize;
    const pattern = readPattern(dn1Image, index);

    for (const track of pattern.tracks) {
      if (track.index >= DN1_TRACK_COUNT) continue;
      writeTrack(out, patternBase, track, index, report);
    }
    writeTrigSlots(out, patternBase, pattern, report);
    writeLockTable(out, patternBase, dn1Image, index, report);
    writePatternMetadata(out, patternBase, pattern, dn1Image);
    writeKit(out, dn1Image, index, report);
    report.patternsWritten++;
  }

  writeSoundPool(out, dn1Image, report);

  return { image: out, report };
}
