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
  KIT as DN1_KIT,
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
  TRACK_COUNT as DN2_TRACK_COUNT,
} from "../project/dn2pattern.js";
import {
  DN2_SOUND_SIZE,
  convertDn1SoundToDn2Detailed,
  type ConversionWarning as SoundWarning,
} from "../project/soundmap.js";
import { MACHINE, SOUND_MACHINE_OFFSET } from "../project/machine.js";
import { NO_CONDITION, translateParameterId, translateTrigCondition } from "./translate.js";
import { destinationsBySound, findCollisions, routePattern, type RoutedTrig } from "./route.js";
import {
  applyFieldConstants,
  applyFieldCopies,
  FX_COMPRESSOR_VOLUME,
  KIT_FX_CONSTANTS,
  KIT_FX_MAP,
  MIDI_TRACK_CONSTANTS,
  MIDI_TRACK_MAP,
  PATTERN_META_CONSTANTS,
  PATTERN_META_MAP,
  TRACK_SETTINGS_CONSTANTS,
  TRACK_SETTINGS_MAP,
} from "./fieldmap.js";
import type { ExpansionPlan } from "./types.js";

/** DN1 kit sound slots, and therefore the DN2 slots they occupy. */
const DN1_KIT_SOUNDS = SYNTH_TRACK_COUNT;
/** DN2 kit: 60-byte header, then 16 sound slots. */
const DN2_KIT_SOUND_OFFSET = 60;
/** 16 x u16le track levels in the DN2 kit header. The DN1's four sit at its kit+0x14. */
const DN2_KIT_LEVEL_OFFSET = 0x1c;
/** DN2 kit: 16 MIDI track records of 268 bytes, one per track, after the sounds. */
const DN2_KIT_MIDI_OFFSET = 5_964;
const DN2_MIDI_RECORD_SIZE = 268;
/** DN2 sound pool sits after a full kit record at the head of the tail. */
const DN2_POOL_OFFSET = 10_756;
const POOL_SLOTS = 128;
/** Every DN1 project has four synth tracks then four MIDI tracks. */
const DN1_MIDI_MASK = 0x00f0;
/** ...which land on DN2 tracks 5-8, i.e. kit sound slots 4-7. */
const DN1_MIDI_TRACKS = 4;
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
  /** Trigs relocated to a promoted track. Zero for a faithful conversion. */
  trigsPromoted: number;
  /** DN2 tracks that received a promoted sound. */
  tracksUsed: Set<number>;
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
  /**
   * Expansion plan to apply. Without it the conversion is faithful: every DN1 track lands
   * on its DN2 counterpart and every sound lock is preserved, reproducing what Elektron's
   * own importer does. With it, promoted sounds move to their own tracks.
   */
  plan?: ExpansionPlan;
  /**
   * Override the project name instead of carrying the DN1's across.
   *
   * Written the way the DN2 stores a name: up to 15 characters then a NUL, with the rest of
   * the 16-byte field zeroed. That differs from the default path, which transplants the DN1
   * field verbatim including its uncleared residue — so use this only when the name is
   * meant to change, never as a round-trip of a name read back out.
   */
  projectName?: string;
}

/** DN2 project and pattern name fields are 16 bytes, NUL-terminated. */
const NAME_FIELD_SIZE = 16;

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

/**
 * Write one DN2 track record from the trigs routed to it.
 *
 * `entries` may come from more than one DN1 track when a sound locked on several tracks was
 * merged onto one destination. `settingsSource` is the DN1 track whose length and speed the
 * destination inherits, so a promoted track stays in sync with the music it came from.
 */
