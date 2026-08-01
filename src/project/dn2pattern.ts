/**
 * Digitone II pattern record: tracks, trigs, sound locks and parameter locks.
 *
 * This module operates on a **decompressed** DN2 project image (`decodeProjectImage` in
 * `dn2codec.ts`), or equivalently on the first 89,088 bytes of a SysEx pattern-dump
 * payload — those are the same bytes, see `dn2image.patternAsSysexPayload`.
 *
 * Everything here was derived two ways and the two agree:
 *
 *  1. **Matched pairs.** Nine DN1 projects and Elektron's own DN2 conversions of them.
 *     `dn1.readPattern` already decodes the DN1 side exactly, so for every one of the
 *     7,713 trigs in 1,152 pattern pairs we knew the answer before looking at the DN2
 *     bytes. Cross-validation lives in `test/dn2pattern.test.ts`.
 *  2. **Single-variable SysEx captures.** 419 native DN2 pattern dumps from the
 *     emnyeca/digitone-syx-toolkit corpus, each isolating one variable (one trig added,
 *     one velocity changed, one track length changed, ...). These pin fields that the
 *     matched pairs leave ambiguous, and they show what the *device* writes as opposed to
 *     what Elektron's DN1 importer writes.
 *
 * Geometry of the 89,088-byte pattern record. Every boundary below is exact arithmetic,
 * and the three array bases chain into each other with no slack:
 *
 *     0x00000  u32be           record version, 3 in all 1,571 records examined
 *     0x00004  16 x 1,187      track records            -> ends exactly at 0x4A34
 *     0x04A34  8,192 x 6       trigger slots            -> ends exactly at 0x10A34
 *     0x10A34  80 x 258        parameter-lock records   -> ends exactly at 0x15AD4
 *     0x15AD4  44              pattern metadata (name, tempo, length, speed, slot)
 *     0x15B00  256             0xFF padding to the end of the record
 *
 * `4 + 16*1187 = 18,996 = 0x4A34`, `0x4A34 + 8192*6 = 0x10A34`, `0x10A34 + 80*258 = 0x15AD4`.
 * The chain closing three times in a row on independently discovered bases is the main
 * evidence that the record sizes are right.
 *
 * Track record, 1,187 bytes:
 *
 *     +0x000  128 x u16be   step flag words (one per step, not packed pairs)
 *     +0x100  128 x u8      trig condition, ratio/logic family   (0xFF = none)
 *     +0x180  128 x u8      trig condition, second family        (0xFF = none)
 *     +0x200  128 x u8      per-trig probability, percent        (0xFF = none)
 *     +0x280  128 x u8      unidentified, 0xFF everywhere in both corpora
 *     +0x300  128 x u8      unidentified, 0xFF everywhere in both corpora
 *     +0x380  128 x u8      unidentified, 0xFF everywhere in both corpora
 *     +0x400  128 x u8      sound lock, index into the 128-slot pool (0xFF = none)
 *     +0x480  35            track settings
 *
 * Trigger slot, 6 bytes: `track | step | note | velocity | noteLength | microTiming`.
 * A slot whose first byte is 0xFF is unused. Note 0xFF means a trigless lock trig.
 *
 * Parameter-lock record, 258 bytes: `u8 parameter | u8 track | 128 x (u8 coarse, u8 fine)`.
 * Header 0xFFFF means the record is unused; a slot of 0xFFFF means the step is not locked.
 * See `lockvalue.ts` — the two value bytes are not a little-endian integer.
 * Same shape as the DN1 table (`u8 | u8 | 64 x u16le`), widened to 128 steps.
 *
 * What is NOT here: the per-track synth/MIDI discriminator does not live in the pattern
 * record at all. It is a bitmask in the kit record — see `readMidiTrackMask`.
 */

import { DN2_LAYOUT, kitRecord, patternRecord, type ImageLayout } from "./dn2image.js";

// --- constants ------------------------------------------------------------

/** Steps in a DN2 pattern. Twice the DN1's 64. */
export const STEP_COUNT = 128;

/** Track records per pattern. Twice the DN1's 8. */
export const TRACK_COUNT = 16;

/** Record version at pattern offset 0. 3 in all 1,152 project + 419 SysEx records checked. */
export const RECORD_VERSION = 3;

