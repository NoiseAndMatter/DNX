/**
 * The Bloom prototype sample store ("BLSM"): its superblock, its index entries and its geometry.
 *
 * **Prototype, local only.** Proposed by the firmware session on 2026-10-25 for the first Bloom
 * machine, and modelled on the Waverider store (`waverider/superblock.ts`, `waverider/entries.ts`)
 * so both sides reuse code that already works on the unit. The owner's long-term store is ekFS's
 * own layout from `0x641000`, so this one is replaced later. The identity, the conversion and the
 * route shape are meant to stay.
 *
 * ```
 * region start   sector 0x641000, where the wavetable slots end
 * group A        region sector 0x0000, one 512 KiB erase group: superblock, then 256 index sectors
 * group B        region sector 0x0400
 * data           region sector 0x1000 to the device's end, in extents of 1,024 sectors (512 KiB)
 * ```
 *
 * Every field is big-endian. xxHash32 reads its input as little-endian words, as in the Waverider
 * store, and the mixture is correct.
 *
 * **A second copy of the Waverider superblock logic, on purpose.** That module fixes its magic and
 * its 256 entries as constants, and parameterising it is a refactor nobody asked for. This store is
 * a prototype that goes away, so it carries its own small copy.
 */

import { xxHash32 } from "../waverider/xxhash32.js";
import { be16, be32, putBe16, putBe32 } from "../waverider/bytes.js";
import { encodeEntryName } from "../waverider/entries.js";
import { SampleError } from "./errors.js";
import type { SampleId } from "./identity.js";

/** `"BLSM"`. */
export const MAGIC = Uint8Array.of(0x42, 0x4c, 0x53, 0x4d);
export const VERSION = 1;
export const SECTOR = 512;
export const SUPERBLOCK_BYTES = 64;

/** Absolute sector of the region. */
export const REGION_START_SECTOR = 0x641000;
/** Region-relative sectors of the two groups. */
export const GROUP_SECTORS = { a: 0x0000, b: 0x0400 } as const;
/** Region-relative sector where sample data begins. */
export const DATA_START_SECTOR = 0x1000;
/** The firmware's allocation unit and alignment: one 512 KiB erase group. */
export const EXTENT_UNIT_SECTORS = 1024;

export const INDEX_ENTRIES = 1024;
export const ENTRY_BYTES = 128;
export const INDEX_BYTES = INDEX_ENTRIES * ENTRY_BYTES;

/**
 * The largest payload, from the firmware's prototype limit: the stock write session stages the
 * whole file in ColdFire RAM before the commit. 87 s of mono, 43 s of stereo. The limit is the
 * payload alone: the body is at most 128 + 8 MiB, and the container is on top (confirmed
 * 2026-10-25).
 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const KIND_SAMPLE = 2;
export const FORMAT_INT16_BE = 1;
export const FLAG_USED = 1 << 0;
export const RATE = 48_000;
const GAIN_SCALE = 0x10000;

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
  selfHash: 60,
} as const;

export const ENTRY = {
  flags: 0,
  kind: 2,
  channels: 4,
  sampleFormat: 6,
  rate: 8,
  frames: 12,
  startSector: 16,
  payloadHash: 20,
  identity: 24,
  name: 32,
  nameBytes: 64,
  gain: 96,
  extentSectors: 100,
} as const;

export interface StoreSuperblock {
  generation: number;
  entryCount: number;
  /** Region-relative, inclusive. */
  dataStart: number;
  /** Region-relative, exclusive: the device's last sector + 1 - `REGION_START_SECTOR`. */
  dataEnd: number;
}

export interface StoreEntry {
  /** Position in the index, 0..1023. */
  n: number;
  channels: 1 | 2;
  frames: number;
  /** Region-relative. */
  startSector: number;
  extentSectors: number;
  /** xxHash32 of the payload as stored, big-endian. */
  payloadHash: number;
  /** DNX's identity hash, 16 hex digits. The firmware stores it and does not check it. */
  identityHash: string;
  name: string;
  /** The gain the import applied, as a linear factor. */
  gain: number;
}

/** Bytes of payload an entry describes. */
export const payloadBytes = (e: Pick<StoreEntry, "channels" | "frames">): number => e.frames * e.channels * 2;

/** The identity an entry records, as DNX names it. */
export const entryIdentity = (e: StoreEntry): SampleId => ({ hash: e.identityHash, size: payloadBytes(e) });