function writeTrack(
  out: Uint8Array,
  patternBase: number,
  destinationTrack: number,
  entries: readonly RoutedTrig[],
  settingsSource: Dn1Track | undefined,
  patternIndex: number,
  report: ConversionReport,
): void {
  const base = patternBase + DN2_PATTERN.trackOffset + destinationTrack * DN2_TRACK.size;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const byStep = new Map(entries.map((e) => [e.trig.step, e]));
  const hasTrigs = entries.length > 0;

  for (let step = 0; step < DN2_STEP_COUNT; step++) {
    const entry = byStep.get(step);
    const trig = entry?.trig;
    view.setUint16(
      base + DN2_TRACK.flagsOffset + step * 2,
      stepFlagWord(trig, step, hasTrigs),
      false,
    );

    // A promoted trig loses its lock: the destination track now carries the sound itself.
    const lock = entry?.clearSoundLock ? undefined : trig?.soundLock;
    out[base + DN2_TRACK.soundLockOffset + step] = lock ?? NO_BYTE;
    if (lock !== undefined) report.soundLocksWritten++;

    let condition = NO_CONDITION;
    if (trig?.trigCondition !== undefined) {
      const translated = translateTrigCondition(trig.trigCondition);
      if (translated) {
        condition = translated;
      } else {
        report.warnings.push({
          kind: "condition",
          pattern: patternIndex,
          track: destinationTrack,
          step,
          message: `DN1 trig condition ${trig.trigCondition} has no known DN2 equivalent; dropped`,
        });
      }
    }
    out[base + DN2_TRACK.conditionOffset + step] = condition.condition;
    out[base + DN2_TRACK.conditionAltOffset + step] = condition.conditionAlt;
    out[base + DN2_TRACK.probabilityOffset + step] = condition.probability;
  }

  // Per-track settings. Only the correspondences verified against Elektron's own output are
  // copied, so DN2-only fields and anything still unplaced keep the template's value.
  if (settingsSource) {
    applyFieldCopies(
      out,
      base + DN2_TRACK.settingsOffset,
      settingsSource.settings,
      0,
      TRACK_SETTINGS_MAP,
    );
    applyFieldConstants(out, base + DN2_TRACK.settingsOffset, TRACK_SETTINGS_CONSTANTS);
  }
}

/**
 * Build and write the trigger slot array.
 *
 * The array is flat across all tracks, so it is written from the routing rather than from
 * the DN1 tracks directly — a promoted trig must name its destination track here too.
 * Order is destination track then step, matching Elektron's own output.
 */
function writeTrigSlots(
  out: Uint8Array,
  patternBase: number,
  routed: readonly RoutedTrig[],
  patternIndex: number,
  report: ConversionReport,
): void {
  const slots: number[][] = [];
  const ordered = [...routed].sort(
    (a, b) => a.destinationTrack - b.destinationTrack || a.trig.step - b.trig.step,
  );

  for (const { trig, destinationTrack } of ordered) {
    const note = trig.hasNote && trig.note !== undefined ? trig.note : NO_BYTE;
    slots.push([
      destinationTrack,
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
          destinationTrack,
          trig.step,
          (trig.note + offset) & 0x7f,
          trig.velocity ?? NO_BYTE,
          trig.noteLength ?? NO_BYTE,
          trig.microTiming & 0xff,
        ]);
      }
    }
  }

  if (slots.length > DN2_PATTERN.trigCount) {
    throw new ConversionError(
      `Pattern ${patternIndex} needs ${slots.length} trigger slots, capacity is ${DN2_PATTERN.trigCount}`,
    );
  }

  const base = patternBase + DN2_PATTERN.trigOffset;
  out.fill(NO_BYTE, base, base + DN2_PATTERN.trigCount * DN2_PATTERN.trigSize);
  slots.forEach((slot, i) => out.set(slot, base + i * DN2_PATTERN.trigSize));
  report.trigsWritten += slots.length;
}

/** One output lock record: a parameter, a destination track, and its per-step values. */
interface LockRecord {
  parameter: number;
  track: number;
  /** Step -> value, DN1 step numbering (0..63). Absent steps are unset. */
  values: Map<number, number>;
}