/** "Unset / inherit" fill for the u8 per-step arrays and the trigger-slot header. */
const NO_U8 = 0xff;
/** "Not locked" / "record unused" fill in the parameter-lock table. */
const NO_U16 = 0xffff;

/**
 * Pattern record internals, all relative to the start of the record.
 *
 * VERIFIED. The three array bases were found independently — the track base and stride
 * from the `40 40 40` marker recurring 16 times at 1,187-byte spacing, the trigger base
 * from the emnyeca corpus, the lock base by hunting known DN1 lock values inside a DN2
 * conversion — and then each array's end landed exactly on the next array's start.
 */
export const PATTERN = {
  size: 89_088,
  versionOffset: 0,

  trackOffset: 0x0004,
  trackSize: 1_187,
  trackCount: TRACK_COUNT,

  trigOffset: 0x4a34,
  trigSize: 6,
  /** `(0x10A34 - 0x4A34) / 6`. The region is 0xFF-filled in a native empty pattern. */
  trigCount: 8_192,

  lockOffset: 0x10a34,
  lockSize: 258,
  /** `(0x15AD4 - 0x10A34) / 258`. Same capacity as the DN1's 80-record table. */
  lockCount: 80,

  /** Start of the metadata block. Offsets below are absolute within the pattern record. */
  metaOffset: 0x15ad4,
  nameOffset: 0x15ad4,
  nameSize: 16,
  /** meta+0x12, u16be, `bpm * 120` — the same encoding the DN1 uses. */
  tempoOffset: 0x15ae6,
  /** meta+0x14, u16be, master pattern length in steps, 1..1024. */
  lengthOffset: 0x15ae8,
  /** meta+0x16, u16be, pattern change length ("CHNG"), 1..1024, 1 = off. */
  changeLengthOffset: 0x15aea,
  /** meta+0x19, u8, 0 = one length for the whole pattern, 1 = per-track lengths. */
  scaleModeOffset: 0x15aed,
  /** meta+0x1A, u8, pattern-level speed, same enum as the per-track speed. */
  speedOffset: 0x15aee,
  /** meta+0x1C, u8, the slot index the record believes it occupies. */
  slotIndexOffset: 0x15af0,
} as const;

/** Track record internals, relative to the start of the track record. */
export const TRACK = {
  size: 1_187,
  flagsOffset: 0x000,
  /** DN1 trig conditions 24..42 land here. */
  conditionOffset: 0x100,
  /** DN1 trig conditions 22 and 23 land here, as 1 and 0. */
  conditionAltOffset: 0x180,
  /** DN1 trig conditions 6..21 land here as 19..100, i.e. a percentage. */
  probabilityOffset: 0x200,
  /** Three more 128-byte arrays. 0xFF in every byte of both corpora. */
  reservedOffset: 0x280,
  reservedArrayCount: 3,
  soundLockOffset: 0x400,
  settingsOffset: 0x480,
  settingsSize: 35,

  /** Within the settings block: default note for new trigs. 0x3C (C5) by default. */
  settingsDefaultNoteOffset: 0x00,
  /** Within the settings block: default velocity. 0x64 (100) by default. */
  settingsDefaultVelocityOffset: 0x01,
  /** Within the settings block: default note length. 0x0E by default. */
  settingsDefaultNoteLengthOffset: 0x02,
  /** Within the settings block: track length in steps, 1..128. Default 16. */
  settingsLengthOffset: 0x0d,
  /** Within the settings block: speed enum, see `TRACK_SPEED`. Default 2 (1x). */
  settingsSpeedOffset: 0x0f,
} as const;

/**
 * Per-step flag-word bits.
 *
 * The array is 128 u16be words, one per step — not the DN1's 32 u32be words holding two
 * steps each. Confirmed by single-variable captures: adding a trig on track 1 step 1
 * flips exactly the u16be at track+0, and a trig on step 16 flips the u16be at track+30.
 */
