/**
 * Digitone 1 project tail: the region after the 128-slot sound pool.
 *
 * `src/project/dn1.ts` decodes the image up to and including the sound pool. This module
 * covers what follows it — 55,552 bytes holding the project settings object, an
 * unidentified 1,024-slot array, a table of MIDI CC records, a small mixer block, and
 * the 17-song song table.
 *
 * Base arithmetic, verified on all 53 corpus images:
 *
 *   0x290200  tail base
 *   +4 + 128 x 302 = 0x9704            the sound pool (see dn1.readSoundPool)
 *   0x299904  55,552 bytes             this module's region
 *
 *     0x299904   252    zero fill
 *     0x299A00    69    project settings object      <- the per-track MIDI channels
 *     0x299A45  11,264  1,024 x 11-byte slots        <- purpose UNKNOWN, see the doc
 *     0x29C645     5    zero fill
 *     0x29C64A   312    8 x 39-byte MIDI CC records
 *     0x29C782    34    zero fill
 *     0x29C7A4    92    mixer-ish block
 *     0x29C800  43,520  17 x 2,560-byte song records
 *     0x2A7200     4    BA CE F0 0C object terminator
 *
 *   252 + 69 + 11,264 + 5 + 312 + 34 + 92 + 43,520 + 4 = 55,552, exactly.
 *
 * WHY THIS MODULE EXISTS: a planned "rearrange" mode moves a sound between tracks, and
 * anything in the project that references a track by index has to move with it. The tail
 * contains exactly two such things, and this module exposes one of them plus guards for
 * the other. See docs/dn1-tail-format.md for the evidence behind every claim below.
 *
 * WHAT IS DELIBERATELY ABSENT: accessors for the interior of a song row, for the
 * 11-byte slot records, and for the mixer block. Those layouts are not established, and
 * these bytes get written to real hardware. `readSongs` hands back raw rows; the two
 * `is*Empty` guards let a caller refuse to touch data it cannot safely rewrite.
 */

import { DN1_LAYOUT, type ImageLayout } from "./dn2image.js";

// --- geometry -------------------------------------------------------------

/** Sound-pool size within the tail: a u32be version plus 128 x 302-byte sound objects. */
const POOL_BYTES = 4 + 128 * 302;

/** Object terminator, the last four bytes of the image. Same magic dn1.ts uses. */
const TERMINATOR = Uint8Array.of(0xba, 0xce, 0xf0, 0x0c);

/**
 * Byte offsets within the post-pool region, and the sizes that make it partition exactly.
 *
 * Every boundary is confirmed on all 53 corpus images by `checkDn1Tail`. The two that
 * pin everything else down are the slot array (1,024 x 11 = 11,264 lands exactly on the
 * CC-record padding) and the song array (17 x 2,560 lands exactly on the terminator).
 */
export const TAIL = {
  /** Bytes of the tail consumed by the sound pool, i.e. where this region starts. */
  poolBytes: POOL_BYTES,
  /** Total size of the post-pool region, terminator included. */
  size: 55_552,

  headPadOffset: 0x0000,
  headPadSize: 0xfc,

  settingsOffset: 0x00fc,
  settingsSize: 0x45,

  slotsOffset: 0x0141,
  slotSize: 11,
  slotCount: 1024,

  ccOffset: 0x2d46,
  ccSize: 39,
  ccCount: 8,

  mixerOffset: 0x2ea0,
  mixerSize: 92,

  songOffset: 0x2efc,
  songSize: 2560,
  songCount: 17,

  terminatorOffset: 0xd8fc,
} as const;

/** Field offsets inside the 69-byte project settings object, relative to its start. */
export const SETTINGS = {
  versionOffset: 0x00,
  /** u16be, BPM x 120 — the same encoding the pattern record uses for its own tempo. */
  tempoOffset: 0x04,
  /** u8 pattern index, 0..127. The pattern the project was saved on. */
  lastPatternOffset: 0x0b,
  /** u8, MIDI-channel-shaped. Dropped by the DN1 -> DN2 conversion. */
  channelAOffset: 0x19,
  /** u8, MIDI-channel-shaped. Preserved verbatim by the DN1 -> DN2 conversion. */
  channelBOffset: 0x1a,
  /** 8 x u8, one per track: MIDI channel 0..15, or 0xFF for off. */
  trackChannelOffset: 0x1b,
  /** Three more MIDI-channel-shaped bytes after the per-track array. */
  extraChannelOffset: 0x23,
  extraChannelCount: 3,
} as const;