/**
 * Copy the parameter-lock table across, translating ids and widening 64 steps to 128.
 *
 * A DN1 record covers one (parameter, track) pair across all steps. When promotion sends
 * some of a track's trigs to a different destination, that record has to SPLIT: the steps
 * that moved need their own record naming the destination track. Splitting consumes table
 * slots, and there are only 80, so overflow is reported rather than silently truncated.
 *
 * With no plan the routing is the identity, every record yields exactly one output record
 * with its original track, and the table is byte-identical to Elektron's.
 */
function writeLockTable(
  out: Uint8Array,
  patternBase: number,
  dn1Image: Uint8Array,
  patternIndex: number,
  destinationOf: (track: number, step: number) => number,
  report: ConversionReport,
): void {
  const dn1Base =
    DN1_LAYOUT.headerSize + patternIndex * DN1_PATTERN.size + DN1_PATTERN.lockOffset;
  const dn1View = new DataView(dn1Image.buffer, dn1Image.byteOffset, dn1Image.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const base = patternBase + DN2_PATTERN.lockOffset;

  const records: LockRecord[] = [];

  for (let record = 0; record < DN2_PATTERN.lockCount; record++) {
    const from = dn1Base + record * DN1_PATTERN.lockSize;
    const parameter = dn1Image[from]!;
    if (parameter === NO_BYTE) continue;

    const translated = translateParameterId(parameter);
    if (translated === undefined) {
      report.warnings.push({
        kind: "parameter",
        pattern: patternIndex,
        track: dn1Image[from + 1]!,
        message: `DN1 parameter id ${parameter} has no known DN2 equivalent; lock record dropped`,
      });
      continue;
    }

    const sourceTrack = dn1Image[from + 1]!;
    const byDestination = new Map<number, Map<number, number>>();

    for (let step = 0; step < 64; step++) {
      const value = dn1View.getUint16(from + 2 + step * 2, true);
      if (value === NO_WORD) continue;
      const destination = destinationOf(sourceTrack, step);
      const bucket = byDestination.get(destination);
      if (bucket) bucket.set(step, value);
      else byDestination.set(destination, new Map([[step, value]]));
    }

    if (byDestination.size === 0) {
      // A record with a parameter but no active steps. Preserved so the table matches
      // Elektron's byte for byte rather than being quietly compacted away.
      records.push({ parameter: translated, track: sourceTrack, values: new Map() });
      continue;
    }
    for (const [destination, values] of byDestination) {
      records.push({ parameter: translated, track: destination, values });
    }
  }

  if (records.length > DN2_PATTERN.lockCount) {
    report.warnings.push({
      kind: "capacity",
      pattern: patternIndex,
      message:
        `promotion split the parameter-lock table into ${records.length} records but only ` +
        `${DN2_PATTERN.lockCount} fit; ${records.length - DN2_PATTERN.lockCount} dropped`,
    });
    records.length = DN2_PATTERN.lockCount;
  }

  for (let record = 0; record < DN2_PATTERN.lockCount; record++) {
    const to = base + record * DN2_PATTERN.lockSize;
    const entry = records[record];

    if (!entry) {
      out[to] = NO_BYTE;
      out[to + 1] = NO_BYTE;
      for (let step = 0; step < DN2_STEP_COUNT; step++) {
        view.setUint16(to + 2 + step * 2, NO_WORD, false);
      }
      continue;
    }

    out[to] = entry.parameter;
    out[to + 1] = entry.track;
    for (let step = 0; step < DN2_STEP_COUNT; step++) {
      // The DN1 holds 64 steps; the DN2's upper half has no source and stays unset.
      // u16be to match the readers: a slot is a coarse byte then a fine one, and the two
      // devices lay it out the same way, so the pair transfers unchanged.
      view.setUint16(to + 2 + step * 2, entry.values.get(step) ?? NO_WORD, false);
    }
    report.lockRecordsWritten++;
  }
}

/**
 * Copy a name field verbatim rather than re-encoding the decoded string.
 *
 * Elektron never clears a name field on rename, so the bytes after the terminator keep
 * whatever the previous name left behind: renaming NEW PROJECT to GROOVY leaves the trailing
 * "JECT" in place after the NUL. Re-encoding would zero that residue and diverge from the
 * device's own output, so the DN1 bytes are transplanted as they are.
 */
function copyNameField(out: Uint8Array, to: number, source: Uint8Array, from: number, size: number): void {
  out.set(source.subarray(from, from + size), to);
}

/**
 * Write a name the device did not produce: up to 15 characters, NUL, then zeros.
 *
 * The zero fill is deliberate and is the opposite of `copyNameField`'s discipline. There is
 * no residue to preserve because there is no source field — leaving the template's bytes
 * after the terminator would splice a stranger's project name onto the tail of ours.
 *
 * Characters outside the DN1's single-byte set are dropped rather than mangled; the device
 * charset is not plain ASCII (`docs/sysex-format.md`) and guessing an encoding for a name
 * that gets written to hardware is not worth the risk.
 */
function writeNameField(out: Uint8Array, to: number, name: string): void {
  out.fill(0, to, to + NAME_FIELD_SIZE);
  const bytes = [...name].map((c) => c.codePointAt(0)!).filter((c) => c >= 0x20 && c <= 0xff);
  out.set(Uint8Array.from(bytes.slice(0, NAME_FIELD_SIZE - 1)), to);
}

/**
 * Pattern metadata.
 *
 * The DN1's metadata block mirrors the DN2's field for field, at the same offsets relative
 * to the block start — the DN1's block begins at `nameOffset`, the DN2's at `metaOffset`.
 * Verified across 1,792 pattern pairs: length, change length, scale mode and speed all match
 * exactly, with no exceptions.
 *
 * **Scale mode is the one that bites.** 1 means "each track has its own length", 0 means
 * "one length for the whole pattern". Writing the per-track lengths but leaving the mode at
 * the template's 0 makes the device ignore them and use the template's master length
 * instead — the per-track values sit there correctly and are simply not consulted. The
 * result is audibly wrong (a 32-step bass line playing as 16) while every byte we thought
 * we were responsible for is correct.
 */
function writePatternMetadata(
  out: Uint8Array,
  patternBase: number,
  pattern: Dn1Pattern,
  dn1Image: Uint8Array,
): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const dn1View = new DataView(dn1Image.buffer, dn1Image.byteOffset, dn1Image.byteLength);
  const dn1Meta = DN1_LAYOUT.headerSize + pattern.index * DN1_PATTERN.size + DN1_PATTERN.nameOffset;

  copyNameField(out, patternBase + DN2_PATTERN.nameOffset, dn1Image, dn1Meta, DN2_PATTERN.nameSize);
  view.setUint16(patternBase + DN2_PATTERN.tempoOffset, Math.round(pattern.tempo * 120), false);

  // Each field sits the same distance from its block's start on both devices.
  const from = (dn2Offset: number) => dn1Meta + (dn2Offset - DN2_PATTERN.metaOffset);

  view.setUint16(
    patternBase + DN2_PATTERN.lengthOffset,
    dn1View.getUint16(from(DN2_PATTERN.lengthOffset), false),
    false,
  );
  view.setUint16(
    patternBase + DN2_PATTERN.changeLengthOffset,
    dn1View.getUint16(from(DN2_PATTERN.changeLengthOffset), false),
    false,
  );
  out[patternBase + DN2_PATTERN.scaleModeOffset] = dn1Image[from(DN2_PATTERN.scaleModeOffset)]!;
  out[patternBase + DN2_PATTERN.speedOffset] = dn1Image[from(DN2_PATTERN.speedOffset)]!;

  // The DN1 record carries its own idea of which slot it occupies, and that is usually but
  // not always the array position. Elektron preserves the record's value, so we do too.
  out[patternBase + DN2_PATTERN.slotIndexOffset] = pattern.slotIndex;

  // Two more fields that travel at the same relative offset, and one the importer fixes.
  applyFieldCopies(out, patternBase + DN2_PATTERN.metaOffset, dn1Image, dn1Meta, PATTERN_META_MAP);
  applyFieldConstants(out, patternBase + DN2_PATTERN.metaOffset, PATTERN_META_CONSTANTS);
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
  /** Destination DN2 track -> the pool slot promoted onto it. */
  promotions: ReadonlyMap<number, number>,
  levelSources: ReadonlyMap<number, number>,
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

  // Machine per slot. The DN1 has one machine, so its four synth tracks are FM TONE and its
  // four MIDI tracks take the MIDI machine on DN2 slots 4-7 — what Elektron writes on all
  // 12,288 sound slots of the matched corpus, without exception.
  //
  // Written explicitly rather than inherited: with a neutral template this byte reads 0 on the
  // MIDI slots, so a converted project's four MIDI tracks arrived carrying an FM TONE machine.
  // It looked correct only because the byte-diff test uses Elektron's own output as template.
  for (let slot = 0; slot < DN1_KIT_SOUNDS; slot++) {
    out[kitBase + DN2_KIT_SOUND_OFFSET + slot * DN2_SOUND_SIZE + SOUND_MACHINE_OFFSET] = MACHINE.fmTone;
  }
  for (let track = 0; track < DN1_MIDI_TRACKS; track++) {
    const slot = DN1_KIT_SOUNDS + track;
    out[kitBase + DN2_KIT_SOUND_OFFSET + slot * DN2_SOUND_SIZE + SOUND_MACHINE_OFFSET] = MACHINE.midi;
  }

  // Track levels. DN1 kit+0x14 holds four u16le levels, the DN2 sixteen at kit+0x1C, and the
  // first four correspond exactly (verified on 2,048 kit/track pairs). Without this a
  // converted project loses its mix: every track sits at the template's default of 100.
  const dn1KitBase = DN1_LAYOUT.kitBase + index * DN1_LAYOUT.kitSize;
  const kitView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const dn1Level = (track: number) =>
    dn1Image[dn1KitBase + DN1_KIT.levelOffset + track * 2]! |
    (dn1Image[dn1KitBase + DN1_KIT.levelOffset + track * 2 + 1]! << 8);

  for (let track = 0; track < DN1_KIT_SOUNDS; track++) {
    kitView.setUint16(kitBase + DN2_KIT_LEVEL_OFFSET + track * 2, dn1Level(track), true);
  }
  // A promoted track inherits the level of the track its trigs were lifted out of, so the
  // mix balance survives expansion instead of every new track jumping to the default.
  for (const [destination, source] of levelSources) {
    kitView.setUint16(
      kitBase + DN2_KIT_LEVEL_OFFSET + destination * 2,
      dn1Level(source),
      true,
    );
  }

  // Kit-level FX: delay, chorus and reverb device settings. Without this a converted
  // project keeps the template's effects rather than its own.
  applyFieldCopies(out, kitBase, dn1Image, dn1KitBase + DN1_KIT.fxOffset, KIT_FX_MAP);
  applyFieldConstants(out, kitBase, KIT_FX_CONSTANTS);
  writeScaledFxField(out, kitBase, dn1Image, dn1KitBase + DN1_KIT.fxOffset, index, report);

  // Promoted sounds become their destination track's own sound.
  const pool = readSoundPool(dn1Image);
  for (const [destinationTrack, poolSlot] of promotions) {
    const source = pool[poolSlot];
    if (!source?.name) continue;
    const { sound, warnings } = convertDn1SoundToDn2Detailed(source.data);
    out.set(sound, kitBase + DN2_KIT_SOUND_OFFSET + destinationTrack * DN2_SOUND_SIZE);
    // A promoted sound comes from the DN1, so it is FM TONE whatever the template had here.
    out[kitBase + DN2_KIT_SOUND_OFFSET + destinationTrack * DN2_SOUND_SIZE + SOUND_MACHINE_OFFSET] =
      MACHINE.fmTone;
    report.soundsConverted++;
    for (const w of warnings) {
      report.warnings.push({
        kind: "sound",
        pattern: index,
        track: destinationTrack,
        message: `promoted sound on track ${destinationTrack + 1}: ${describeSoundWarning(w)}`,
      });
    }
  }

  writeMidiTrackRecords(out, kitBase, dn1Kit);

  // A claimed track in 5-8 was configured as MIDI by the import and must be switched to
  // synth, which is one bit in the kit's mask.
  let mask = DN1_MIDI_MASK;
  for (const destinationTrack of promotions.keys()) mask &= ~(1 << destinationTrack) & 0xffff;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
    kitBase + KIT_MIDI_MASK_OFFSET,
    mask,
    false,
  );
}

