/**
 * The Waverider store's 64-byte superblock, and which of the two groups is current.
 *
 * Format v1, defined in `dn2_firmware/docs/waverider-store.md`. **One job: the header record.**
 * The index it describes lives in `entries.ts`, what makes an index safe to write lives in
 * `validate.ts`, and where any of it sits on the card lives in `layout.ts`.
 *
 * ## A superblock is only valid against its own index
 *
 * `readSuperblock` takes the group's index copy as well as its header, and a header that does not
 * hash its index is **not valid** however well-formed it looks. That pairing is the whole reason
 * the two-group scheme works: a header that validated against any index would let a half-finished
 * write pass for a finished one, which is the failure the scheme exists to prevent.
 *
 * ## Invalid reads as `undefined`, not as a throw
 *
 * An invalid group is the expected state half the time — it is the one being written to, and it is
 * also what a virgin region looks like. A decoder that threw would make the normal case an
 * exception, and a decoder that repaired would take the choice away from the caller.
 *
 * ## Big-endian fields, little-endian hash
 *
 * Every field here is big-endian, as everything on an Elektron device is. xxHash32 reads its input
 * as little-endian 32-bit words, because that is what xxHash32 does. **The mixture is correct**, it
 * is in the shared document, and it is the sort of thing that reads as a bug in a later review.
 */

import { xxHash32 } from "./xxhash32.js";
import { be16, be32, putBe16, putBe32 } from "./bytes.js";
import { WaveriderError } from "./errors.js";
import { ENTRY_BYTES, INDEX_BYTES, INDEX_ENTRIES, SECTOR } from "./layout.js";

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

export interface Superblock {
  generation: number;
  entryCount: number;
  indexHash: number;
  dataStart: number;
  dataEnd: number;
}

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
