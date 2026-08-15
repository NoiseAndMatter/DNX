/**
 * The Digitone II's song table — 16 arrangements, at the very end of the image.
 *
 * ## How this was established
 *
 * By differential capture on hardware, 2026-08-15. The factory `PRESETS` project has **zero
 * non-zero bytes** anywhere in this region, so a project copied from it and given a song produced an
 * unambiguous first reading; four further saves each moved a handful of bytes and settled the rest.
 *
 * Every field below was **stated by a person before it was read**, and each one matched — patterns
 * `A1, A2, A3, A4` then A4 repeating, repetitions 1/2/2/3, tempos 90/130/135/60, lengths
 * 128/63/256/2, track 16 muted on row 1 and track 1 from row 6, and every label in the device's list
 * in order. Two mute statements on different bits and different rows is what makes the alignment
 * provable rather than plausible: one agreeing field could be coincidence.
 *
 * ## The geometry closes exactly
 *
 * **16 x 3,072 = 49,152 bytes, from `tailBase + 0xec04` to the last byte of the image.** Nothing was
 * rounded and nothing is left over; `dn2song.test.ts` asserts the arithmetic rather than trusting
 * it. Inside a record, `0x10 + 99 x 29 = 0xb47` abuts the trailer with no slack either.
 *
 * ## What is deliberately not decoded
 *
 * A row's `+3`, `+4`, `+11..26` and `+28` were zero in every row of every capture. They are **not**
 * claimed to be padding — nothing observed has set them, which is a statement about the captures
 * rather than about the format. `rawRow` hands the bytes back so a caller can look.
 *
 * `+27` was in that list until a capture varied swing, which is the pattern to expect: these bytes
 * fall one at a time as somebody thinks to change the right control.
 *
 * That distinction cost something once already: a first pass walked the label list, never landed on
 * value 16, and recorded it as reserved. It is **FADE** — the walk had missed it. *An absence in a
 * hand-made capture is evidence about the capture, not about the format.*
 *
 * ## Why this matters beyond a song editor
 *
 * `librarian/device.ts` has a song guard because **a song row names a pattern by slot**, which is
 * exactly the reference a rearrangement invalidates. It has returned `unknown` for the Digitone II
 * since it was written, because the table had never been located — so the guard could not tell a
 * project with songs from one without, and had to assume the worst on the machine DNX cares most
 * about. This ends that.
 */

import { type ImageLayout, DN2_LAYOUT } from "./dn2image.js";

export class Dn2SongError extends Error {}

/** Where the table sits, and how big it is. */
export const SONG_TABLE = {
  /** Offset from `layout.tailBase`. */
  offset: 0xec04,
  /** Bytes per song record. */
  recordSize: 0xc00,
  /** Songs per project, as the manual states and the arithmetic confirms. */
  count: 16,
} as const;

/** Field offsets inside one 3,072-byte song record. */
export const SONG = {
  nameOffset: 0x000,
  nameSize: 16,
  rowOffset: 0x010,
  rowSize: 29,
  /** The manual's number, and `0x10 + 99 x 29` lands exactly on the trailer. */
  rowCount: 99,
  /** How many rows the song actually uses. */
  rowCountOffset: 0xb48,
  /** What happens after the last row — `END_LOOP` or `END_STOP`. */
  endModeOffset: 0xb49,
  /** The song's own tempo, `u16be`, BPM x `TEMPO_SCALE`. 120 BPM in every record seen. */
  tempoOffset: 0xb4c,
} as const;

/** Field offsets inside one 29-byte row. */
export const ROW = {
  /** Pattern slot, zero-based: 0 is A1. */
  pattern: 0,
  /** **Repetitions minus one.** 0 means the row plays once. */
  repeatsLessOne: 1,
  /** An index into `LABELS`. */
  label: 2,
  /** `u16be`, BPM x `TEMPO_SCALE`. */
  tempo: 5,
  /** `u16be`. Bit *n* mutes track *n+1*, so bit 0 is track 1 and bit 15 is track 16. */
  mute: 7,
  /** `u16be`, in sequencer steps. */
  length: 9,
  /**
   * Swing, stored as **percent minus 50**, so 0 is 50% and 30 is 80%.
   *
   * Measured 2026-08-15: a row set to 57% read `7`, a row set to the maximum 80% read `30`. The
   * manual gives the range as 50-80, which closes exactly onto a single byte of 0..30.
   *
   * Per row, always — the manual is explicit that swing is never a song-wide setting, unlike tempo.
   */
  swing: 27,
} as const;

