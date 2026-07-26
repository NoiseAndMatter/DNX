/**
 * Digitone 1 project image: pattern, kit and sound-pool records.
 *
 * This module operates on the **decompressed** project image produced by
 * `decodeProjectImage` in `dn2codec.ts`. It never touches the raw `.dnprj` payload.
 *
 * An earlier version of this file walked the raw payload looking for `BE EF BA CE`
 * magics and tried to reverse a "variable-length record encoding". That premise was
 * wrong: the payload body is a chain of LZ4 linked blocks, and the byte patterns that
 * looked like control codes were LZ4 tokens and u16le match offsets. Once decompressed
 * there is no scanning to do at all — the image is a flat array of fixed-size records,
 * and every offset below is arithmetic on a constant.
 *
 * Geometry (all verified against the decompressed images of all 53 corpus `.dnprj`
 * files unless marked otherwise — see `docs/dn1-project-format.md` for the evidence):
 *
 *   image                2,781,700 bytes
 *     0x000000  512      header: object magic, u32be version 12, project name
 *     0x000200  128 x 18,432   pattern records
 *     0x240200  128 x 2,560    kit records
 *     0x290200  94,212         tail: sound pool + project settings
 *
 *   pattern record       18,432 bytes
 *     0x0000    u32be    record version, 10 in every one of the 6,784 records
 *     0x0004    8 x 976  track records (0..3 synth T1-T4, 4..7 MIDI A-D)
 *     0x1E84    80 x 130 parameter-lock records
 *     0x4724    16       pattern name, "UNTITLED" by default
 *     0x4736    u16be    tempo x 120
 *     0x4741    u8       own slot index
 *
 *   track record         976 bytes
 *     0x000     32 x u32be   step flag words, two u16be halves per entry
 *     0x080     64 x u8      velocity lock        (0xFF = use track default)
 *     0x0C0     64 x u8      note length lock     (0xFF = use track default)
 *     0x100     64 x i8      micro timing         (0 = none)
 *     0x140     64 x u8      trig condition       (0xFF = none)
 *     0x180     64 x 8       note records: note + up to 7 signed chord offsets
 *     0x380     64 x u8      sound lock, index into the 128-slot pool (0xFF = none)
 *     0x3C0     16           track settings, including length and speed
 *
 *   kit record           2,560 bytes
 *     0x000     u32be    record version, 10 in every one of the 6,784 records
 *     0x004     16       kit name
 *     0x014     4 x u16le  per-synth-track level, 100 by default
 *     0x01C     4 x 302  sound objects, one per synth track
 *     0x4D4     122      FX / kit-level parameter block
 *     0x54E     4 x 172  MIDI track configuration records
 *     0x81A     8 x 29   named slots, "MACRO0".."MACRO7" by default
 *
 *   sound object         302 bytes
 *     +0x000    BE EF BA CE
 *     +0x004    u32be    version, 5 inside a project (a SysEx sound dump carries 2)
 *     +0x008    u32be    tag bitfield
 *     +0x00C    16       name, NUL-terminated, with uncleared residue after the NUL
 *     +0x01C    ...      u16le parameter array
 *     +0x12A    BA CE F0 0C
 */

import { DN1_LAYOUT, type ImageLayout } from "./dn2image.js";

// --- constants ------------------------------------------------------------

/** Object magic that heads every sound, and the image header. */
export const OBJECT_MAGIC = Uint8Array.of(0xbe, 0xef, 0xba, 0xce);

/** Object terminator. The last four bytes of every sound object. */
export const OBJECT_TERMINATOR = Uint8Array.of(0xba, 0xce, 0xf0, 0x0c);

/** Record version carried by both pattern and kit records. 10 in all 6,784 of each. */
export const RECORD_VERSION = 10;

/** Version inside a project sound object. A SysEx sound dump carries 2 instead. */
export const PROJECT_SOUND_VERSION = 5;

/** Steps in a pattern. Every per-step array in a track record has this many entries. */
export const STEP_COUNT = 64;