/**
 * The one FX field the importer rescales rather than copies.
 *
 * Writes both bytes of the destination: the compressor volume and the fine byte beside it.
 * They are separate fields — see `FX_COMPRESSOR_VOLUME` — so they are written as two bytes
 * rather than one wide integer, even though the pair happens to be adjacent.
 *
 * An unknown source value leaves the destination as the template had it and reports it,
 * because a plausible interpolation into a field whose meaning is unknown is exactly the kind
 * of guess that ends up on hardware.
 */
function writeScaledFxField(
  out: Uint8Array,
  kitBase: number,
  dn1Image: Uint8Array,
  dn1FxBase: number,
  patternIndex: number,
  report: ConversionReport,
): void {
  const source = dn1Image[dn1FxBase + FX_COMPRESSOR_VOLUME.from]!;
  const scaled = FX_COMPRESSOR_VOLUME.table.get(source);

  if (scaled === undefined) {
    report.warnings.push({
      kind: "parameter",
      pattern: patternIndex,
      message:
        `kit FX +0x${FX_COMPRESSOR_VOLUME.from.toString(16)} = ${source} is outside the known ` +
        "rescaling table, so the destination keeps the template's value",
    });
    return;
  }

  const [coarse, fine] = scaled;
  out[kitBase + FX_COMPRESSOR_VOLUME.coarseAt] = coarse;
  out[kitBase + FX_COMPRESSOR_VOLUME.fineAt] = fine;
}