/**
 * Tempo is stored multiplied by 120, on both Digitone families.
 *
 * The DN1 does the same at `+0x838` of its 2,560-byte record (`dn1tail.ts`). Different geometry,
 * same idea — which is a small piece of evidence that both were read correctly.
 *
 * **Measured rather than fitted.** Every tempo in the first captures was a round number, and a round
 * number cannot tell x120 from x100 or x10. A row set to 135.1 read 16,212 — exactly 135.1 x 120 —
 * and the device's 0.1 BPM step moves the raw value by 12.
 *
 * > **Anything that writes a tempo must round, not truncate.** `135.2 * 120` is `16223.999...` in
 * > binary, and truncating stores a tempo 1/120 BPM low. Found by a test fixture doing exactly that.
 */
export const TEMPO_SCALE = 120;

/** Swing is stored as an offset from this. */
export const SWING_BASE = 50;

/** What the END row does. */
export const END_LOOP = 0xff;
export const END_STOP = 0xfe;

/**
 * The song currently selected on the instrument, zero-based. Offset from `layout.tailBase`.
 *
 * Outside the song table, 3,586 bytes before it. Identified by watching it read 0, then 1, then 2 as
 * songs were created, and return to 0 when song 1 was edited again.
 */
export const SELECTED_SONG_OFFSET = 0xde12;

/**
 * Row labels by index, exactly as the device orders them.
 *
 * All 21 measured — each one set on a row and read back. `(EMPTY)` and `(PTN NAME)` are the device's
 * own parenthesised entries and are not free text; a row labelled `(PTN NAME)` displays the
 * pattern's name.
 */
export const LABELS = [
  "(EMPTY)", "(PTN NAME)", "INTRO", "OUTRO", "BRIDGE", "CHORUS", "VERSE", "SOLO", "FILL", "RISE",
  "PEAK", "DROP", "BREAK", "JAM", "NOISE", "FX", "FADE", "MISC", "TEST", "PAUSE", "OTHER",
] as const;

export type LabelName = (typeof LABELS)[number];

export interface SongRow {
  /** Pattern slot, zero-based. */
  pattern: number;
  /** How many times the row plays. **One-based**, unlike the byte on disk. */
  repeats: number;
  label: number;
  /** `undefined` for a label index this build does not know. */
  labelName?: LabelName;
  /** BPM, already divided by `TEMPO_SCALE`. */
  tempo: number;
  /** Bit *n* mutes track *n+1*. */
  mute: number;
  /** Steps played from the pattern. */
  length: number;
  /** Swing as a percentage, 50..80. Already offset from `SWING_BASE`. */
  swing: number;
}

export interface Song {
  index: number;
  name: string;
  /** Rows in use. Rows past this are present in the array but unused. */
  rowCount: number;
  /** `END_LOOP`, `END_STOP`, or whatever else the device wrote. */
  endMode: number;
  /** True when the song loops rather than stopping. */
  loops: boolean;
  /** The song's own tempo in BPM. */
  tempo: number;
  /** Only the rows in use. */
  rows: SongRow[];
}

function requireDn2(layout: ImageLayout): void {
  if (layout !== DN2_LAYOUT) {
    throw new Dn2SongError(
      "the song table is only established for the Digitone II. The Digitone 1 keeps its songs " +
        "elsewhere and in a different shape — see `dn1tail.ts`.",
    );
  }
}

/** Absolute offset of the song table in a decoded image. */
export function songTableBase(layout: ImageLayout = DN2_LAYOUT): number {
  requireDn2(layout);
  return layout.tailBase + SONG_TABLE.offset;
}

/** Slice song record `index` out of an image. */
export function songRecord(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= SONG_TABLE.count) {
    throw new Dn2SongError(`song index ${index} out of range 0..${SONG_TABLE.count - 1}`);
  }
  const at = songTableBase(layout) + index * SONG_TABLE.recordSize;
  return image.subarray(at, at + SONG_TABLE.recordSize);
}

/** One row's 29 bytes, undecoded, for looking at the fields nothing has yet explained. */
export function rawRow(record: Uint8Array, row: number): Uint8Array {
  if (!Number.isInteger(row) || row < 0 || row >= SONG.rowCount) {
    throw new Dn2SongError(`row ${row} out of range 0..${SONG.rowCount - 1}`);
  }
  const at = SONG.rowOffset + row * SONG.rowSize;
  return record.subarray(at, at + SONG.rowSize);
}

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;