export const STEP_FLAG = {
  /**
   * A trig of some kind occupies this step. VERIFIED: across 1,571 pattern records this
   * bit is set on exactly the steps that have a trigger-slot record, in both directions,
   * with zero exceptions.
   */
  trig: 0x0001,
  /**
   * Set on odd-numbered steps of every track the device or the DN1 importer wrote.
   * Meaning UNKNOWN — it is not needed to decode anything. Note it is *absent* on tracks
   * an import left untouched, which carry `STEP_FLAG.untouched` instead.
   */
  oddStep: 0x0010,
  /**
   * Set together on a note trig by both the device (as part of 0x0381) and the DN1
   * importer (as 0x0181). Individual meanings UNKNOWN.
   */
  note: 0x0180,
  /**
   * Set by the device on a note trig but never by the DN1 importer. Since Elektron's own
   * conversions load on hardware without it, it is not required. Meaning UNKNOWN.
   */
  deviceNote: 0x0200,
  /**
   * Trigless "lock" trig: parameter locks and per-step values but no note.
   * VERIFIED: 1,517 DN1 lock trigs became DN2 words 0x0801 / 0x0811, and every one of them
   * has 0xFF in the note byte of its trigger slot. No note trig ever carries this bit.
   */
  lockTrig: 0x0800,
  /**
   * Present on every step of DN2 tracks 8-15 in a DN1 import, i.e. exactly the tracks the
   * importer never populated, and on no other track. Meaning UNKNOWN; treated as inert.
   */
  untouched: 0x2000,
} as const;

/**
 * Per-track and per-pattern speed enum.
 *
 * VERIFIED by the `Per_Track_Speed_T01` and `Pattern_Speed_Field` capture sets, which walk
 * the UI through all seven settings one step at a time. The DN1 uses the same codes.
 */
export const TRACK_SPEED: Readonly<Record<number, string>> = {
  0: "2x",
  1: "3/2x",
  2: "1x",
  3: "3/4x",
  4: "1/2x",
  5: "1/4x",
  6: "1/8x",
};

/**
 * Offset of the MIDI-track bitmask inside a 10,752-byte kit record.
 *
 * u16be, bit *t* set means track *t* is a MIDI track rather than a synth track.
 * VERIFIED: 0x00F0 (tracks 4-7) in all 1,152 kits of the nine DN1 conversions — a DN1
 * project always has four synth tracks then four MIDI tracks — and 0x0000 in all 419
 * native captures, which have no MIDI track configured. The DN2 stores a sound slot *and*
 * a MIDI record for all 16 tracks regardless, so this mask is the only discriminator.
 */
export const KIT_MIDI_MASK_OFFSET = 10_260;

export class Dn2PatternError extends Error {}

// --- types ----------------------------------------------------------------

export interface Dn2ParameterLock {
  /**
   * Parameter id as stored. This is the DN2's own numbering; it is NOT the DN1's.
   * The importer remaps (DN1 67/68/69 -> DN2 94/93/92, DN1 51 -> 74, and so on).
   * The mapping to named synth parameters is not established.
   */
  parameter: number;
  /** Locked value, u16le as stored. */
  value: number;
}

/** One 6-byte trigger slot, decoded. */
export interface Dn2TrigSlot {
  /** Index of the slot in the 8,192-entry array. */
  slot: number;
  /** Track index 0..15. */
  track: number;
  /** Step index 0..127. */
  step: number;
  /** MIDI note, or 0xFF on a trigless lock trig. Raw, undecoded. */
  note: number;
  /** Velocity, or 0xFF to inherit the track default. Raw. */
  velocity: number;
  /** Note length, or 0xFF to inherit the track default. Raw. */
  noteLength: number;
  /** Micro timing as stored. This is an i8: 0xFF is -1, not "unset". */
  microTiming: number;
}