/** Track records per pattern: 4 synth tracks then 4 MIDI tracks. */
export const TRACK_COUNT = 8;
export const SYNTH_TRACK_COUNT = 4;
export const MIDI_TRACK_COUNT = 4;

/** Size of a sound object inside a project image. */
export const SOUND_SIZE = 302;

/**
 * Bytes of a project sound object that are byte-identical to the corresponding
 * 282-byte SysEx sound dump, once the version field is normalised.
 *
 * Verified on six of the eight sounds that appear both in the factory SysEx banks and
 * in a project image. The other two differ earlier only because the user edited them
 * after loading; there is no structural difference before this offset.
 */
export const SOUND_SYSEX_COMMON_PREFIX = 174;

/** Size of a sound object in a DN1 SysEx sound dump. The project form is 20 bytes longer. */
export const SYSEX_SOUND_SIZE = 282;

/** Pattern record internals. Offsets are relative to the start of the record. */
export const PATTERN = {
  size: 18_432,
  versionOffset: 0,
  trackOffset: 4,
  trackSize: 976,
  lockOffset: 0x1e84,
  lockSize: 130,
  lockCount: 80,
  nameOffset: 0x4724,
  nameSize: 16,
  tempoOffset: 0x4736,
  slotIndexOffset: 0x4741,
} as const;

/** Track record internals. Offsets are relative to the start of the track record. */
export const TRACK = {
  size: 976,
  flagsOffset: 0x000,
  velocityOffset: 0x080,
  noteLengthOffset: 0x0c0,
  microTimingOffset: 0x100,
  trigConditionOffset: 0x140,
  notesOffset: 0x180,
  noteRecordSize: 8,
  soundLockOffset: 0x380,
  settingsOffset: 0x3c0,
  settingsSize: 16,
  /** Within the settings block: track length in steps. Default 16. */
  settingsLengthOffset: 0x0c,
  /** Within the settings block: speed / scale multiplier index. Default 2. */
  settingsSpeedOffset: 0x0d,
} as const;

/** Kit record internals. Offsets are relative to the start of the kit record. */
export const KIT = {
  size: 2_560,
  versionOffset: 0,
  nameOffset: 4,
  nameSize: 16,
  levelOffset: 0x14,
  levelCount: 4,
  soundOffset: 0x1c,
  soundCount: SYNTH_TRACK_COUNT,
  fxOffset: 0x4d4,
  fxSize: 122,
  midiOffset: 0x54e,
  midiSize: 172,
  midiCount: MIDI_TRACK_COUNT,
  macroOffset: 0x81a,
  macroSize: 29,
  macroCount: 8,
} as const;

/** Sound pool, at the head of the tail region. */
export const POOL = {
  versionOffset: 0,
  soundOffset: 4,
  soundCount: 128,
} as const;

/** Bit meanings inside a step flag word. */
export const STEP_FLAG = {
  /** A note trig sits on this step. */
  note: 0x0001,
  /** A trigless "lock" trig sits on this step: parameter locks but no note. */
  lock: 0x0002,
  /** Set on odd-numbered steps only. Never observed on an even step. */
  oddStep: 0x0010,
} as const;

/** Value meaning "no lock" in the per-step lock arrays and the lock table. */
const NO_U8 = 0xff;
const NO_U16 = 0xffff;

export class Dn1ParseError extends Error {}

// --- types ----------------------------------------------------------------

export interface Dn1ParameterLock {
  /** Parameter id. The mapping to a named synth parameter is not established. */
  parameter: number;
  /** Locked value, u16le as stored. */
  value: number;
}