/** Decode one row. */
export function readRow(record: Uint8Array, row: number): SongRow {
  const r = rawRow(record, row);
  const label = r[ROW.label]!;
  return {
    pattern: r[ROW.pattern]!,
    // Stored zero-based: the byte is one less than the number of plays.
    repeats: r[ROW.repeatsLessOne]! + 1,
    label,
    ...(LABELS[label] === undefined ? {} : { labelName: LABELS[label] }),
    tempo: u16(r, ROW.tempo) / TEMPO_SCALE,
    mute: u16(r, ROW.mute),
    length: u16(r, ROW.length),
    swing: SWING_BASE + r[ROW.swing]!,
  };
}

/** Which tracks a row mutes, as one-based track numbers. */
export function mutedTracks(row: SongRow): number[] {
  const out: number[] = [];
  for (let bit = 0; bit < 16; bit++) if (row.mute & (1 << bit)) out.push(bit + 1);
  return out;
}

const latin1 = new TextDecoder("latin1");

/** Read song `index`, with only the rows it actually uses. */
export function readSong(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN2_LAYOUT,
): Song {
  const record = songRecord(image, index, layout);
  const nameBytes = record.subarray(SONG.nameOffset, SONG.nameOffset + SONG.nameSize);
  const nul = nameBytes.indexOf(0);
  const endMode = record[SONG.endModeOffset]!;

  // Clamped, because a count past the array would read into the trailer and beyond. A file claiming
  // more rows than can exist is corrupt, and the honest response is to read what is there.
  const declared = record[SONG.rowCountOffset]!;
  const rowCount = Math.min(declared, SONG.rowCount);

  const rows: SongRow[] = [];
  for (let r = 0; r < rowCount; r++) rows.push(readRow(record, r));

  return {
    index,
    name: latin1.decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul)),
    rowCount,
    endMode,
    loops: endMode === END_LOOP,
    tempo: u16(record, SONG.tempoOffset) / TEMPO_SCALE,
    rows,
  };
}

/** Every song in a project. Unused slots come back with `rowCount` 0. */
export function readSongs(image: Uint8Array, layout: ImageLayout = DN2_LAYOUT): Song[] {
  return Array.from({ length: SONG_TABLE.count }, (_, i) => readSong(image, i, layout));
}

/** The song selected on the instrument, zero-based. */
export function selectedSong(image: Uint8Array, layout: ImageLayout = DN2_LAYOUT): number {
  requireDn2(layout);
  return image[layout.tailBase + SELECTED_SONG_OFFSET]!;
}

/**
 * Whether any song in the project holds a row.
 *
 * **The rearrange guard.** A song row names a pattern by slot, so moving patterns around can desync
 * an arrangement that nobody can see. Decided from the declared row count rather than by scanning
 * bytes: an unused slot reads 0 there in every capture, and a slot with rows says how many.
 */
export function isSongTableEmpty(image: Uint8Array, layout: ImageLayout = DN2_LAYOUT): boolean {
  requireDn2(layout);
  for (let i = 0; i < SONG_TABLE.count; i++) {
    if (songRecord(image, i, layout)[SONG.rowCountOffset]! > 0) return false;
  }
  return true;
}

// --- writing ---------------------------------------------------------------------------------
//
// **Nothing here reaches an instrument.** A song lives in the image tail, which the dump protocol
// cannot carry, so an edited project can only be exported as a file or written whole to the +Drive.
// That is a deliberate gap: `deviceproject.ts` calls songs "the one thing this project has always
// refused to risk", and every write below is one an export makes visible before anything is sent.

/**
 * What a field may hold, from the manual and from what has been measured.
 *
 * Refused rather than clamped. A caller asking for a 2,000-step row has a bug, and silently storing
 * 1,024 would hide it in a project that then plays something nobody asked for.
 */
export const LIMITS = {
  /** Pattern slots on a Digitone II. */
  pattern: { min: 0, max: 127 },
  /**
   * Plays before the song advances.
   *
   * The manual gives no range. The byte holds `repeats - 1`, so 256 is the ceiling the format
   * imposes; **only 1-3 have ever been seen on hardware**, and the rest is inference from the field
   * width rather than measurement.
   */
  repeats: { min: 1, max: 256 },
  /** Steps played from the pattern. Manual: 2-1024, the last 25 shown as K00-K24. */
  length: { min: 2, max: 1024 },
  /** BPM. The manual's range for the instrument; 60-135.1 measured. */
  tempo: { min: 30, max: 300 },
  /** Manual: 50-80, and the byte is the offset from 50, so 0-30. */
  swing: { min: SWING_BASE, max: SWING_BASE + 30 },
  /** Index into `LABELS`. */
  label: { min: 0, max: LABELS.length - 1 },
} as const;