export interface Dn2Trig {
  /** Step index, 0..127. */
  step: number;
  /** Raw flag word for this step. */
  flags: number;
  /**
   * True when this trig sounds a note. Read from the flag word, not from the note byte:
   * three trigs in the corpus are trigless yet still carry a stale note byte, exactly as
   * their DN1 originals do, so `note` can be defined while this is false.
   */
  hasNote: boolean;
  /** True when this is a trigless lock trig (`STEP_FLAG.lockTrig`). */
  isLockTrig: boolean;
  /** Root MIDI note as stored, or undefined when the note byte is 0xFF. */
  note?: number;
  /**
   * Every note on this step in stored order, root first. A chord is stored as extra
   * trigger slots that repeat the same `(track, step)` and carry absolute note numbers;
   * up to 16 notes were captured on one step.
   */
  notes: number[];
  /**
   * Chord notes as signed semitone offsets from `note`, mirroring the DN1 API.
   * Derived from `notes`, not stored that way.
   */
  chord: number[];
  /** Velocity lock, or undefined when the track default applies. */
  velocity?: number;
  /** Note length lock, or undefined when the track default applies. */
  noteLength?: number;
  /** Micro timing, signed. 0 when none. */
  microTiming: number;
  /**
   * Trig condition code from the `+0x100` array, or undefined when unconditional.
   * DN1 conditions 24..42 map into this array; the code is the DN2's own numbering.
   */
  trigCondition?: number;
  /**
   * Second trig-condition field, from the `+0x180` array. Only the values 0 and 1 have
   * ever been observed (from DN1 conditions 23 and 22). Semantics UNKNOWN.
   */
  trigConditionAlt?: number;
  /**
   * Per-trig probability in percent, from the `+0x200` array, or undefined when none.
   * DN1's percentage conditions land here as 19, 25, 33, 41, 50, 59, 67, 75, 87 and 100.
   */
  probability?: number;
  /** Sound-pool slot 0..127 locked to this step, or undefined. */
  soundLock?: number;
  /** Parameter locks active on this step. */
  locks: Dn2ParameterLock[];
  /** The trigger slots that produced this trig, root first. */
  slots: Dn2TrigSlot[];
}

export interface Dn2TrackSettings {
  /** Default note for new trigs on this track. */
  defaultNote: number;
  /** Default velocity. */
  defaultVelocity: number;
  /** Default note length. */
  defaultNoteLength: number;
  /** Track length in steps, 1..128. */
  length: number;
  /** Speed enum, see `TRACK_SPEED`. */
  speed: number;
  /** The whole 35-byte block verbatim, so unidentified fields survive a round trip. */
  raw: Uint8Array;
}

export interface Dn2Track {
  /** 0..15. */
  index: number;
  /**
   * Whether the track is a synth track or a MIDI track. This cannot be read from the
   * pattern record; it comes from the kit's MIDI bitmask and is only populated when
   * `readDn2Pattern` is given a whole image. Undefined when reading a bare record.
   */
  kind?: "synth" | "midi";
  /** Track length in steps, from the settings block. */
  length: number;
  /** Speed enum, from the settings block. */
  speed: number;
  settings: Dn2TrackSettings;
  /** Steps that carry a note trig or a lock trig, in step order. */
  trigs: Dn2Trig[];
}

export interface Dn2Pattern {
  index: number;
  /** Record version at offset 0. 3 in every record seen. */
  version: number;
  /** Pattern name. Also mirrored in the kit record's name field at kit+8. */
  name: string;
  /** Beats per minute. Stored as `bpm * 120` in a u16be. */
  tempo: number;
  /** Master pattern length in steps. */
  length: number;
  /** Pattern change length ("CHNG"). 1 means off. */
  changeLength: number;
  /** 0 = one length for the whole pattern, 1 = per-track lengths. */
  perTrackScale: boolean;
  /** Pattern-level speed enum, see `TRACK_SPEED`. */
  speed: number;
  /** The slot index the record believes it occupies. Mirrors the DN1's own slot index. */
  slotIndex: number;
  tracks: Dn2Track[];
}

export interface Dn2LockRecord {
  /** Index of the record in the 80-entry table. Order is meaningful: it is preserved
   *  one-for-one from the DN1 table by Elektron's importer. */
  index: number;
  track: number;
  parameter: number;
  /**
   * 128 slots, `LOCK_UNSET` (0xFFFF) where the step is not locked.
   *
   * Each slot is `coarse << 8 | fine`, **not** a plain integer — decode it with the
   * helpers in `lockvalue.ts`. `lockCoarse` alone is the value for any 0-127 parameter.
   */
  values: number[];
}

// --- primitives -----------------------------------------------------------

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const latin1 = new TextDecoder("latin1");
const signed8 = (b: number) => (b > 127 ? b - 256 : b);

function readName(data: Uint8Array, at: number, size: number): string {
  const raw = data.subarray(at, at + size);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul));
}

function assertIndex(index: number, count: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`${what} index ${index} out of range 0..${count - 1}`);
  }
}

// --- record slicing -------------------------------------------------------