/** Field offsets inside one 2,560-byte song record, relative to its start. */
export const SONG = {
  versionOffset: 0x000,
  rowOffset: 0x016,
  rowSize: 21,
  rowCount: 99,
  /** u8 immediately after the row array. 0 in 900 of the 901 corpus records. */
  flagOffset: 0x835,
  /** u16be, BPM x 120. 14,400 (= 120.0 BPM) in every corpus record. */
  tempoOffset: 0x838,
} as const;

/** Version carried by the settings object in every DN1 image. The DN2 equivalent is 1. */
export const SETTINGS_VERSION = 7;

/** Version carried by every DN1 song record. The DN2 equivalent is 0. */
export const SONG_VERSION = 1;

/** Tracks on a DN1: four synth tracks T1-T4 then four MIDI tracks A-D. */
export const TRACK_COUNT = 8;

/** Value meaning "no MIDI channel assigned" in the per-track channel array. */
export const CHANNEL_OFF = 0xff;

/** A slot record that has never been used: 0xFF then ten zero bytes. */
const EMPTY_SLOT = Uint8Array.of(0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/**
 * The 39-byte MIDI CC record, byte-identical in all eight records of all 53 images.
 *
 * Reads as a 16-entry table of CC numbers 70..85 (0x46..0x55) with a two-byte header and
 * a five-byte trailer. Its meaning is SPECULATIVE and its record count is ambiguous
 * (eight 39-byte records from 0x29C64A, or nine from 0x29C645 — both close exactly).
 * Since every record is identical the ambiguity has no practical consequence: permuting
 * them is a no-op and copying the region verbatim is always correct.
 */
const CC_RECORD = Uint8Array.of(
  0xff, 0x04,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
  0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0x02, 0x02, 0x00, 0x02, 0x00,
);

export class Dn1TailParseError extends Error {}

// --- types ----------------------------------------------------------------

export interface Dn1ProjectSettings {
  /** Absolute image offset of the settings object, for callers that want to patch it. */
  offset: number;
  /** u32be record version. 7 in every corpus image. */
  version: number;
  /** Project tempo in BPM. Stored as `bpm * 120` in a u16be. Corpus range 41.5 .. 173.1. */
  tempo: number;
  /**
   * Pattern index the project was saved on, 0..127.
   *
   * VERIFIED-strong: this value names a pattern the project actually uses in 53 of 53
   * corpus projects, and in 35 of the 35 where it is non-zero, against a 7.5% baseline.
   */
  lastPatternIndex: number;
  /**
   * MIDI channel per track, index 0..7 = T1 T2 T3 T4 A B C D.
   *
   * Values are 0..15, or `CHANNEL_OFF` (0xFF). Default is the identity `0..7`.
   *
   * THIS IS THE TAIL'S ONE CONFIRMED PER-TRACK REFERENCE. A rearrange that moves a
   * sound between tracks must permute this array to match. Evidence: 52 of 53 projects
   * hold the identity permutation; `026 DOOTHABEETHEE` holds `FF FF FF FF 04 05 06 07`,
   * turning off exactly the four synth tracks; and the DN1 -> DN2 conversion widens the
   * array from 8 entries to 16 in all 9 matched pairs, which only a per-track array does.
   */
  trackMidiChannels: number[];
  /**
   * The five MIDI-channel-shaped bytes bracketing the per-track array: two before it and
   * three after. INFERRED to be the FX-control, auto and program-change channels; the
   * individual assignment is UNKNOWN, so they are exposed positionally.
   */
  otherChannels: { before: number[]; after: number[] };
  /** The whole 69-byte object verbatim, so unidentified fields survive a round trip. */
  raw: Uint8Array;
}

export interface Dn1Song {
  /** 0..16. INFERRED to be the DN1's 16 songs plus one spare; the extra slot is UNKNOWN. */
  index: number;
  /** Absolute image offset of the song record. */
  offset: number;
  /** u32be record version. 1 in every corpus record. */
  version: number;
  /** Song tempo in BPM. `bpm * 120` in a u16be. 120.0 in every corpus record. */
  tempo: number;
  /** u8 after the row array. 0 in 900 of the 901 corpus records; 0xFF in the other 17+1. */
  flag: number;
  /**
   * The 99 song rows, 21 bytes each, verbatim.
   *
   * Deliberately NOT decoded. A row carries 8 per-track bytes — the DN2's row is
   * 29 bytes for 16 tracks, exactly 8 more bytes for exactly 8 more tracks, and both
   * sizes are forced by exact closure arithmetic on the record. But every row in all 53
   * corpus projects is empty, so there is nothing to correlate against and the position
   * of those 8 bytes inside the row is UNKNOWN. Guessing here would silently desync an
   * arrangement on real hardware.
   */
  rows: Uint8Array[];
}

// --- primitives -----------------------------------------------------------

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

function equalAt(image: Uint8Array, expected: Uint8Array, at: number): boolean {
  if (at < 0 || at + expected.length > image.length) return false;
  for (let i = 0; i < expected.length; i++) if (image[at + i] !== expected[i]) return false;
  return true;
}

function allZero(image: Uint8Array, at: number, size: number): boolean {
  for (let i = at; i < at + size; i++) if (image[i] !== 0) return false;
  return true;
}

function assertIndex(index: number, count: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`${what} index ${index} out of range 0..${count - 1}`);
  }
}