/**
 * Carry the four DN1 MIDI track configurations onto DN2 tracks 5-8.
 *
 * Positional, exactly as the pattern records are: DN1 MIDI track n to DN2 track 4+n. Without
 * this a project that uses its MIDI tracks arrives with the template's channels and CC
 * assignments — silently, since nothing is missing, it is just someone else's configuration.
 */
function writeMidiTrackRecords(out: Uint8Array, kitBase: number, dn1Kit: ReturnType<typeof readKit>): void {
  // The importer clears the track name on ALL sixteen records, not just the four it fills.
  // A native DN2 names them "MIDI 1".."MIDI 16", so a template contributes sixteen names we
  // would otherwise inherit — 10,112 bytes per project, and the largest single divergence
  // from Elektron's output once the configuration itself is transferred.
  for (let track = 0; track < DN2_TRACK_COUNT; track++) {
    const record = kitBase + DN2_KIT_MIDI_OFFSET + track * DN2_MIDI_RECORD_SIZE;
    applyFieldConstants(out, record, MIDI_TRACK_CONSTANTS);
  }

  for (let track = 0; track < DN1_KIT_SOUNDS; track++) {
    const source = dn1Kit.midi[track];
    if (!source) continue;

    // DN1 MIDI track n lands on DN2 track 4+n, the same positional rule as the pattern.
    const destination = kitBase + DN2_KIT_MIDI_OFFSET + (SYNTH_TRACK_COUNT + track) * DN2_MIDI_RECORD_SIZE;
    applyFieldCopies(out, destination, source, 0, MIDI_TRACK_MAP);
  }
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
    trigsPromoted: 0,
    tracksUsed: new Set<number>(),
    trigsWritten: 0,
    soundLocksWritten: 0,
    lockRecordsWritten: 0,
    soundsConverted: 0,
    warnings: [],
  };

  // The project name lives at image+8 on both devices, 16 bytes including residue.
  if (options.projectName === undefined) copyNameField(out, 8, dn1Image, 8, NAME_FIELD_SIZE);
  else writeNameField(out, 8, options.projectName);

  // Empty when no plan is given, which makes routing the identity and the whole conversion
  // faithful rather than expanded.
  const destinations = options.plan ? destinationsBySound(options.plan) : new Map<string, number>();

  // A per-pattern plan overrides the global one pattern by pattern. Patterns it does not
  // mention have no trigs, so the global map applies harmlessly.
  const perPattern = options.plan?.perPattern;

  const limit = Math.min(options.patternLimit ?? DN1_LAYOUT.patternCount, DN1_LAYOUT.patternCount);
  for (let index = 0; index < limit; index++) {
    const patternBase = DN2_LAYOUT.headerSize + index * DN2_LAYOUT.patternSize;
    const pattern = readPattern(dn1Image, index);
    const local = perPattern?.get(index);
    const routing = routePattern(
      pattern,
      local ? destinationsBySound({ ...options.plan!, ...local }) : destinations,
    );

    for (const collision of findCollisions(routing)) {
      report.warnings.push({
        kind: "capacity",
        pattern: index,
        track: collision.destinationTrack,
        step: collision.step,
        message:
          `tracks ${collision.sourceTracks.map((t) => t + 1).join(" and ")} both place a trig on ` +
          `step ${collision.step} of track ${collision.destinationTrack + 1}: ${collision.reason}`,
      });
    }

    const sourceByTrack = new Map(pattern.tracks.map((t) => [t.index, t]));
    for (let destination = 0; destination < DN2_TRACK_COUNT; destination++) {
      const entries = routing.byDestination.get(destination) ?? [];
      // Tracks 0-7 are always written, so the template's contents cannot leak through.
      // Tracks 8-15 are only touched when promotion puts something there.
      if (destination >= DN1_TRACK_COUNT && entries.length === 0) continue;

      // A promoted track inherits the settings of the track its trigs came from, so it stays
      // in sync with the music it was lifted out of.
      const settingsSource =
        sourceByTrack.get(destination) ??
        (entries.length ? sourceByTrack.get(entries[0]!.sourceTrack) : undefined);

      writeTrack(out, patternBase, destination, entries, settingsSource, index, report);
    }

    writeTrigSlots(out, patternBase, routing.routed, index, report);

    const routedByKey = new Map(
      routing.routed.map((e) => [`${e.sourceTrack}:${e.trig.step}`, e.destinationTrack]),
    );
    writeLockTable(
      out,
      patternBase,
      dn1Image,
      index,
      (track, step) => routedByKey.get(`${track}:${step}`) ?? track,
      report,
    );

    writePatternMetadata(out, patternBase, pattern, dn1Image);

    // Keyed by destination, not by pool slot: a sound whose source tracks could not be
    // merged occupies two destinations, and keying the other way round would write only one
    // of them.
    const promotions = new Map<number, number>();
    for (const entry of routing.routed) {
      if (entry.clearSoundLock && entry.trig.soundLock !== undefined) {
        promotions.set(entry.destinationTrack, entry.trig.soundLock);
      }
    }
    // Which source track each promoted destination should inherit its level from.
    const levelSources = new Map<number, number>();
    for (const entry of routing.routed) {
      if (entry.clearSoundLock && !levelSources.has(entry.destinationTrack)) {
        levelSources.set(entry.destinationTrack, entry.sourceTrack);
      }
    }
    writeKit(out, dn1Image, index, promotions, levelSources, report);

    report.trigsPromoted += routing.moved;
    for (const t of routing.destinationsUsed) report.tracksUsed.add(t + 1);
    report.patternsWritten++;
  }

  writeSoundPool(out, dn1Image, report);

  return { image: out, report };
}