/** Slice track `index` out of a DN2 pattern record. */
export function trackRecord(pattern: Uint8Array, index: number): Uint8Array {
  assertIndex(index, TRACK_COUNT, "track");
  const at = PATTERN.trackOffset + index * PATTERN.trackSize;
  return pattern.subarray(at, at + PATTERN.trackSize);
}

/**
 * Read the flag word for one step of one track.
 *
 * One u16be per step, no packing. VERIFIED against 1,571 pattern records: bit 0 agrees
 * with "this step has a trigger slot" in both directions with zero exceptions.
 */
export function stepFlags(track: Uint8Array, step: number): number {
  assertIndex(step, STEP_COUNT, "step");
  return view(track).getUint16(TRACK.flagsOffset + step * 2, false);
}

/** Read the per-step sound lock for one track. 0xFF means no lock. */
export function soundLockAt(track: Uint8Array, step: number): number {
  assertIndex(step, STEP_COUNT, "step");
  return track[TRACK.soundLockOffset + step]!;
}

/** Decode the 35-byte per-track settings block. */
export function readTrackSettings(track: Uint8Array): Dn2TrackSettings {
  const raw = track.subarray(TRACK.settingsOffset, TRACK.settingsOffset + TRACK.settingsSize);
  return {
    defaultNote: raw[TRACK.settingsDefaultNoteOffset]!,
    defaultVelocity: raw[TRACK.settingsDefaultVelocityOffset]!,
    defaultNoteLength: raw[TRACK.settingsDefaultNoteLengthOffset]!,
    length: raw[TRACK.settingsLengthOffset]!,
    speed: raw[TRACK.settingsSpeedOffset]!,
    raw,
  };
}

// --- trigger slots --------------------------------------------------------

/**
 * Read every used slot of the 8,192-entry trigger array.
 *
 * The whole array is scanned rather than stopped at the first 0xFF, because the device
 * leaves **holes**: in `order_compaction/4_step1deleded.syx` slot 0 is freed while slot 1
 * still holds a live trig. Elektron's DN1 importer happens to write a dense, sorted
 * prefix, but relying on that would silently drop trigs from a device-written pattern.
 *
 * Scanning the whole array is safe: across all 1,571 records examined, every slot past the
 * live set has 0xFF in its first byte, even where the surrounding bytes hold uncleared
 * residue from an earlier edit.
 */
export function readTrigSlots(pattern: Uint8Array): Dn2TrigSlot[] {
  const out: Dn2TrigSlot[] = [];
  for (let slot = 0; slot < PATTERN.trigCount; slot++) {
    const at = PATTERN.trigOffset + slot * PATTERN.trigSize;
    const track = pattern[at]!;
    if (track === NO_U8) continue;
    out.push({
      slot,
      track,
      step: pattern[at + 1]!,
      note: pattern[at + 2]!,
      velocity: pattern[at + 3]!,
      noteLength: pattern[at + 4]!,
      microTiming: pattern[at + 5]!,
    });
  }
  return out;
}

// --- parameter locks ------------------------------------------------------

/**
 * Read the pattern's parameter-lock table.
 *
 * A flat pool of 80 records shared by all 16 tracks, allocated from slot 0 upwards — the
 * same design as the DN1's, widened from 64 to 128 steps (130 -> 258 bytes per record).
 *
 * Each of the 128 value slots is a **coarse byte followed by a fine byte**, read here as a
 * `u16be` so that `lockCoarse`/`lockFine` in `lockvalue.ts` can split it. Reading the pair
 * as a little-endian integer, as this did until 2026-07-26, turns an LFO depth of -1.00
 * into 32,575.
 *
 * VERIFIED: over the nine matched pairs, 392 lock records were compared against the DN1
 * originals. All 392 agree on track and on the exact set of locked steps, in the same
 * table order; 389 also agree on every value. The three that differ do so only in value
 * (17->25, 43->51, 71->89, 1->0), which is the importer rescaling a parameter whose range
 * changed, not a structural difference.
 */
export function readLockTable(pattern: Uint8Array): Dn2LockRecord[] {
  const dv = view(pattern);
  const out: Dn2LockRecord[] = [];
  for (let index = 0; index < PATTERN.lockCount; index++) {
    const at = PATTERN.lockOffset + index * PATTERN.lockSize;
    const header = dv.getUint16(at, true);
    if (header === NO_U16) continue;
    const values: number[] = [];
    for (let s = 0; s < STEP_COUNT; s++) values.push(dv.getUint16(at + 2 + s * 2, false));
    out.push({ index, parameter: header & 0xff, track: header >>> 8, values });
  }
  return out;
}