/**
 * Absolute image offset of the post-pool region.
 *
 * Not a stored field — it is `tailBase + 4 + 128 * 302`, and the arithmetic is confirmed
 * by the last pool sound's `BA CE F0 0C` terminator landing on the four bytes before it
 * in all 53 corpus images.
 */
export function tailRegionBase(layout: ImageLayout = DN1_LAYOUT): number {
  return layout.tailBase + POOL_BYTES;
}

function requireDn1(image: Uint8Array, layout: ImageLayout): number {
  if (image.length !== layout.imageSize) {
    throw new Dn1TailParseError(
      `Image is ${image.length} bytes, expected ${layout.imageSize} for this layout`,
    );
  }
  return tailRegionBase(layout);
}

// --- project settings -----------------------------------------------------

/** Read the 69-byte project settings object at the head of the post-pool region. */
export function readProjectSettings(
  image: Uint8Array,
  layout: ImageLayout = DN1_LAYOUT,
): Dn1ProjectSettings {
  const at = requireDn1(image, layout) + TAIL.settingsOffset;
  const raw = image.subarray(at, at + TAIL.settingsSize);
  const dv = view(raw);

  const trackMidiChannels: number[] = [];
  for (let t = 0; t < TRACK_COUNT; t++) {
    trackMidiChannels.push(raw[SETTINGS.trackChannelOffset + t]!);
  }
  const after: number[] = [];
  for (let i = 0; i < SETTINGS.extraChannelCount; i++) {
    after.push(raw[SETTINGS.extraChannelOffset + i]!);
  }

  return {
    offset: at,
    version: dv.getUint32(SETTINGS.versionOffset, false),
    tempo: dv.getUint16(SETTINGS.tempoOffset, false) / 120,
    lastPatternIndex: raw[SETTINGS.lastPatternOffset]!,
    trackMidiChannels,
    otherChannels: {
      before: [raw[SETTINGS.channelAOffset]!, raw[SETTINGS.channelBOffset]!],
      after,
    },
    raw,
  };
}

/**
 * Absolute image offset of the per-track MIDI channel array.
 *
 * Exposed separately because a rearrange wants to permute these eight bytes in place
 * rather than rebuild the settings object around them.
 */
export function trackMidiChannelOffset(layout: ImageLayout = DN1_LAYOUT): number {
  return tailRegionBase(layout) + TAIL.settingsOffset + SETTINGS.trackChannelOffset;
}

// --- songs ----------------------------------------------------------------

