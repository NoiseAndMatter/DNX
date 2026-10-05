/**
 * The Waverider store's index: a 128-byte entry, and the fixed 256-entry block of them.
 *
 * Format v1, defined in `dn2_firmware/docs/waverider-store.md`. **One job: the index record.** The
 * header that describes it is `superblock.ts`, and **what makes a set of entries safe to write is
 * `validate.ts`, deliberately not here.**
 *
 * ## Why the encoder does not judge
 *
 * `writeIndex` used to call `validateIndex` itself, which read as belt and braces and was really
 * a codec depending on a policy. Splitting them put the import the other way round — the validator
 * needs to know what an entry *is*, and the encoder does not need to know what makes one safe.
 *
 * So the composition lives where the decision does: `planWrite` validates and then encodes, and it
 * is the only route to a write. A test asserts that it refuses an invalid set, because the guard
 * moving from a callee to a caller is exactly the kind of change that quietly loses one.
 *
 * ## One record, and the block of them
 *
 * `writeEntry` encodes a single 128-byte entry and `writeIndex` places 256 of them. They were one
 * function until `/waverider/<n>` turned out to carry its own entry ahead of its table, which is
 * the second caller that earns the split.
 *
 * ## The whole 256 are written every time
 *
 * Free entries included, as zeros, because the superblock hashes the index as one fixed block. A
 * free entry and an erased one are therefore indistinguishable, which is right: a store with no
 * tables is exactly a store that was never written.
 */

import { be16, be32, putBe16, putBe32 } from "./bytes.js";
import { WaveriderError } from "./errors.js";
import { ENTRY_BYTES, INDEX_BYTES, INDEX_ENTRIES } from "./layout.js";

/** 16.16 fixed point, as the gain field stores it. */
const GAIN_SCALE = 0x10000;

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
 * **Encodes what it is given.** Whether the set is safe to write is `validate.ts`'s question, and
 * `planWrite` asks it first — see this module's header for why the guard moved out rather than
 * staying here.
 *
 * The 256 entries are written whole every time, free ones as zeros, because the superblock hashes
 * the index as one fixed block.
 */
export function writeEntry(entry: TableEntry): Uint8Array {
  const out = new Uint8Array(ENTRY_BYTES);
  putBe16(out, ENTRY.flags, FLAG_USED | (entry.interpolate ? 0 : FLAG_NO_INTERPOLATION));
  putBe16(out, ENTRY.kind, KIND_WAVETABLE);
  putBe16(out, ENTRY.waves, entry.waves);
  putBe16(out, ENTRY.points, entry.points);
  putBe16(out, ENTRY.sampleFormat, entry.sampleFormat);
  putBe32(out, ENTRY.startSector, entry.startSector);
  putBe32(out, ENTRY.byteLength, entry.byteLength);
  putBe32(out, ENTRY.tableHash, entry.tableHash);
  putBe32(out, ENTRY.sourceHash, entry.sourceHash);
  putBe32(out, ENTRY.sourceSize, entry.sourceSize);
  out.set(latin1Encode(entry.name, ENTRY.nameBytes), ENTRY.name);
  putBe32(out, ENTRY.gain, Math.round(entry.gain * GAIN_SCALE));
  return out;
}

export function writeIndex(entries: readonly TableEntry[]): Uint8Array {
  const index = new Uint8Array(INDEX_BYTES);
  for (const entry of entries) index.set(writeEntry(entry), entry.slot * ENTRY_BYTES);
  return index;
}
