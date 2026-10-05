/**
 * The Waverider store's superblock and index, read and written.
 *
 * Format v1, defined in `dn2_firmware/docs/waverider-store.md`. See `layout.ts` for where things
 * sit; this file is only what the bytes mean.
 *
 * ## Everything here refuses rather than repairs
 *
 * A store that does not decode is not a store DNX should rewrite — the whole point of two groups
 * is that a damaged one can be ignored while the other is trusted, and a decoder that quietly
 * fixed up a bad field would take that choice away from the caller. So `readSuperblock` returns
 * `undefined` for an invalid group and `validateIndex` throws with the entry that broke the rule.
 *
 * ## Big-endian fields, little-endian hash
 *
 * Every multi-byte field below is big-endian, as everything on an Elektron device is. xxHash32
 * reads its input as little-endian 32-bit words, because that is what xxHash32 does. **The mixture
 * is correct**, it is in the shared document, and it is the sort of thing that reads as a bug in a
 * later review.
 */

import { xxHash32 } from "./xxhash32.js";
import {
  DATA_END,
  DATA_START,
  ENTRY_BYTES,
  INDEX_BYTES,
  INDEX_ENTRIES,
  SECTOR,
  EXTENT_ALIGN,
  sectorsFor,
} from "./layout.js";

export class WaveriderError extends Error {}

/** `"WRTB"`, the first four bytes of the region. Nothing is written until this has been read. */
export const MAGIC = Uint8Array.of(0x57, 0x52, 0x54, 0x42);

/** The only format version this reads or writes. */
export const VERSION = 1;

/** Bytes of superblock that mean anything; the rest of the sector is zero. */
export const SUPERBLOCK_BYTES = 64;

/** Field offsets in the superblock. */
export const SUPER = {
  magic: 0,
  version: 4,
  headerBytes: 6,
  generation: 8,
  entryCount: 12,
  indexEntries: 16,
  entryBytes: 20,
  indexHash: 24,
  dataStart: 28,
  dataEnd: 32,
  /** Covers bytes 0..59, so it covers `indexHash` — a torn superblock cannot point at a stale index. */
  selfHash: 60,
} as const;

/** Field offsets in a 128-byte index entry. */
export const ENTRY = {
  flags: 0,
  kind: 2,
  waves: 4,
  points: 6,
  sampleFormat: 8,
  startSector: 12,
  byteLength: 16,
  tableHash: 20,
  sourceHash: 24,
  sourceSize: 28,
  name: 32,
  nameBytes: 64,
  /** 16.16 fixed point: what the conversion multiplied the source by. */
  gain: 96,
} as const;

/** `flags` bit 0: this entry is in use. A free entry is all zeros, so this is the only bit that matters first. */
export const FLAG_USED = 1 << 0;
/** `flags` bit 1: the player must not interpolate between waves. */
export const FLAG_NO_INTERPOLATION = 1 << 1;

/** `kind` 1. The only kind v1 defines. */
export const KIND_WAVETABLE = 1;

/** `sampleFormat` 1: int16 big-endian. **Still a hypothesis** until a loaded table sounds right. */
export const FORMAT_INT16_BE = 1;

export interface Superblock {
  generation: number;
  entryCount: number;
  indexHash: number;
  dataStart: number;
  dataEnd: number;
}