export interface Dn1Trig {
  /** Step index, 0..63. */
  step: number;
  /** Raw flag word for this step. */
  flags: number;
  /** True when a note trig is present (`STEP_FLAG.note`). */
  hasNote: boolean;
  /** True when this is a trigless lock trig (`STEP_FLAG.lock`). */
  isLockTrig: boolean;
  /** MIDI note number, or undefined on a trigless lock trig. */
  note?: number;
  /**
   * Extra chord notes as signed semitone offsets from `note`, trailing zeros removed.
   * Up to seven are storable; three is the most seen anywhere in the corpus.
   */
  chord: number[];
  /** Velocity lock, or undefined when the track default applies. */
  velocity?: number;
  /** Note length lock, or undefined when the track default applies. */
  noteLength?: number;
  /** Micro timing, signed, 0 when none. Every corpus value falls in -23..+23. */
  microTiming: number;
  /** Trig condition code, or undefined when unconditional. */
  trigCondition?: number;
  /** Sound-pool slot 0..127 locked to this step, or undefined. Synth tracks only. */
  soundLock?: number;
  /** Parameter locks active on this step. */
  locks: Dn1ParameterLock[];
}

export interface Dn1Track {
  /** 0..7. Tracks 0..3 are synth tracks T1-T4, tracks 4..7 are MIDI tracks A-D. */
  index: number;
  kind: "synth" | "midi";
  /** Track length in steps, from the settings block. */
  length: number;
  /** Speed / scale multiplier index, from the settings block. */
  speed: number;
  /** The 16-byte settings block verbatim, so unidentified fields survive a round trip. */
  settings: Uint8Array;
  /** Steps that carry a note trig or a lock trig, in step order. */
  trigs: Dn1Trig[];
}

export interface Dn1Pattern {
  index: number;
  version: number;
  name: string;
  /** Beats per minute. Stored as `bpm * 120` in a u16be. */
  tempo: number;
  /** The slot index the record believes it occupies. Usually equals `index`. */
  slotIndex: number;
  tracks: Dn1Track[];
}

export interface Dn1Sound {
  /** Offset of the object within the image. */
  offset: number;
  version: number;
  /** u32be tag bitfield at +8. */
  tagBits: number;
  /** Name up to the first NUL. Empty when the slot is unused. */
  name: string;
  /** The whole 16-byte name field, including uncleared residue past the NUL. */
  nameField: Uint8Array;
  /** True when the object has both its magic and its terminator in place. */
  framed: boolean;
  /** The complete 302-byte object. */
  data: Uint8Array;
}

export interface Dn1Kit {
  index: number;
  version: number;
  name: string;
  /** Per-synth-track level, 100 by default. */
  levels: number[];
  /** One sound object per synth track. */
  sounds: Dn1Sound[];
  /** Four MIDI track configuration records, verbatim. Contents largely unidentified. */
  midi: Uint8Array[];
  /** Eight named slots, "MACRO0".."MACRO7" by default. Purpose unidentified. */
  macroNames: string[];
}

export interface Dn1LockRecord {
  track: number;
  parameter: number;
  /** 64 values, 0xFFFF where the step is not locked. */
  values: number[];
}

// --- primitives -----------------------------------------------------------

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const latin1 = new TextDecoder("latin1");

function matchesAt(data: Uint8Array, magic: Uint8Array, at: number): boolean {
  if (at < 0 || at + magic.length > data.length) return false;
  for (let i = 0; i < magic.length; i++) if (data[at + i] !== magic[i]) return false;
  return true;
}

/** Read a fixed-width name field, stopping at the first NUL. */
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

const signed8 = (b: number) => (b > 127 ? b - 256 : b);

// --- record slicing -------------------------------------------------------

/** Slice pattern `index` out of a decompressed DN1 image. */
export function patternRecord(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN1_LAYOUT,
): Uint8Array {
  assertIndex(index, layout.patternCount, "pattern");
  const at = layout.headerSize + index * layout.patternSize;
  return image.subarray(at, at + layout.patternSize);
}

/** Slice kit `index` out of a decompressed DN1 image. */
export function kitRecord(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN1_LAYOUT,
): Uint8Array {
  assertIndex(index, layout.patternCount, "kit");
  const at = layout.kitBase + index * layout.kitSize;
  return image.subarray(at, at + layout.kitSize);
}