// --- kit-side track mode --------------------------------------------------

/**
 * Which tracks of a kit are MIDI tracks, as a 16-bit mask (bit `t` = track `t`).
 *
 * Lives in the kit record, not the pattern record: the DN2 allocates a sound slot and a
 * MIDI record for all 16 tracks unconditionally, so nothing in the pattern distinguishes
 * them. See `KIT_MIDI_MASK_OFFSET` for the evidence.
 */
export function readMidiTrackMask(image: Uint8Array, index: number, layout: ImageLayout = DN2_LAYOUT): number {
  const kit = kitRecord(image, index, layout);
  return (kit[KIT_MIDI_MASK_OFFSET]! << 8) | kit[KIT_MIDI_MASK_OFFSET + 1]!;
}

/** Same mask, read from a bare 10,752-byte kit record. */
export function midiTrackMaskOf(kit: Uint8Array): number {
  return (kit[KIT_MIDI_MASK_OFFSET]! << 8) | kit[KIT_MIDI_MASK_OFFSET + 1]!;
}

// --- patterns -------------------------------------------------------------

/**
 * Decode a bare 89,088-byte pattern record.
 *
 * Use this when working from a SysEx pattern dump; `readDn2Pattern` is the image-level
 * entry point and additionally fills in `Dn2Track.kind` from the kit.
 */
export function readDn2PatternRecord(pattern: Uint8Array, index = 0, midiMask?: number): Dn2Pattern {
  if (pattern.length < PATTERN.size) {
    throw new Dn2PatternError(`Pattern record is ${pattern.length} bytes, expected ${PATTERN.size}`);
  }
  const dv = view(pattern);
  const locks = readLockTable(pattern);

  // Group trigger slots by (track, step). Chord notes repeat the key, and are stored
  // immediately after their root, so stored order is the chord's voice order.
  const byTrackStep = new Map<number, Dn2TrigSlot[]>();
  for (const slot of readTrigSlots(pattern)) {
    if (slot.track >= TRACK_COUNT || slot.step >= STEP_COUNT) continue;
    const key = slot.track * STEP_COUNT + slot.step;
    const group = byTrackStep.get(key);
    if (group) group.push(slot);
    else byTrackStep.set(key, [slot]);
  }

  const tracks: Dn2Track[] = [];
  for (let t = 0; t < TRACK_COUNT; t++) {
    const track = trackRecord(pattern, t);
    const settings = readTrackSettings(track);
    const trackLocks = locks.filter((record) => record.track === t);
    const trigs: Dn2Trig[] = [];

    for (let step = 0; step < STEP_COUNT; step++) {
      const flags = stepFlags(track, step);
      if ((flags & STEP_FLAG.trig) === 0) continue;

      const slots = byTrackStep.get(t * STEP_COUNT + step) ?? [];
      const root = slots[0];
      const isLockTrig = (flags & STEP_FLAG.lockTrig) !== 0;
      const noteByte = root?.note ?? NO_U8;
      const notes = slots.map((s) => s.note).filter((n) => n !== NO_U8);
      const chord = noteByte === NO_U8 ? [] : notes.slice(1).map((n) => n - noteByte);

      const velocity = root?.velocity ?? NO_U8;
      const noteLength = root?.noteLength ?? NO_U8;
      const condition = track[TRACK.conditionOffset + step]!;
      const conditionAlt = track[TRACK.conditionAltOffset + step]!;
      const probability = track[TRACK.probabilityOffset + step]!;
      const soundLock = track[TRACK.soundLockOffset + step]!;

      const stepLocks: Dn2ParameterLock[] = [];
      for (const record of trackLocks) {
        const value = record.values[step]!;
        if (value !== NO_U16) stepLocks.push({ parameter: record.parameter, value });
      }

      trigs.push({
        step,
        flags,
        hasNote: !isLockTrig,
        isLockTrig,
        ...(noteByte === NO_U8 ? {} : { note: noteByte }),
        notes,
        chord,
        ...(velocity === NO_U8 ? {} : { velocity }),
        ...(noteLength === NO_U8 ? {} : { noteLength }),
        microTiming: signed8(root?.microTiming ?? 0),
        ...(condition === NO_U8 ? {} : { trigCondition: condition }),
        ...(conditionAlt === NO_U8 ? {} : { trigConditionAlt: conditionAlt }),
        ...(probability === NO_U8 ? {} : { probability }),
        ...(soundLock === NO_U8 ? {} : { soundLock }),
        locks: stepLocks,
        slots,
      });
    }

    tracks.push({
      index: t,
      ...(midiMask === undefined ? {} : { kind: (midiMask >> t) & 1 ? ("midi" as const) : ("synth" as const) }),
      length: settings.length,
      speed: settings.speed,
      settings,
      trigs,
    });
  }

  return {
    index,
    version: dv.getUint32(PATTERN.versionOffset, false),
    name: readName(pattern, PATTERN.nameOffset, PATTERN.nameSize),
    tempo: dv.getUint16(PATTERN.tempoOffset, false) / 120,
    length: dv.getUint16(PATTERN.lengthOffset, false),
    changeLength: dv.getUint16(PATTERN.changeLengthOffset, false),
    perTrackScale: pattern[PATTERN.scaleModeOffset] === 1,
    speed: pattern[PATTERN.speedOffset]!,
    slotIndex: pattern[PATTERN.slotIndexOffset]!,
    tracks,
  };
}