export interface TableEntry {
  /** Index into the fixed 256-entry table, which is also the `/waverider/<n>` slot. */
  slot: number;
  name: string;
  waves: number;
  points: number;
  sampleFormat: number;
  interpolate: boolean;
  /** Region-relative. */
  startSector: number;
  byteLength: number;
  tableHash: number;
  sourceHash: number;
  sourceSize: number;
  /** What the conversion multiplied the source by, as a real number. */
  gain: number;
}

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number): number =>
  (((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0);

function putBe16(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 8) & 0xff;
  b[at + 1] = v & 0xff;
}

function putBe32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

/** 16.16 fixed point, as the gain field stores it. */
const GAIN_SCALE = 0x10000;

// --- the superblock ----------------------------------------------------------------------------

/**
 * Decode a group's superblock, or `undefined` when it is not one.
 *
 * `indexBytes` is that group's index copy, needed because the superblock's validity depends on the
 * index hashing to what it claims. A group whose index does not match its superblock **is not
 * valid**, however well-formed the header looks — that pairing is the only thing that makes the
 * write ordering safe.
 *
 * Returns `undefined` rather than throwing, for every failure. An invalid group is the expected
 * state half the time: it is the one being written to, and it is what a virgin region looks like.
 */
export function readSuperblock(sector: Uint8Array, indexBytes: Uint8Array): Superblock | undefined {
  if (sector.length < SUPERBLOCK_BYTES) return undefined;
  for (let i = 0; i < MAGIC.length; i++) if (sector[i] !== MAGIC[i]) return undefined;
  if (be16(sector, SUPER.version) !== VERSION) return undefined;
  if (be16(sector, SUPER.headerBytes) !== SUPERBLOCK_BYTES) return undefined;

  // Its own hash first: a header that does not check cannot be trusted to describe the index.
  if (xxHash32(sector.subarray(0, SUPER.selfHash)) !== be32(sector, SUPER.selfHash)) return undefined;

  if (be32(sector, SUPER.indexEntries) !== INDEX_ENTRIES) return undefined;
  if (be32(sector, SUPER.entryBytes) !== ENTRY_BYTES) return undefined;
  if (indexBytes.length !== INDEX_BYTES) return undefined;
  if (xxHash32(indexBytes) !== be32(sector, SUPER.indexHash)) return undefined;

  const entryCount = be32(sector, SUPER.entryCount);
  if (entryCount > INDEX_ENTRIES) return undefined;

  return {
    generation: be32(sector, SUPER.generation),
    entryCount,
    indexHash: be32(sector, SUPER.indexHash),
    dataStart: be32(sector, SUPER.dataStart),
    dataEnd: be32(sector, SUPER.dataEnd),
  };
}

/** Build a superblock sector for an index that has already been built. */
export function writeSuperblock(meta: Omit<Superblock, "indexHash">, indexBytes: Uint8Array): Uint8Array {
  if (indexBytes.length !== INDEX_BYTES) {
    throw new WaveriderError(`index is ${indexBytes.length} bytes, expected ${INDEX_BYTES}`);
  }
  const sector = new Uint8Array(SECTOR);
  sector.set(MAGIC, SUPER.magic);
  putBe16(sector, SUPER.version, VERSION);
  putBe16(sector, SUPER.headerBytes, SUPERBLOCK_BYTES);
  putBe32(sector, SUPER.generation, meta.generation);
  putBe32(sector, SUPER.entryCount, meta.entryCount);
  putBe32(sector, SUPER.indexEntries, INDEX_ENTRIES);
  putBe32(sector, SUPER.entryBytes, ENTRY_BYTES);
  putBe32(sector, SUPER.indexHash, xxHash32(indexBytes));
  putBe32(sector, SUPER.dataStart, meta.dataStart);
  putBe32(sector, SUPER.dataEnd, meta.dataEnd);
  // Last, because it covers everything before it.
  putBe32(sector, SUPER.selfHash, xxHash32(sector.subarray(0, SUPER.selfHash)));
  return sector;
}

/**
 * Which of the two decoded groups is current.
 *
 * The valid one with the higher generation. **Group A wins a tie**, which cannot happen and is
 * pinned anyway: "cannot happen" is where non-determinism lives, and both sides implement the same
 * rule. Neither valid means the store is empty, which is also what a virgin region reads as.
 */
export function currentGroup<T>(
  a: { superblock: Superblock | undefined; value: T },
  b: { superblock: Superblock | undefined; value: T },
): { superblock: Superblock; value: T } | undefined {
  if (!a.superblock) return b.superblock ? (b as { superblock: Superblock; value: T }) : undefined;
  if (!b.superblock) return a as { superblock: Superblock; value: T };
  return (b.superblock.generation > a.superblock.generation ? b : a) as {
    superblock: Superblock;
    value: T;
  };
}

// --- the index ----------------------------------------------------------------------------------

const latin1 = new TextDecoder("windows-1252");

/** Decode one entry, or `undefined` when the slot is free. */
export function readEntry(indexBytes: Uint8Array, slot: number): TableEntry | undefined {
  if (!Number.isInteger(slot) || slot < 0 || slot >= INDEX_ENTRIES) {
    throw new WaveriderError(`slot ${slot} is outside 0..${INDEX_ENTRIES - 1}`);
  }
  const at = slot * ENTRY_BYTES;
  const flags = be16(indexBytes, at + ENTRY.flags);
  if ((flags & FLAG_USED) === 0) return undefined;

  const nameBytes = indexBytes.subarray(at + ENTRY.name, at + ENTRY.name + ENTRY.nameBytes);
  const nul = nameBytes.indexOf(0);
  return {
    slot,
    name: latin1.decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul)),
    waves: be16(indexBytes, at + ENTRY.waves),
    points: be16(indexBytes, at + ENTRY.points),
    sampleFormat: be16(indexBytes, at + ENTRY.sampleFormat),
    // Bit 1 is **no** interpolation, so the readable field is its inverse. Storing the negative
    // and reading the positive is where a double negative turns into a silent wrong playback.
    interpolate: (flags & FLAG_NO_INTERPOLATION) === 0,
    startSector: be32(indexBytes, at + ENTRY.startSector),
    byteLength: be32(indexBytes, at + ENTRY.byteLength),
    tableHash: be32(indexBytes, at + ENTRY.tableHash),
    sourceHash: be32(indexBytes, at + ENTRY.sourceHash),
    sourceSize: be32(indexBytes, at + ENTRY.sourceSize),
    gain: be32(indexBytes, at + ENTRY.gain) / GAIN_SCALE,
  };
}