/** Slice song record `index` out of the image. */
export function songRecord(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN1_LAYOUT,
): Uint8Array {
  assertIndex(index, TAIL.songCount, "song");
  const at = requireDn1(image, layout) + TAIL.songOffset + index * TAIL.songSize;
  return image.subarray(at, at + TAIL.songSize);
}

/** Read one song record: version, tempo, flag and its 99 raw rows. */
export function readSong(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN1_LAYOUT,
): Dn1Song {
  const record = songRecord(image, index, layout);
  const dv = view(record);
  const rows: Uint8Array[] = [];
  for (let r = 0; r < SONG.rowCount; r++) {
    const at = SONG.rowOffset + r * SONG.rowSize;
    rows.push(record.subarray(at, at + SONG.rowSize));
  }
  return {
    index,
    offset: requireDn1(image, layout) + TAIL.songOffset + index * TAIL.songSize,
    version: dv.getUint32(SONG.versionOffset, false),
    tempo: dv.getUint16(SONG.tempoOffset, false) / 120,
    flag: record[SONG.flagOffset]!,
    rows,
  };
}

/** Read all 17 song records. */
export function readSongs(image: Uint8Array, layout: ImageLayout = DN1_LAYOUT): Dn1Song[] {
  const out: Dn1Song[] = [];
  for (let i = 0; i < TAIL.songCount; i++) out.push(readSong(image, i, layout));
  return out;
}

/**
 * Whether every song row in the project is empty.
 *
 * THE REARRANGE GUARD. A song row carries 8 per-track bytes whose position inside the
 * 21-byte row is not established, so a track permutation cannot be applied to a
 * populated song table without risking a silent desync: patterns would play correctly
 * while the arrangement's mutes pointed at the wrong tracks.
 *
 * "Empty" is defined from the corpus: across all 53 projects, 89,199 rows, no byte
 * outside offset 0 is ever non-zero, and byte 0 is only ever 0 or 1. `001 PRESETS` has
 * byte 0 set to 1 in 98 of the 99 rows of all 17 records — an initialised but unused
 * table — so a set byte 0 alone is not treated as content.
 *
 * Returns true in all 53 corpus projects, including all 9 that have DN2 conversions.
 */
export function isSongTableEmpty(image: Uint8Array, layout: ImageLayout = DN1_LAYOUT): boolean {
  const base = requireDn1(image, layout) + TAIL.songOffset;
  for (let s = 0; s < TAIL.songCount; s++) {
    const rowBase = base + s * TAIL.songSize + SONG.rowOffset;
    for (let r = 0; r < SONG.rowCount; r++) {
      const at = rowBase + r * SONG.rowSize;
      if (image[at]! > 1) return false;
      if (!allZero(image, at + 1, SONG.rowSize - 1)) return false;
    }
  }
  return true;
}

// --- the unidentified slot array ------------------------------------------

/** Slice slot record `index` out of the 1,024-entry array. Contents are UNKNOWN. */
export function slotRecord(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN1_LAYOUT,
): Uint8Array {
  assertIndex(index, TAIL.slotCount, "slot");
  const at = requireDn1(image, layout) + TAIL.slotsOffset + index * TAIL.slotSize;
  return image.subarray(at, at + TAIL.slotSize);
}

/**
 * Whether every one of the 1,024 slot records is unused.
 *
 * THE SECOND REARRANGE GUARD. What this array holds is UNKNOWN, but `1,024 = 8 x 128`
 * and the only occupied records in the whole corpus sit at indices 0, 1, 2, 3, 4, 128,
 * 256 and 384 — multiples of 128. If the outer dimension of 8 is the track index, the
 * array is per-track and a rearrange has to permute 1,408-byte groups. The corpus cannot
 * settle it: only three projects have any data, and two of those have a single record at
 * index 0, which is index 0 under either factorisation.
 *
 * Returns true in 50 of the 53 corpus projects and in all 9 that have DN2 conversions.
 * When it returns false, refuse the rearrange rather than guess a permutation.
 */
