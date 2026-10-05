/**
 * What writing a set of tables to the Waverider store would do, as a value.
 *
 * ## Why a plan and not a writer
 *
 * Two reasons, and the second is the one that made it a separate file.
 *
 * **It is what the owner is shown before anything is sent.** A list of sectors with their lengths
 * and hashes is something a person can look at and refuse. "Trust me, I am about to write 4 MiB to
 * sector 3,145,728" is not.
 *
 * **And the firmware session replays it.** They asked for the writes as data — sector, length,
 * hash — so a plan built here can be checked against their reader's own idea of the layout in
 * *their* tests, before either side goes near an instrument. A plan is therefore a pure value with
 * no transport attached and no I/O anywhere in this file.
 *
 * ## The ordering is the safety property
 *
 * `writes` is in the order the writes must happen: **data, then the index of the group that is not
 * current, then that group's superblock with generation + 1.** Anything else and a failed write
 * can leave a valid superblock pointing at data that is not there.
 *
 * A caller must not reorder it, and `planWrite` is the only thing that builds it. The test asserts
 * the order rather than trusting the construction, because this is the rule that makes a cancelled
 * transfer survivable and it is one refactor away from being silently wrong.
 *
 * ## `describePlan` stays here
 *
 * It is the plan's own projection — the same value without its payloads — rather than a second
 * job. It changes when `WritePlan` changes, which is the test that matters, and a twenty-line
 * module beside the type it serialises would cost a file to say nothing.
 */

import { xxHash32 } from "./xxhash32.js";
import {
  type Group,
  DATA_END,
  DATA_START,
  GROUP_A,
  GROUP_B,
  INDEX_ENTRIES,
  SECTOR,
  SLOT_BYTES,
  absolute,
  slotSector,
} from "./layout.js";
import { type TableEntry, FORMAT_INT16_BE, writeIndex } from "./entries.js";
import { WaveriderError } from "./errors.js";
import { type Superblock, writeSuperblock } from "./superblock.js";
import { validateIndex } from "./validate.js";

/** One contiguous write, aligned to a sector and a whole number of sectors long. */
export interface SectorWrite {
  /** What this is, which is also the order they must happen in. */
  what: "data" | "index" | "superblock";
  /** First sector, relative to the start of the region. */
  sector: number;
  /** First sector on the eMMC, which is what a device write addresses. */
  absoluteSector: number;
  /** Bytes. Always a multiple of 512. */
  length: number;
  /** xxHash32 of exactly these bytes, seed 0 — for replaying a plan without carrying the bytes. */
  hash: number;
  /** The bytes. Padded with zeros to the sector. */
  bytes: Uint8Array;
  /** The slot this data belongs to, on a `data` write. */
  slot?: number;
}

export interface WritePlan {
  /** The group being written, which is never the current one. */
  group: Group;
  /** The generation the new superblock will carry. */
  generation: number;
  /** In the order they must be sent. */
  writes: SectorWrite[];
  /** The index this plan results in, as entries. */
  entries: TableEntry[];
  /** Data sectors actually written, which excludes tables that did not move or change. */
  dataSectorsWritten: number;
  /** Tables whose data was skipped because the same bytes are already at the same place. */
  reused: number[];
}

/** A table to place: everything but where it goes, which the plan decides. */
export interface PendingTable {
  slot: number;
  name: string;
  waves: number;
  points: number;
  interpolate: boolean;
  /** The converted payload. See `convert.ts`. */
  payload: Uint8Array;
  sourceHash: number;
  sourceSize: number;
  gain: number;
  sampleFormat?: number;
}

/** What the store holds now, as read from the device. `undefined` for a region with no valid store. */
export interface CurrentStore {
  group: Group;
  superblock: Superblock;
  entries: readonly TableEntry[];
}

/** Pad to a whole number of sectors. The store writes sectors; a partial one does not exist. */
function toSectors(bytes: Uint8Array): Uint8Array {
  const whole = Math.ceil(bytes.length / SECTOR) * SECTOR;
  if (whole === bytes.length) return bytes;
  const out = new Uint8Array(whole);
  out.set(bytes);
  return out;
}

function write(
  what: SectorWrite["what"],
  sector: number,
  bytes: Uint8Array,
  slot?: number,
): SectorWrite {
  const padded = toSectors(bytes);
  return {
    what,
    sector,
    absoluteSector: absolute(sector),
    length: padded.length,
    hash: xxHash32(padded),
    bytes: padded,
    ...(slot === undefined ? {} : { slot }),
  };
}

/**
 * Work out what writing `tables` would do to the store described by `current`.
 *
 * Pure. Nothing is sent, nothing is read, and the same inputs give the same plan — which is what
 * lets the firmware session replay it.
 *
 * ## There is no allocation
 *
 * Slot `n`'s extent is `slotSector(n)`, always. The planner places nothing and chooses nothing a
 * reader could disagree with — see `SLOT_SECTORS` for why the allocator was removed rather than
 * fixed.
 *
 * **What survives is the part that was worth having.** A table whose payload hashes the same as
 * the one the current index already records for that slot is not rewritten; it is reported in
 * `reused` instead. With fixed extents that is now the common case rather than a lucky one,
 * because nothing moves when the set changes: editing one table of twenty writes one table.
 *
 * ## A stride change is a full rewrite and nothing else
 *
 * The slot size moved from 128 KiB to 512 KiB on the day it was agreed, so this is not a
 * hypothetical. Nothing special happens for it. The index a plan writes is built from `tables`
 * alone, so it describes exactly the tables given at exactly this build's geometry; and every reuse
 * check fails, because no table is where the old index says it is. The data is written once at the
 * new places and the old sectors are left unreferenced, which they already are the moment the new
 * superblock lands.
 *
 * **There is no migration path because there is nothing to migrate.** That falls out of putting the
 * whole index in every write rather than amending the one on the card, and `waverider.test.ts` pins
 * it with a store built at the old stride rather than trusting this paragraph.
 */