function must(value: number, range: { min: number; max: number }, what: string): void {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new Dn2SongError(`${what} ${value} is outside ${range.min}..${range.max}`);
  }
}

const putU16 = (bytes: Uint8Array, at: number, value: number): void => {
  bytes[at] = (value >> 8) & 0xff;
  bytes[at + 1] = value & 0xff;
};

/**
 * Write one row into a record, in place.
 *
 * Every field is validated first, so a refused row leaves the record untouched rather than half
 * written — the failure mode of writing as you go is a song that is neither what it was nor what
 * was asked for.
 */
export function writeRow(record: Uint8Array, row: number, values: SongRow): void {
  must(values.pattern, LIMITS.pattern, "pattern");
  must(values.repeats, LIMITS.repeats, "repeats");
  must(values.label, LIMITS.label, "label");
  must(values.tempo, LIMITS.tempo, "tempo");
  must(values.length, LIMITS.length, "length");
  must(values.swing, LIMITS.swing, "swing");
  if (!Number.isInteger(values.mute) || values.mute < 0 || values.mute > 0xffff) {
    throw new Dn2SongError(`mute mask ${values.mute} does not fit in 16 bits`);
  }

  const r = rawRow(record, row);
  r[ROW.pattern] = values.pattern;
  // Zero-based on disk: one play is stored as 0.
  r[ROW.repeatsLessOne] = values.repeats - 1;
  r[ROW.label] = values.label;
  // **Rounded, never truncated.** `135.2 * 120` is `16223.999...` in binary, and truncating stores
  // a tempo 1/120 BPM low — caught by a test fixture doing exactly that.
  putU16(r, ROW.tempo, Math.round(values.tempo * TEMPO_SCALE));
  putU16(r, ROW.mute, values.mute);
  putU16(r, ROW.length, values.length);
  r[ROW.swing] = values.swing - SWING_BASE;
}

/** Clear a row to all zeros — the shape an unused row has in every capture. */
export function clearRow(record: Uint8Array, row: number): void {
  rawRow(record, row).fill(0);
}

export interface SongMeta {
  name: string;
  rowCount: number;
  /** `END_LOOP` or `END_STOP`. */
  endMode: number;
  /** The song's own tempo in BPM. */
  tempo: number;
}

const latin1Encode = (text: string, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let i = 0; i < Math.min(text.length, size); i++) {
    const code = text.charCodeAt(i);
    // Latin-1 only: the device has no way to show anything else, and a multi-byte character would
    // silently become two wrong ones.
    out[i] = code <= 0xff ? code : 0x3f;
  }
  return out;
};

/** Write a song's name, row count, end mode and tempo. */
export function writeSongMeta(record: Uint8Array, meta: SongMeta): void {
  if (meta.rowCount < 0 || meta.rowCount > SONG.rowCount) {
    throw new Dn2SongError(`row count ${meta.rowCount} is outside 0..${SONG.rowCount}`);
  }
  must(meta.tempo, LIMITS.tempo, "song tempo");
  record.set(latin1Encode(meta.name, SONG.nameSize), SONG.nameOffset);
  record[SONG.rowCountOffset] = meta.rowCount;
  record[SONG.endModeOffset] = meta.endMode;
  putU16(record, SONG.tempoOffset, Math.round(meta.tempo * TEMPO_SCALE));
}

/**
 * Write a whole song into a copy of an image.
 *
 * Returns a new image rather than mutating: the manager's session diffs before against after to
 * make an undo step, so an operation that edited in place would have nothing to diff.
 *
 * Rows past `rowCount` are cleared rather than left as they were. A song shortened from twelve rows
 * to three would otherwise keep nine rows of stale arrangement just past the end — invisible in the
 * device's editor and very visible in a byte diff.
 */
export function writeSong(
  image: Uint8Array,
  index: number,
  song: Omit<Song, "index" | "loops">,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  if (song.rows.length !== song.rowCount) {
    throw new Dn2SongError(
      `song says ${song.rowCount} rows and carries ${song.rows.length}. Those must agree, or the ` +
        `device plays a different arrangement from the one on screen.`,
    );
  }

  const out = Uint8Array.from(image);
  const record = songRecord(out, index, layout);
  writeSongMeta(record, {
    name: song.name,
    rowCount: song.rowCount,
    endMode: song.endMode,
    tempo: song.tempo,
  });
  for (let r = 0; r < SONG.rowCount; r++) {
    if (r < song.rowCount) writeRow(record, r, song.rows[r]!);
    else clearRow(record, r);
  }
  return out;
}
