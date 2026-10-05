/**
 * Where the Waverider store keeps things, as numbers rather than prose.
 *
 * The shared definition is `dn2_firmware/docs/waverider-store.md`, agreed with the firmware session
 * on 2026-10-05. This file is DNX's half of it. **When the two disagree, the document is the
 * format and this is the bug** — the firmware reads the store at run time, so its reader is the
 * definition and DNX follows it.
 *
 * ## The region
 *
 * Sector `0x600000`, which is 3,072 MiB in. Chosen because the firmware hard-codes every stock
 * slot and has no partition table, and nothing in normal-mode code reads or writes above 2,224 MiB.
 * It is inside the pSLC region, which ends at `0x618000`; data may run past that onto slower TLC.
 * It is deliberately **not** the Digitakt II's `0x5D8000`, which is where Elektron would put a
 * sample store on this family if they shipped one.
 *
 * ## Two groups, because one superblock can be torn
 *
 * Group A and group B sit in their own 512 KiB erase groups, each holding a superblock and a copy
 * of the index. A change writes **data, then the non-current group's index, then its superblock
 * with generation + 1**. A failed or cancelled write costs that attempt and nothing else, because
 * the other group still describes the store as it was.
 *
 * That ordering is the whole point of the scheme, and it is enforced by `plan.ts` rather than by
 * this file, which only says where things go.
 */

/** Bytes per +Drive sector. */
export const SECTOR = 512;

/** First sector of the region, counting from the start of the eMMC. */
export const REGION_START = 0x600000;

/**
 * Where the pSLC region ends, as an **absolute** sector.
 *
 * Not a limit: data may be written past it. Crossing it means the writes land on TLC and are
 * slower, which is a thing to report rather than refuse — `planWrite` says when a plan crosses it.
 */
export const FAST_END = 0x618000;

/**
 * The same boundary, **relative to the region**, which is the frame everything else here uses.
 *
 * Both exist because mixing the two is an easy and silent mistake: `FAST_END` and a region-relative
 * sector are both plain numbers in the right order of magnitude, and comparing them compiles. One
 * of these names is always the wrong one to reach for, which is the point of them being different
 * names.
 */
export const FAST_SECTORS = FAST_END - REGION_START;

/** A superblock-and-index pair, and where it lives relative to `REGION_START`. */
export interface Group {
  readonly name: "A" | "B";
  /** Sector of the superblock, relative to the region. */
  readonly superblock: number;
  /** First sector of this group's index copy, relative to the region. */
  readonly index: number;
}

/**
 * The two groups, each at the start of its own erase group.
 *
 * `0x400` sectors is 512 KiB, which is this eMMC's `HC_ERASE_GRP_SIZE`. Putting A and B in
 * separate erase groups is what stops a torn write to one disturbing the other; the 4 KiB
 * alignment of the *data* extents is a different and much weaker requirement, met because the
 * controller handles 512-byte writes and the metadata is where the risk is.
 */
export const GROUP_A: Group = { name: "A", superblock: 0, index: 1 };
export const GROUP_B: Group = { name: "B", superblock: 0x400, index: 0x401 };
export const GROUPS: readonly Group[] = [GROUP_A, GROUP_B];

/** Entries the index always holds, used or not. The index is a fixed size. */
export const INDEX_ENTRIES = 256;

/** Bytes per index entry. */
export const ENTRY_BYTES = 128;

/** The index is this many bytes, and it is hashed whole — free entries included. */
export const INDEX_BYTES = INDEX_ENTRIES * ENTRY_BYTES;

/** And therefore this many sectors: 32,768 / 512 = 64, sectors 1..64 of a group. */
export const INDEX_SECTORS = INDEX_BYTES / SECTOR;

/** First sector data may occupy, relative to the region. Clear of both groups. */
export const DATA_START = 0x1000;

/**
 * Last sector data may occupy, relative to the region, exclusive.
 *
 * The region has no hard end in the document — it runs until the eMMC does — so this is DNX's
 * self-imposed ceiling rather than the device's, and it is written into every superblock as
 * `dataEnd`. 64 MiB past the start of data is more than three thousand v1 tables and comfortably
 * past the pSLC boundary, so the limit a plan actually meets is the index's 256 entries.
 */
export const DATA_END = DATA_START + 0x20000;

/** Extents start on this boundary, in sectors. 8 x 512 = 4 KiB. */
export const EXTENT_ALIGN = 8;

/** Round a sector count up to the next whole extent boundary. */
export function alignExtent(sectors: number): number {
  return Math.ceil(sectors / EXTENT_ALIGN) * EXTENT_ALIGN;
}

/** How many sectors a payload of this many bytes occupies, rounded up to the alignment. */
export function sectorsFor(byteLength: number): number {
  return alignExtent(Math.ceil(byteLength / SECTOR));
}

/** Absolute sector of a region-relative one, for a caller addressing the eMMC. */
export function absolute(regionSector: number): number {
  return REGION_START + regionSector;
}