export function isSlotArrayEmpty(image: Uint8Array, layout: ImageLayout = DN1_LAYOUT): boolean {
  const base = requireDn1(image, layout) + TAIL.slotsOffset;
  for (let i = 0; i < TAIL.slotCount; i++) {
    if (!equalAt(image, EMPTY_SLOT, base + i * TAIL.slotSize)) return false;
  }
  return true;
}

// --- whole-region check ---------------------------------------------------

export interface Dn1TailCheck {
  ok: boolean;
  /** One line per failed expectation. Empty when `ok`. */
  problems: string[];
}

/**
 * Re-run every VERIFIED claim in docs/dn1-tail-format.md against an actual image.
 *
 * Reports zero problems on all 53 corpus images. Worth running before trusting any
 * offset here against an image written by an unseen OS version — this region is where a
 * firmware update would most plausibly add fields, and every boundary below is derived
 * from exact closure rather than from a stored length.
 */
export function checkDn1Tail(image: Uint8Array, layout: ImageLayout = DN1_LAYOUT): Dn1TailCheck {
  const problems: string[] = [];

  if (image.length !== layout.imageSize) {
    problems.push(`image is ${image.length} bytes, expected ${layout.imageSize}`);
    return { ok: false, problems };
  }

  const base = tailRegionBase(layout);
  if (layout.tailSize - POOL_BYTES !== TAIL.size) {
    problems.push(`post-pool region is ${layout.tailSize - POOL_BYTES} bytes, expected ${TAIL.size}`);
    return { ok: false, problems };
  }

  const hex = (o: number) => `0x${(base + o).toString(16)}`;

  if (!allZero(image, base + TAIL.headPadOffset, TAIL.headPadSize)) {
    problems.push(`head padding at ${hex(TAIL.headPadOffset)} is not all zero`);
  }

  const settings = view(image).getUint32(base + TAIL.settingsOffset, false);
  if (settings !== SETTINGS_VERSION) {
    problems.push(`settings object version is ${settings}, expected ${SETTINGS_VERSION}`);
  }

  if (!allZero(image, base + 0x2d41, 5)) problems.push(`padding at ${hex(0x2d41)} is not zero`);
  for (let i = 0; i < TAIL.ccCount; i++) {
    const at = base + TAIL.ccOffset + i * TAIL.ccSize;
    if (!equalAt(image, CC_RECORD, at)) problems.push(`CC record ${i} at ${hex(TAIL.ccOffset + i * TAIL.ccSize)} differs from the corpus constant`);
  }
  if (!allZero(image, base + 0x2e7e, 34)) problems.push(`padding at ${hex(0x2e7e)} is not zero`);

  if (image[base + TAIL.mixerOffset] !== 0x11 || image[base + TAIL.mixerOffset + 1] !== 0x30) {
    problems.push(`mixer block at ${hex(TAIL.mixerOffset)} does not start with 11 30`);
  }

  for (let s = 0; s < TAIL.songCount; s++) {
    const at = base + TAIL.songOffset + s * TAIL.songSize;
    const dv = view(image);
    if (dv.getUint32(at + SONG.versionOffset, false) !== SONG_VERSION) {
      problems.push(`song ${s} version is ${dv.getUint32(at + SONG.versionOffset, false)}`);
    }
    if (!allZero(image, at + 4, SONG.rowOffset - 4)) {
      problems.push(`song ${s} header padding is not zero`);
    }
    if (dv.getUint16(at + SONG.tempoOffset, false) !== 14_400) {
      problems.push(`song ${s} tempo is ${dv.getUint16(at + SONG.tempoOffset, false)}, expected 14400`);
    }
    if (!allZero(image, at + SONG.tempoOffset + 2, TAIL.songSize - SONG.tempoOffset - 2)) {
      problems.push(`song ${s} trailer is not zero`);
    }
  }

  if (!equalAt(image, TERMINATOR, base + TAIL.terminatorOffset)) {
    problems.push(`region does not end with BA CE F0 0C at ${hex(TAIL.terminatorOffset)}`);
  }
  if (base + TAIL.terminatorOffset + 4 !== image.length) {
    problems.push(`terminator is not at the end of the image`);
  }

  return { ok: problems.length === 0, problems };
}