/** Slice track `index` out of a pattern record. */
export function trackRecord(pattern: Uint8Array, index: number): Uint8Array {
  assertIndex(index, TRACK_COUNT, "track");
  const at = PATTERN.trackOffset + index * PATTERN.trackSize;
  return pattern.subarray(at, at + PATTERN.trackSize);
}

/**
 * Whether a track index is a synth track or a MIDI track.
 *
 * There is no per-track mode flag on the DN1 — the distinction is positional and fixed:
 * a pattern always stores eight track records, and a kit always stores four sound
 * objects plus four MIDI configuration records.
 *
 * Verified two ways over all 6,784 patterns. Sound locks occur 4,047 times on tracks 0-3
 * and exactly zero times on tracks 4-7. And the parameter ids that appear in the lock
 * table for tracks 4-7 form a tiny set (19, 25, 29) against the 1..72 range used by
 * tracks 0-3, i.e. the two groups address different parameter spaces.
 */
export function trackKind(index: number): "synth" | "midi" {
  assertIndex(index, TRACK_COUNT, "track");
  return index < SYNTH_TRACK_COUNT ? "synth" : "midi";
}

/**
 * Read the flag word for one step.
 *
 * The flag block is 32 u32be entries; entry `n` holds step `2n` in its high u16 and step
 * `2n+1` in its low u16. Verified by cross-check against the note records: bit 0 of the
 * half agrees with "the note record for this step is not 0xFF" on 16,064 of 16,067
 * trigs in the corpus.
 */
export function stepFlags(track: Uint8Array, step: number): number {
  assertIndex(step, STEP_COUNT, "step");
  const entry = view(track).getUint32(TRACK.flagsOffset + (step >> 1) * 4, false);
  return step % 2 === 0 ? entry >>> 16 : entry & 0xffff;
}

// --- parameter locks ------------------------------------------------------

/**
 * Read the pattern's parameter-lock table.
 *
 * The table is a flat pool of 80 records shared by all eight tracks, allocated from slot
 * 0 upwards rather than partitioned per track. Each record is
 * `u8 parameter | u8 track | 64 x (u8 coarse, u8 fine)`, with 0xFFFF marking both an
 * unused record and an unlocked step.
 *
 * The value slots are read as `u16be` to match the DN2's, so that `lockvalue.ts` decodes
 * both devices the same way. The DN2 split is verified on hardware; the DN1's is inferred
 * from it, and conversion transfers the pair of bytes intact either way.
 *
 * Verified: across the corpus 1,416 records are in use, and for every one of them the
 * set of locked steps is a subset of the steps that carry a note trig or a lock trig on
 * the track named in the record header. Zero violations.
 */
export function readLockTable(pattern: Uint8Array): Dn1LockRecord[] {
  const dv = view(pattern);
  const out: Dn1LockRecord[] = [];
  for (let r = 0; r < PATTERN.lockCount; r++) {
    const at = PATTERN.lockOffset + r * PATTERN.lockSize;
    const header = dv.getUint16(at, true);
    if (header === NO_U16) continue;
    const values: number[] = [];
    for (let s = 0; s < STEP_COUNT; s++) values.push(dv.getUint16(at + 2 + s * 2, false));
    out.push({ parameter: header & 0xff, track: header >>> 8, values });
  }
  return out;
}

// --- patterns -------------------------------------------------------------