/** Decode pattern `index` of a decompressed DN2 project image. */
export function readDn2Pattern(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN2_LAYOUT,
): Dn2Pattern {
  return readDn2PatternRecord(patternRecord(image, index, layout), index, readMidiTrackMask(image, index, layout));
}

// --- whole-record checks --------------------------------------------------

export interface Dn2PatternCheck {
  ok: boolean;
  /** One line per failed expectation. Empty when `ok`. */
  problems: string[];
}

/**
 * Assert the documented geometry against an actual pattern record.
 *
 * Every check here passes on all 1,152 project records and all 419 SysEx captures. It is
 * cheap, and worth running before trusting any offset here against a record written by an
 * unseen OS version — or against a record this project has just built.
 */
export function checkDn2PatternRecord(pattern: Uint8Array): Dn2PatternCheck {
  const problems: string[] = [];
  if (pattern.length < PATTERN.size) {
    problems.push(`record is ${pattern.length} bytes, expected at least ${PATTERN.size}`);
    return { ok: false, problems };
  }

  const dv = view(pattern);
  const version = dv.getUint32(PATTERN.versionOffset, false);
  if (version !== RECORD_VERSION) problems.push(`record version is ${version}, expected ${RECORD_VERSION}`);

  const flagged = new Set<number>();
  for (let t = 0; t < TRACK_COUNT; t++) {
    const track = trackRecord(pattern, t);
    for (let s = 0; s < STEP_COUNT; s++) {
      if ((stepFlags(track, s) & STEP_FLAG.trig) !== 0) flagged.add(t * STEP_COUNT + s);
    }
  }

  const slotted = new Set<number>();
  for (const slot of readTrigSlots(pattern)) {
    if (slot.track >= TRACK_COUNT) {
      problems.push(`trigger slot ${slot.slot} names track ${slot.track}`);
      continue;
    }
    if (slot.step >= STEP_COUNT) {
      problems.push(`trigger slot ${slot.slot} names step ${slot.step}`);
      continue;
    }
    slotted.add(slot.track * STEP_COUNT + slot.step);
  }

  for (const key of flagged) {
    if (!slotted.has(key)) {
      problems.push(`track ${Math.floor(key / STEP_COUNT)} step ${key % STEP_COUNT} is flagged but has no trigger slot`);
    }
  }
  for (const key of slotted) {
    if (!flagged.has(key)) {
      problems.push(`track ${Math.floor(key / STEP_COUNT)} step ${key % STEP_COUNT} has a trigger slot but is not flagged`);
    }
  }

  for (const record of readLockTable(pattern)) {
    if (record.track >= TRACK_COUNT) {
      problems.push(`lock record ${record.index} names track ${record.track}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Same check, applied to pattern `index` of a decompressed image. */
export function checkDn2Pattern(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN2_LAYOUT,
): Dn2PatternCheck {
  return checkDn2PatternRecord(patternRecord(image, index, layout));
}