/** Decode entry `n` of an index, or `undefined` when it is free. */
export function readStoreEntry(index: Uint8Array, n: number): StoreEntry | undefined {
  const at = n * ENTRY_BYTES;
  if (index.length < at + ENTRY_BYTES) throw new SampleError(`the index has no entry ${n}`);
  const b = index.subarray(at, at + ENTRY_BYTES);
  if ((be16(b, ENTRY.flags) & FLAG_USED) === 0) return undefined;
  const kind = be16(b, ENTRY.kind);
  if (kind !== KIND_SAMPLE) throw new SampleError(`entry ${n} is kind ${kind}, not a sample`);
  const channels = be16(b, ENTRY.channels);
  if (channels !== 1 && channels !== 2) throw new SampleError(`entry ${n} has ${channels} channels`);
  const format = be16(b, ENTRY.sampleFormat);
  if (format !== FORMAT_INT16_BE) throw new SampleError(`entry ${n} has sample format ${format}`);
  const rate = be32(b, ENTRY.rate);
  if (rate !== RATE) throw new SampleError(`entry ${n} is at ${rate} Hz`);

  let identityHash = "";
  for (let i = 0; i < 8; i++) identityHash += b[ENTRY.identity + i]!.toString(16).padStart(2, "0");
  let name = "";
  for (let i = 0; i < ENTRY.nameBytes && b[ENTRY.name + i] !== 0; i++) name += String.fromCharCode(b[ENTRY.name + i]!);

  return {
    n,
    channels,
    frames: be32(b, ENTRY.frames),
    startSector: be32(b, ENTRY.startSector),
    extentSectors: be32(b, ENTRY.extentSectors),
    payloadHash: be32(b, ENTRY.payloadHash),
    identityHash,
    name,
    gain: be32(b, ENTRY.gain) / GAIN_SCALE,
  };
}

/** Every used entry of an index. */
export function readStoreIndex(index: Uint8Array): StoreEntry[] {
  if (index.length !== INDEX_BYTES) throw new SampleError(`the index is ${index.length} bytes, expected ${INDEX_BYTES}`);
  const out: StoreEntry[] = [];
  for (let n = 0; n < INDEX_ENTRIES; n++) {
    const e = readStoreEntry(index, n);
    if (e) out.push(e);
  }
  return out;
}

/** Encode one entry. Its fields are written as given: `storefile.ts` computes the payload hash. */
export function writeStoreEntry(e: StoreEntry): Uint8Array {
  if (!/^[0-9a-f]{16}$/.test(e.identityHash)) throw new SampleError(`identity "${e.identityHash}" is not 16 hex digits`);
  const out = new Uint8Array(ENTRY_BYTES);
  putBe16(out, ENTRY.flags, FLAG_USED);
  putBe16(out, ENTRY.kind, KIND_SAMPLE);
  putBe16(out, ENTRY.channels, e.channels);
  putBe16(out, ENTRY.sampleFormat, FORMAT_INT16_BE);
  putBe32(out, ENTRY.rate, RATE);
  putBe32(out, ENTRY.frames, e.frames);
  putBe32(out, ENTRY.startSector, e.startSector);
  putBe32(out, ENTRY.payloadHash, e.payloadHash);
  for (let i = 0; i < 8; i++) out[ENTRY.identity + i] = parseInt(e.identityHash.slice(i * 2, i * 2 + 2), 16);
  out.set(encodeEntryName(e.name), ENTRY.name);
  putBe32(out, ENTRY.gain, Math.round(e.gain * GAIN_SCALE));
  putBe32(out, ENTRY.extentSectors, e.extentSectors);
  return out;
}

/** Decode a group's superblock against its own index, or `undefined` when the group is not valid. */
export function readStoreSuperblock(sector: Uint8Array, index: Uint8Array): StoreSuperblock | undefined {
  if (sector.length < SUPERBLOCK_BYTES) return undefined;
  for (let i = 0; i < MAGIC.length; i++) if (sector[i] !== MAGIC[i]) return undefined;
  if (be16(sector, SUPER.version) !== VERSION) return undefined;
  if (be16(sector, SUPER.headerBytes) !== SUPERBLOCK_BYTES) return undefined;
  if (xxHash32(sector.subarray(0, SUPER.selfHash)) !== be32(sector, SUPER.selfHash)) return undefined;
  if (be32(sector, SUPER.indexEntries) !== INDEX_ENTRIES) return undefined;
  if (be32(sector, SUPER.entryBytes) !== ENTRY_BYTES) return undefined;
  if (index.length !== INDEX_BYTES || xxHash32(index) !== be32(sector, SUPER.indexHash)) return undefined;
  const entryCount = be32(sector, SUPER.entryCount);
  if (entryCount > INDEX_ENTRIES) return undefined;
  return {
    generation: be32(sector, SUPER.generation),
    entryCount,
    dataStart: be32(sector, SUPER.dataStart),
    dataEnd: be32(sector, SUPER.dataEnd),
  };
}

/** Build a superblock sector for an index already built. For the emulator fixtures and the tests. */
export function writeStoreSuperblock(meta: StoreSuperblock, index: Uint8Array): Uint8Array {
  if (index.length !== INDEX_BYTES) throw new SampleError(`the index is ${index.length} bytes, expected ${INDEX_BYTES}`);
  const sector = new Uint8Array(SECTOR);
  sector.set(MAGIC, SUPER.magic);
  putBe16(sector, SUPER.version, VERSION);
  putBe16(sector, SUPER.headerBytes, SUPERBLOCK_BYTES);
  putBe32(sector, SUPER.generation, meta.generation);
  putBe32(sector, SUPER.entryCount, meta.entryCount);
  putBe32(sector, SUPER.indexEntries, INDEX_ENTRIES);
  putBe32(sector, SUPER.entryBytes, ENTRY_BYTES);
  putBe32(sector, SUPER.indexHash, xxHash32(index));
  putBe32(sector, SUPER.dataStart, meta.dataStart);
  putBe32(sector, SUPER.dataEnd, meta.dataEnd);
  putBe32(sector, SUPER.selfHash, xxHash32(sector.subarray(0, SUPER.selfHash)));
  return sector;
}
