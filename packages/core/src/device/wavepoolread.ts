/**
 * Reading a project's pool and the store it names, in one pass.
 *
 * **One job: both halves at the same moment.** `wavepoolwrite.ts` writes a pool and
 * `waverider/poolview.ts` joins the two readings; this is the read, and the reason it is one
 * function rather than two is the timing.
 *
 * A pool entry naming a store slot that is free reads as MISSING, which is DNX telling somebody a
 * sound of theirs now plays the wrong thing. **Taken from a listing read minutes earlier, that
 * claim is wrong in both directions**: a table uploaded since looks deleted, and a table deleted
 * since looks present. So the record and the listing are read together, with nothing in between.
 *
 * The listing is the whole store, 256 slots in one message. The record is 555 bytes in one chunk.
 * The pair costs two round trips, which is why there is no cache here and no reason for one.
 */

import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { type MessageIds, IDS_FOR } from "./messageids.js";
import { listRequest, wholeListing } from "./storage.js";
import { readFormOption } from "./storagewrite.js";
import { WAVERIDER } from "./waveriderwrite.js";
import { poolPath } from "./wavepoolwrite.js";
import { type PoolRecord, readPoolFile } from "../waverider/poolfile.js";
import {
  type PoolSummary,
  type StoreSlotFacts,
  summarisePool,
} from "../waverider/poolview.js";
import { INDEX_ENTRIES } from "../waverider/layout.js";

export interface ReadPoolOptions {
  transport: ApiTransport;
  ids: MessageIds;
  /** `0` the working project, `1..128` as `/projects` numbers them. */
  projectSlot: number;
  timeoutMs?: number;
}

export interface PoolReading {
  record: PoolRecord;
  /** Every slot the listing gave, in slot order. */
  store: StoreSlotFacts[];
  summary: PoolSummary;
  /**
   * Slots the listing did not mention.
   *
   * `/waverider` lists all 256 in one reply, so this is empty in practice. It is reported rather
   * than assumed away because a cut listing would otherwise turn every unlisted entry into a
   * MISSING cell — a short reply read as somebody's deleted work.
   */
  unlisted: number;
}

/**
 * The store's listing, as the pane's right-hand side and the join both need it.
 *
 * Names and occupancy only: **a listing cannot say what geometry a table is**, because every slot
 * reports the fixed 512 KiB extent as its size. Judging whether the pool will play a table costs
 * one file read per slot, so nothing here claims it.
 */
export async function readStoreListing(
  transport: ApiTransport,
  ids: MessageIds,
  timeoutMs = 10_000,
): Promise<StoreSlotFacts[]> {
  const id = ids.reserve(IDS_FOR.oneMessage);
  const reply = await transport.request(listRequest(id, WAVERIDER), id, timeoutMs);
  return wholeListing(reply, WAVERIDER).entries
    .filter((entry) => entry.index < INDEX_ENTRIES)
    .map((entry) => ({
      slot: entry.index,
      ...(entry.occupied === true && entry.name.trim().length > 0
        ? { name: entry.name.trim() }
        : {}),
      occupied: entry.occupied === true,
    }))
    .sort((a, b) => a.slot - b.slot);
}

/** One project's pool record. */
export async function readPoolRecord(
  transport: ApiTransport,
  ids: MessageIds,
  projectSlot: number,
  timeoutMs = 10_000,
): Promise<PoolRecord> {
  const path = poolPath(projectSlot);
  const file = await readStoredFile(path, {
    transport,
    // Asked rather than assumed, as every read in core does: a read in the wrong form succeeds and
    // returns different bytes.
    ...readFormOption(path),
    msgId: ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
  });
  return readPoolFile(file.bytes);
}

/**
 * Read a pool and the store together, and join them.
 *
 * The listing first, because it is one message and the record's read holds a file handle: a
 * failure between the two should not leave a handle open while a second request goes out.
 */
export async function readPool(options: ReadPoolOptions): Promise<PoolReading> {
  const { transport, ids, projectSlot } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const store = await readStoreListing(transport, ids, timeoutMs);
  const record = await readPoolRecord(transport, ids, projectSlot, timeoutMs);

  return {
    record,
    store,
    summary: summarisePool(record, store),
    unlisted: INDEX_ENTRIES - store.length,
  };
}