/** Every entry in use, in slot order. */
export function readIndex(indexBytes: Uint8Array): TableEntry[] {
  if (indexBytes.length !== INDEX_BYTES) {
    throw new WaveriderError(`index is ${indexBytes.length} bytes, expected ${INDEX_BYTES}`);
  }
  const out: TableEntry[] = [];
  for (let slot = 0; slot < INDEX_ENTRIES; slot++) {
    const entry = readEntry(indexBytes, slot);
    if (entry) out.push(entry);
  }
  return out;
}

const latin1Encode = (text: string, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let i = 0; i < Math.min(text.length, size); i++) {
    const code = text.charCodeAt(i);
    // The device shows Windows-1252 and nothing else; a multi-byte character would become two
    // wrong ones. `?` is visible, which is the point — a name that quietly lost a character is
    // worse than one that shows it did.
    out[i] = code <= 0xff ? code : 0x3f;
  }
  return out;
};

/**
 * Build the whole fixed index from the entries in use.
 *
 * Validated first, so a refused set leaves nothing half-built. The 256 entries are written whole
 * every time, free ones as zeros, because the superblock hashes the index as a fixed block.
 */
export function writeIndex(entries: readonly TableEntry[]): Uint8Array {
  validateIndex(entries);
  const index = new Uint8Array(INDEX_BYTES);
  for (const entry of entries) {
    const at = entry.slot * ENTRY_BYTES;
    putBe16(index, at + ENTRY.flags, FLAG_USED | (entry.interpolate ? 0 : FLAG_NO_INTERPOLATION));
    putBe16(index, at + ENTRY.kind, KIND_WAVETABLE);
    putBe16(index, at + ENTRY.waves, entry.waves);
    putBe16(index, at + ENTRY.points, entry.points);
    putBe16(index, at + ENTRY.sampleFormat, entry.sampleFormat);
    putBe32(index, at + ENTRY.startSector, entry.startSector);
    putBe32(index, at + ENTRY.byteLength, entry.byteLength);
    putBe32(index, at + ENTRY.tableHash, entry.tableHash);
    putBe32(index, at + ENTRY.sourceHash, entry.sourceHash);
    putBe32(index, at + ENTRY.sourceSize, entry.sourceSize);
    index.set(latin1Encode(entry.name, ENTRY.nameBytes), at + ENTRY.name);
    putBe32(index, at + ENTRY.gain, Math.round(entry.gain * GAIN_SCALE));
  }
  return index;
}