/** Decode one pattern record into trigs, locks and per-track settings. */
export function readPattern(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN1_LAYOUT,
): Dn1Pattern {
  const pattern = patternRecord(image, index, layout);
  const dv = view(pattern);
  const locks = readLockTable(pattern);

  const tracks: Dn1Track[] = [];
  for (let t = 0; t < TRACK_COUNT; t++) {
    const track = trackRecord(pattern, t);
    const settings = track.subarray(TRACK.settingsOffset, TRACK.settingsOffset + TRACK.settingsSize);
    const trackLocks = locks.filter((record) => record.track === t);
    const trigs: Dn1Trig[] = [];

    for (let step = 0; step < STEP_COUNT; step++) {
      const flags = stepFlags(track, step);
      const hasNote = (flags & STEP_FLAG.note) !== 0;
      const isLockTrig = (flags & STEP_FLAG.lock) !== 0;
      if (!hasNote && !isLockTrig) continue;

      const noteAt = TRACK.notesOffset + step * TRACK.noteRecordSize;
      const noteByte = track[noteAt]!;
      const chord: number[] = [];
      for (let i = 1; i < TRACK.noteRecordSize; i++) chord.push(signed8(track[noteAt + i]!));
      while (chord.length > 0 && chord[chord.length - 1] === 0) chord.pop();

      const velocity = track[TRACK.velocityOffset + step]!;
      const noteLength = track[TRACK.noteLengthOffset + step]!;
      const condition = track[TRACK.trigConditionOffset + step]!;
      const soundLock = track[TRACK.soundLockOffset + step]!;

      const stepLocks: Dn1ParameterLock[] = [];
      for (const record of trackLocks) {
        const value = record.values[step]!;
        if (value !== NO_U16) stepLocks.push({ parameter: record.parameter, value });
      }

      trigs.push({
        step,
        flags,
        hasNote,
        isLockTrig,
        ...(noteByte === NO_U8 ? {} : { note: noteByte }),
        chord,
        ...(velocity === NO_U8 ? {} : { velocity }),
        ...(noteLength === NO_U8 ? {} : { noteLength }),
        microTiming: signed8(track[TRACK.microTimingOffset + step]!),
        ...(condition === NO_U8 ? {} : { trigCondition: condition }),
        ...(soundLock === NO_U8 ? {} : { soundLock }),
        locks: stepLocks,
      });
    }

    tracks.push({
      index: t,
      kind: trackKind(t),
      length: settings[TRACK.settingsLengthOffset]!,
      speed: settings[TRACK.settingsSpeedOffset]!,
      settings,
      trigs,
    });
  }

  return {
    index,
    version: dv.getUint32(PATTERN.versionOffset, false),
    name: readName(pattern, PATTERN.nameOffset, PATTERN.nameSize),
    tempo: dv.getUint16(PATTERN.tempoOffset, false) / 120,
    slotIndex: pattern[PATTERN.slotIndexOffset]!,
    tracks,
  };
}

// --- sounds ---------------------------------------------------------------

/** Read one 302-byte sound object at an absolute offset in the image. */
export function readSound(image: Uint8Array, offset: number): Dn1Sound {
  const data = image.subarray(offset, offset + SOUND_SIZE);
  if (data.length < SOUND_SIZE) {
    throw new Dn1ParseError(`Sound object at 0x${offset.toString(16)} is truncated`);
  }
  const dv = view(data);
  const framed =
    matchesAt(data, OBJECT_MAGIC, 0) && matchesAt(data, OBJECT_TERMINATOR, SOUND_SIZE - 4);
  return {
    offset,
    version: dv.getUint32(4, false),
    tagBits: dv.getUint32(8, false),
    name: readName(data, 0x0c, 0x10),
    nameField: data.subarray(0x0c, 0x1c),
    framed,
    data,
  };
}

/**
 * Read the project sound pool: the 128 sounds that sound locks index into.
 *
 * The pool sits at the head of the tail region, behind a u32be version field.
 * Verified: in every corpus image all 128 slots carry a correctly framed sound object,
 * and every one of the 4,047 sound-lock bytes in the corpus is below 128.
 */
export function readSoundPool(image: Uint8Array, layout: ImageLayout = DN1_LAYOUT): Dn1Sound[] {
  const base = layout.tailBase + POOL.soundOffset;
  const out: Dn1Sound[] = [];
  for (let i = 0; i < POOL.soundCount; i++) out.push(readSound(image, base + i * SOUND_SIZE));
  return out;
}

