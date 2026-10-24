/**
 * The bytes of `/samples/<n>` and `/samples/index` in the Bloom prototype store (`blsm.ts`).
 *
 * ```
 * /samples/<n>      container: kind 0x53 'S', store version 1, index n, raw
 *                   body = 128-byte entry + payload (int16 big-endian, interleaved)
 * /samples/index    container: kind 0x53, version 1, index 0xFFFF, raw, read-only
 *                   body = the current group's 64-byte superblock + its 128 KiB index
 * ```
 *
 * **The firmware allocates.** DNX sends start 0 and extent 0, and the commit writes the chosen
 * start and extent into the stored entry. A non-zero value from DNX is refused. So a read-back
 * differs from what was sent at those 8 bytes and at the container CRC, and `STAMPED_BY_FIRMWARE`
 * in `device/samplestore.ts` excuses exactly those.
 *
 * **The payload hash is computed here, never passed in**, for the reason `waverider/slotfile.ts`
 * gives: a commit cannot refuse, so a stale hash would report success and store nothing.
 */

import { xxHash32 } from "../waverider/xxhash32.js";
import {
  CONTAINER_MAGIC,
  HEADER_BYTES,
  TRAILER_BYTES,
  buildContainer,
  containerIsCompressed,
  containerObjectVersion,
  contentKind,
} from "../project/container.js";
import {
  ENTRY,
  ENTRY_BYTES,
  INDEX_BYTES,
  INDEX_ENTRIES,
  MAX_PAYLOAD_BYTES,
  type StoreEntry,
  type StoreSuperblock,
  SUPERBLOCK_BYTES,
  payloadBytes,
  readStoreEntry,
  readStoreIndex,
  readStoreSuperblock,
  writeStoreEntry,
} from "./blsm.js";
import { SampleError } from "./errors.js";
import type { StoredSample } from "./format.js";
import type { SampleId } from "./identity.js";

/** `0x0D` for a sample file: `'S'`. */
export const CONTENT_KIND_SAMPLE = 0x53;
export const STORE_FORMAT_VERSION = 1;
/** The container's index field on `/samples/index`. */
export const INDEX_FILE_INDEX = 0xffff;
const FORMAT_VERSION = "0059";

/** Offsets in the whole file, entry fields included, that the firmware fills at the commit. */
export const ALLOCATED_FIELD_OFFSETS: readonly number[] = [
  ...[0, 1, 2, 3].map((i) => HEADER_BYTES + ENTRY.startSector + i),
  ...[0, 1, 2, 3].map((i) => HEADER_BYTES + ENTRY.extentSectors + i),
];

/** The stored payload: interleaved points as int16 big-endian. */
export function payloadOf(sample: StoredSample): Uint8Array {
  const out = new Uint8Array(sample.pcm.length * 2);
  for (let i = 0; i < sample.pcm.length; i++) {
    const v = sample.pcm[i]!;
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

export interface PendingSample {
  n: number;
  id: SampleId;
  sample: StoredSample;
  name: string;
}

/** Build the file for entry `n`. Refuses what the firmware refuses, before the wire. */
export function buildSampleFile(p: PendingSample): Uint8Array {
  const { n, id, sample } = p;
  if (!Number.isInteger(n) || n < 0 || n >= INDEX_ENTRIES) throw new SampleError(`entry ${n} is outside 0..${INDEX_ENTRIES - 1}`);
  const payload = payloadOf(sample);
  if (payload.length === 0) throw new SampleError(`"${p.name}" has no frames`);
  if (payload.length !== id.size) {
    throw new SampleError(`"${p.name}" is ${payload.length} bytes and its identity says ${id.size}`);
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new SampleError(
      `"${p.name}" is ${payload.length.toLocaleString()} bytes. The prototype store takes at most ` +
        `${MAX_PAYLOAD_BYTES.toLocaleString()}.`,
    );
  }

  const entry: StoreEntry = {
    n,
    channels: sample.channels,
    frames: sample.frames,
    // The firmware allocates. See this module's note.
    startSector: 0,
    extentSectors: 0,
    payloadHash: xxHash32(payload),
    identityHash: id.hash,
    name: p.name,
    // The import already applied its gain to the points, and Bloom does not read this field.
    gain: 1,
  };

  const body = new Uint8Array(ENTRY_BYTES + payload.length);
  body.set(writeStoreEntry(entry), 0);
  body.set(payload, ENTRY_BYTES);
  return buildContainer({
    body,
    contentKind: CONTENT_KIND_SAMPLE,
    objectVersion: STORE_FORMAT_VERSION,
    index: n,
    formatVersion: FORMAT_VERSION,
  });
}

function containerBody(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length < HEADER_BYTES + TRAILER_BYTES) throw new SampleError(`${what} is ${bytes.length} bytes`);
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (bytes[i] !== CONTAINER_MAGIC[i]) throw new SampleError(`${what} is not an Elektron container`);
  }
  const kind = contentKind(bytes);
  if (kind !== CONTENT_KIND_SAMPLE) throw new SampleError(`${what} has content kind 0x${(kind ?? 0).toString(16)}, not 0x53`);
  const version = containerObjectVersion(bytes);
  if (version !== STORE_FORMAT_VERSION) throw new SampleError(`${what} has store format version ${version}`);
  if (containerIsCompressed(bytes) !== false) throw new SampleError(`${what} must be raw`);
  return bytes.subarray(HEADER_BYTES, bytes.length - TRAILER_BYTES);
}

/** Read `/samples/<n>` back, checking the entry against its own payload. */
export function readSampleFile(bytes: Uint8Array): { entry: StoreEntry; payload: Uint8Array } {
  const body = containerBody(bytes, "the sample file");
  if (body.length < ENTRY_BYTES) throw new SampleError(`the sample file's body is ${body.length} bytes`);
  const entry = readStoreEntry(body.subarray(0, ENTRY_BYTES), 0);
  if (!entry) throw new SampleError("the sample file's entry is not in use");
  const payload = body.subarray(ENTRY_BYTES);
  if (payload.length !== payloadBytes(entry)) {
    throw new SampleError(`the entry says ${payloadBytes(entry)} bytes and the file carries ${payload.length}`);
  }
  if (xxHash32(payload) !== entry.payloadHash) throw new SampleError("the entry's payload hash does not match its payload");
  return { entry, payload };
}

export interface StoreIndex {
  /** `undefined` when the store has no valid group yet: a virgin region. */
  superblock: StoreSuperblock | undefined;
  entries: StoreEntry[];
}

/** Read `/samples/index`. An all-zero body is an empty store; any other invalid one is refused. */
export function readIndexFile(bytes: Uint8Array): StoreIndex {
  const body = containerBody(bytes, "the index file");
  if (body.length !== SUPERBLOCK_BYTES + INDEX_BYTES) {
    throw new SampleError(`the index file's body is ${body.length} bytes, expected ${SUPERBLOCK_BYTES + INDEX_BYTES}`);
  }
  const sector = body.subarray(0, SUPERBLOCK_BYTES);
  const index = body.subarray(SUPERBLOCK_BYTES);
  if (body.every((b) => b === 0)) return { superblock: undefined, entries: [] };
  const superblock = readStoreSuperblock(sector, index);
  if (!superblock) throw new SampleError("the index file's superblock is not valid against its index");
  const entries = readStoreIndex(index);
  if (entries.length !== superblock.entryCount) {
    throw new SampleError(`the superblock counts ${superblock.entryCount} entries and the index holds ${entries.length}`);
  }
  return { superblock, entries };
}