/**
 * Refuse an index that would describe something the firmware must not be asked to read.
 *
 * **DNX writes the index, so nothing on the firmware's side can stop a bad one being handed over.**
 * Their bounded reader checks each extent on its own anyway — a bad index is exactly what a bounded
 * reader exists to survive — but that is the last line, not the first, and a store that fails
 * there has already been written.
 *
 * Every rule here names the entry that broke it, because "invalid index" with 256 slots is not a
 * diagnosis.
 */
export function validateIndex(entries: readonly TableEntry[]): void {
  const seen = new Set<number>();
  for (const entry of entries) {
    const where = `slot ${entry.slot}${entry.name ? ` (${entry.name})` : ""}`;

    if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= INDEX_ENTRIES) {
      throw new WaveriderError(`${where}: slot is outside 0..${INDEX_ENTRIES - 1}`);
    }
    if (seen.has(entry.slot)) throw new WaveriderError(`${where}: two entries claim this slot`);
    seen.add(entry.slot);

    if (entry.byteLength <= 0) throw new WaveriderError(`${where}: byte length is ${entry.byteLength}`);
    if (entry.waves <= 0 || entry.points <= 0) {
      throw new WaveriderError(`${where}: geometry is ${entry.waves} x ${entry.points}`);
    }
    // The geometry is what the player uses to cut the payload up, so a payload that does not
    // measure what the geometry says is a table that will be read as something else entirely.
    if (entry.sampleFormat === FORMAT_INT16_BE) {
      const expected = entry.waves * entry.points * 2;
      if (entry.byteLength !== expected) {
        throw new WaveriderError(
          `${where}: ${entry.waves} waves x ${entry.points} points of int16 is ${expected} bytes, ` +
            `and the entry says ${entry.byteLength}`,
        );
      }
    }

    if (entry.startSector % EXTENT_ALIGN !== 0) {
      throw new WaveriderError(
        `${where}: starts at sector ${entry.startSector}, which is not on the ${EXTENT_ALIGN}-sector boundary`,
      );
    }
    if (entry.startSector < DATA_START) {
      throw new WaveriderError(
        `${where}: starts at sector ${entry.startSector}, inside the superblocks and indexes below ${DATA_START}`,
      );
    }
    const end = entry.startSector + sectorsFor(entry.byteLength);
    if (end > DATA_END) {
      throw new WaveriderError(`${where}: ends at sector ${end}, past the region's ${DATA_END}`);
    }
  }

  // Overlap, checked across the set rather than per entry, because it is the only rule that is
  // about a pair. Sorted by start so the report names the two that actually collide.
  const byStart = [...entries].sort((x, y) => x.startSector - y.startSector);
  for (let i = 1; i < byStart.length; i++) {
    const before = byStart[i - 1]!;
    const after = byStart[i]!;
    const beforeEnd = before.startSector + sectorsFor(before.byteLength);
    if (after.startSector < beforeEnd) {
      throw new WaveriderError(
        `slot ${before.slot} occupies sectors ${before.startSector}..${beforeEnd - 1} and slot ` +
          `${after.slot} starts at ${after.startSector}: the two extents overlap`,
      );
    }
  }
}