/** Resolve a trig's sound lock to the pool entry it names. */
export function resolveSoundLock(
  image: Uint8Array,
  trig: Dn1Trig,
  layout: ImageLayout = DN1_LAYOUT,
): Dn1Sound | undefined {
  if (trig.soundLock === undefined) return undefined;
  const base = layout.tailBase + POOL.soundOffset;
  return readSound(image, base + trig.soundLock * SOUND_SIZE);
}

// --- kits -----------------------------------------------------------------

/** Decode one kit record: name, levels, the four synth sounds and the MIDI records. */
export function readKit(image: Uint8Array, index: number, layout: ImageLayout = DN1_LAYOUT): Dn1Kit {
  const kit = kitRecord(image, index, layout);
  const kitBase = layout.kitBase + index * layout.kitSize;
  const dv = view(kit);

  const levels: number[] = [];
  for (let i = 0; i < KIT.levelCount; i++) levels.push(dv.getUint16(KIT.levelOffset + i * 2, true));

  const sounds: Dn1Sound[] = [];
  for (let i = 0; i < KIT.soundCount; i++) {
    sounds.push(readSound(image, kitBase + KIT.soundOffset + i * SOUND_SIZE));
  }

  const midi: Uint8Array[] = [];
  for (let i = 0; i < KIT.midiCount; i++) {
    const at = KIT.midiOffset + i * KIT.midiSize;
    midi.push(kit.subarray(at, at + KIT.midiSize));
  }

  const macroNames: string[] = [];
  for (let i = 0; i < KIT.macroCount; i++) {
    macroNames.push(readName(kit, KIT.macroOffset + i * KIT.macroSize, 12));
  }

  return {
    index,
    version: dv.getUint32(KIT.versionOffset, false),
    name: readName(kit, KIT.nameOffset, KIT.nameSize),
    levels,
    sounds,
    midi,
    macroNames,
  };
}

// --- whole-image checks ---------------------------------------------------

export interface Dn1ImageCheck {
  ok: boolean;
  /** One line per failed expectation. Empty when `ok`. */
  problems: string[];
}

/**
 * Assert the documented geometry against an actual image.
 *
 * Every check here passes on all 53 corpus images. It is cheap, and worth running before
 * trusting any offset in this module against an image written by an unseen OS version.
 */
export function checkDn1Image(image: Uint8Array, layout: ImageLayout = DN1_LAYOUT): Dn1ImageCheck {
  const problems: string[] = [];

  if (image.length !== layout.imageSize) {
    problems.push(`image is ${image.length} bytes, expected ${layout.imageSize}`);
    return { ok: false, problems };
  }
  if (!matchesAt(image, OBJECT_MAGIC, 0)) problems.push("image does not start with BE EF BA CE");

  for (let i = 0; i < layout.patternCount; i++) {
    const version = view(patternRecord(image, i, layout)).getUint32(PATTERN.versionOffset, false);
    if (version !== RECORD_VERSION) problems.push(`pattern ${i} has version ${version}`);

    const kitVersion = view(kitRecord(image, i, layout)).getUint32(KIT.versionOffset, false);
    if (kitVersion !== RECORD_VERSION) problems.push(`kit ${i} has version ${kitVersion}`);

    const kitBase = layout.kitBase + i * layout.kitSize;
    for (let s = 0; s < KIT.soundCount; s++) {
      const at = kitBase + KIT.soundOffset + s * SOUND_SIZE;
      if (
        !matchesAt(image, OBJECT_MAGIC, at) ||
        !matchesAt(image, OBJECT_TERMINATOR, at + SOUND_SIZE - 4)
      ) {
        problems.push(`kit ${i} sound ${s} is not framed at 0x${at.toString(16)}`);
      }
    }
  }

  for (const sound of readSoundPool(image, layout)) {
    if (!sound.framed) problems.push(`pool sound at 0x${sound.offset.toString(16)} is not framed`);
  }

  return { ok: problems.length === 0, problems };
}

/** Project name from the image header. 16-byte field after the u32be version. */
export function readProjectName(image: Uint8Array): string {
  return readName(image, 8, 16);
}
