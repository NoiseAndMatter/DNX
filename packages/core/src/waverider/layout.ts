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
 * Sectors reserved for each slot. **Slot `n` always lives at `DATA_START + n * SLOT_SECTORS`.**
 *
 * ## Why a fixed stride rather than an allocator
 *
 * The first design packed extents contiguously in slot order and compacted, which keeps the store
 * dense and was a mistake. **Compaction cannot be expressed one slot at a time**, and one slot at a
 * time is how the device applies a change: delete slot 0 and everything shifts down, so slot 1 now
 * wants sectors slot 0 still occupies and the device's overlap check refuses it. A general
 * reordering has no safe order at all.
 *
 * With a fixed stride there is nothing to compact, **overlap is impossible by construction**, and
 * the device's check stops being a search over the index and becomes arithmetic: *is this extent
 * exactly slot n's?*
 *
 * It also removed a rule neither side had spotted — that a slot being rewritten must be excluded
 * from its own overlap check — by removing the check.
 *
 * ## The size, and why this one
 *
 * 512 KiB, which is one table at Tonverk's largest native geometry: 64 waves of 4,096 points of
 * int16 is 524,288 bytes, a slot exactly. **The owner set that target** (2026-10-05), and it is the
 * right one because DNX stores a table at full resolution. A slot has to hold the largest table
 * anybody would import, which is a different number from the largest the current DSP geometry
 * plays. Today's v1 table is 16 KiB of it.
 *
 * What the DSP can hold and play at once is a different limit and not this one: its load area is
 * 2 MB, four of the largest tables, and which tables are in it is decided when they are loaded.
 *
 * **128 KiB was agreed first and replaced before anything was written.** It held eight v1 tables and
 * would have truncated the one import that matters. The replacement cost one constant and no
 * migration, for the reason in `plan.ts`: a stride change is a full rewrite and nothing else.
 */
export const SLOT_SECTORS = 0x400;

/** Bytes reserved per slot: the allocation a listing reports, not a table's length. */
export const SLOT_BYTES = SLOT_SECTORS * SECTOR;

/**
 * One past the last sector data may occupy, relative to the region.
 *
 * The end of slot 255, so it falls out of the stride rather than being chosen. Written into every
 * superblock as `dataEnd`.
 */
export const DATA_END = DATA_START + INDEX_ENTRIES * SLOT_SECTORS;

/**
 * How many slots are wholly inside the pSLC: 92, with slot 92 starting exactly on the boundary.
 *
 * **Derived, and no check here uses it.** 256 slots of 512 KiB end 130 MiB into the region and the
 * pSLC ends 48 MiB in, so most of the store sits on TLC, which costs load speed and nothing else.
 * That is the price of a stride big enough for a Tonverk table. This constant exists to be pinned
 * against the shared document, and to answer somebody asking why a high slot loads slower than a
 * low one.
 */
export const FAST_SLOTS = Math.floor((FAST_SECTORS - DATA_START) / SLOT_SECTORS);

/** Where slot `n`'s extent begins, relative to the region. A function, never a search. */
export function slotSector(slot: number): number {
  return DATA_START + slot * SLOT_SECTORS;
}

/** How many sectors a payload of this many bytes occupies. */
export function sectorsFor(byteLength: number): number {
  return Math.ceil(byteLength / SECTOR);
}

/** Absolute sector of a region-relative one, for a caller addressing the eMMC. */
export function absolute(regionSector: number): number {
  return REGION_START + regionSector;
}