export function planWrite(options: {
  current?: CurrentStore | undefined;
  tables: readonly PendingTable[];
}): WritePlan {
  const { current, tables } = options;

  const slots = new Set<number>();
  for (const table of tables) {
    if (!Number.isInteger(table.slot) || table.slot < 0 || table.slot >= INDEX_ENTRIES) {
      throw new WaveriderError(`slot ${table.slot} is outside 0..${INDEX_ENTRIES - 1}`);
    }
    if (slots.has(table.slot)) {
      throw new WaveriderError(`two tables claim slot ${table.slot}`);
    }
    slots.add(table.slot);
    if (table.payload.length === 0) {
      throw new WaveriderError(`slot ${table.slot} (${table.name}) has an empty payload`);
    }
  }

  // Slot order, so the layout is a function of the content and not of the caller's array order.
  // Two callers asking for the same store get the same plan, which is what makes a replay useful.
  const ordered = [...tables].sort((a, b) => a.slot - b.slot);

  const byStart = new Map<number, TableEntry>();
  for (const entry of current?.entries ?? []) byStart.set(entry.slot, entry);

  const entries: TableEntry[] = [];
  const dataWrites: SectorWrite[] = [];
  const reused: number[] = [];

  for (const table of ordered) {
    const sampleFormat = table.sampleFormat ?? FORMAT_INT16_BE;
    const tableHash = xxHash32(table.payload);
    const at = slotSector(table.slot);

    // The only size rule left. A slot's extent cannot run past the region, because the last slot
    // ends on `DATA_END` by definition — so what remains is whether the payload fits its slot.
    if (table.payload.length > SLOT_BYTES) {
      throw new WaveriderError(
        `slot ${table.slot} (${table.name}) is ${table.payload.length} bytes and a slot holds ` +
          `${SLOT_BYTES}. A table that large needs a new sample format, not a bigger plan.`,
      );
    }

    entries.push({
      slot: table.slot,
      name: table.name,
      waves: table.waves,
      points: table.points,
      sampleFormat,
      interpolate: table.interpolate,
      startSector: at,
      byteLength: table.payload.length,
      tableHash,
      sourceHash: table.sourceHash,
      sourceSize: table.sourceSize,
      gain: table.gain,
    });

    // Already there, byte for byte. The hash is the device's own definition of "the same bytes",
    // so this is not a guess about what is on the card — it is what the current index says is on
    // the card, which is the only claim DNX can make without re-reading it.
    //
    // `startSector` is still compared, although it cannot differ for a given slot today. It is the
    // cheapest possible guard against a current index that disagrees with this build's layout,
    // which is exactly what reading a store written by a future version would look like.
    const existing = byStart.get(table.slot);
    const unchanged =
      existing !== undefined &&
      existing.startSector === at &&
      existing.tableHash === tableHash &&
      existing.byteLength === table.payload.length;

    if (unchanged) reused.push(table.slot);
    else dataWrites.push(write("data", at, table.payload, table.slot));
  }

  /*
   * **Judge, then encode.** `validate.ts` refuses overlap, bounds, alignment and a geometry that
   * disagrees with the payload length; `entries.ts` only writes bytes. This is the composition,
   * and it lives here because this is the only route to a write — see `entries.ts` on why the
   * encoder stopped doing it itself.
   */
  validateIndex(entries);
  const indexBytes = writeIndex(entries);

  // The group that is **not** current, so a failure leaves the current one describing the store as
  // it was. A virgin region has no current group and starts at A.
  const group = current?.group.name === "A" ? GROUP_B : GROUP_A;
  const generation = (current?.superblock.generation ?? 0) + 1;

  const superblockBytes = writeSuperblock(
    { generation, entryCount: entries.length, dataStart: DATA_START, dataEnd: DATA_END },
    indexBytes,
  );

  return {
    group,
    generation,
    // **Data, then index, then superblock.** The one ordering that makes a cancelled write cost
    // only the attempt.
    writes: [
      ...dataWrites,
      write("index", group.index, indexBytes),
      write("superblock", group.superblock, superblockBytes),
    ],
    entries,
    dataSectorsWritten: dataWrites.reduce((n, w) => n + w.length / SECTOR, 0),
    reused,
  };
}

/**
 * A plan without its bytes, for showing a person or handing to another implementation.
 *
 * This is the form the firmware session replays: everything needed to check the layout, and
 * nothing that needs megabytes moved between sessions to look at.
 */
export function describePlan(plan: WritePlan): {
  group: "A" | "B";
  generation: number;
  writes: { what: string; sector: number; absoluteSector: number; length: number; hash: string }[];
  dataSectorsWritten: number;
  reused: number[];
} {
  return {
    group: plan.group.name,
    generation: plan.generation,
    writes: plan.writes.map((w) => ({
      what: w.what,
      sector: w.sector,
      absoluteSector: w.absoluteSector,
      length: w.length,
      hash: `0x${w.hash.toString(16).padStart(8, "0")}`,
    })),
    dataSectorsWritten: plan.dataSectorsWritten,
    reused: plan.reused,
  };
}
