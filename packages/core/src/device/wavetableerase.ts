/**
 * Removing everything Waverider put on the +Drive: every table, every pool list.
 *
 * **One job: the erase, done safely.** The 512 bytes it sends are `waverider/erasefile.ts`; this
 * is the care around sending them, which is nearly all of the work.
 *
 * For somebody returning an instrument to how Elektron shipped it — a warranty claim, a sale.
 * FORMAT +DRIVE and factory reset never touch this region, so without this there is no way back
 * short of a service-mode tool. It has to run **before** stock firmware goes back on, because
 * stock has no route to it.
 *
 * ## Every table is copied before anything is sent
 *
 * The owner's condition for it existing at all, 2026-10-14: *make it a two way door*. So this
 * reads every used slot off the card, and every used pool list, and hands each one to the backup
 * hook **before the question is asked**. A single failed read abandons the whole run with nothing
 * sent.
 *
 * The pool lists were not copied at first, found by audit on 2026-10-16. Restoring every table
 * still left each project's pool gone: which table sat at which TBL number exists nowhere else.
 * A list is 512 bytes, so the copies cost one read each. That is minutes
 * on a full store, and it is the feature rather than an overhead on it: the copies are what makes
 * the erase reversible, and `pendingFromSlotFile` reads them back.
 *
 * A failure partway leaves the instrument untouched, because nothing has been sent yet. That is
 * the whole reason the copying comes first.
 *
 * ## The counts are the confirmation
 *
 * The request carries how many tables and lists were in use **when the person agreed**. The
 * firmware counts again at the commit and refuses if either moved, so a yes given against a stale
 * listing cannot erase something that arrived since — from the instrument's own page, or another
 * application. A refusal here is not an error to retry blind: re-list, show the new numbers, ask
 * again. See `prove` below for why the refusal is silent.
 *
 * ## The listings are the proof
 *
 * Every refusal on this route is silent: the session answered the commit before the store acted.
 * So the result is read rather than believed — no used table, no used pool list, and `/wavepool/0`
 * reading as an empty pool. Same rule as the single delete and the pool write, and the same
 * reason: this is the shape that cost us slot 9.
 */

import { type MessageIds, IDS_FOR } from "./messageids.js";
import { type BackupHook, type ConfirmHook } from "./safewrite.js";
import { type Entry, listRequest, wholeListing } from "./storage.js";
import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { readFormOption } from "./storagewrite.js";
import { safeWriteControl } from "./safewrite.js";
import { buildEraseRequest, ERASE_SLOT } from "../waverider/erasefile.js";
import { readPoolFile, poolState } from "../waverider/poolfile.js";
import { WAVERIDER, slotPath } from "./waveriderwrite.js";

export class WavetableEraseError extends Error {}

/** `/wavepool`, as the pool reader names it. */
const WAVEPOOL = "/wavepool";

/** What a person is told before the whole region goes. */
export interface EraseReview {
  /** Entries `/waverider` lists as used. Each one has a copy. */
  tables: number;
  /** Project slots `/wavepool` lists as used. Each one has a copy too. */
  lists: number;
  /** Total bytes copied, so the question can say how much was rescued. */
  copied: number;
  /** The names of the tables going, for a list somebody can scan. */
  names: string[];
}

export interface EraseHost {
  ids: MessageIds;
  gate: () => void;
  confirm: ConfirmHook<EraseReview>;
}

export interface EraseOptions {
  transport: ApiTransport;
  host: EraseHost;
  /**
   * Handed every table before the question is asked. **Required and not optional**: the copies
   * are the only way back, so a run without them is not an erase this module will perform.
   */
  onBackup: BackupHook;
  onStatus?: (message: string) => void;
  /** `done` of `total` copies taken, tables then pool lists, for a bar: this takes minutes. */
  onProgress?: (done: number, total: number) => void;
  timeoutMs?: number;
}

export interface EraseResult {
  cancelled: boolean;
  /** **The proof**: both listings read empty afterwards and `/wavepool/0` is an empty pool. */
  erased: boolean;
  /** What was there, which is also what was copied. */
  tables: number;
  lists: number;
  copied: number;
  /** Set when the listings still show something, which is how a silent refusal looks. */
  problem?: string;
}

/** Both listings, as the counts the request carries and the proof afterwards. */
async function census(
  transport: ApiTransport,
  ids: MessageIds,
  timeoutMs: number,
): Promise<{ tables: Entry[]; lists: Entry[] }> {
  const read = async (root: string): Promise<Entry[]> => {
    const msgId = ids.reserve(IDS_FOR.oneMessage);
    const reply = await transport.request(listRequest(msgId, root), msgId, timeoutMs);
    return wholeListing(reply, root).entries.filter((entry) => entry.occupied === true);
  };
  return { tables: await read(WAVERIDER), lists: await read(WAVEPOOL) };
}

/**
 * Erase the wavetable region, having copied every table off it first.
 *
 * Returns rather than throws for the outcomes a person should see — an empty store, a refusal, an
 * erase that did not take. A transport failure, or a copy that cannot be read, still throws:
 * those stop the run before anything is sent, which is the point.
 */
export async function eraseWavetableStore(options: EraseOptions): Promise<EraseResult> {
  const { transport, host } = options;
  const status = options.onStatus ?? ((): void => {});
  const progress = options.onProgress ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? 60_000;

  host.gate();
  if (typeof host.confirm !== "function") {
    throw new WavetableEraseError("refusing to erase without a confirmation hook");
  }
  if (typeof options.onBackup !== "function") {
    throw new WavetableEraseError(
      "refusing to erase without a backup hook — the copies are the only way back, and an erase " +
        "that saves nothing is not one this will perform",
    );
  }

  status("Listing the wavetable store and the pools…");
  const before = await census(transport, host.ids, timeoutMs);

  /*
   * **An empty region is still a legal request**, and deliberately still sent: it is what
   * finishes an erase interrupted between the metadata write and the TRIM, where the store
   * already reads empty and unreferenced bytes remain. Nothing is copied because there is nothing
   * to copy, and the question still gets asked.
   */
  const names: string[] = [];
  let copied = 0;
  const total = before.tables.length + before.lists.length;
  for (const [nth, entry] of before.tables.entries()) {
    const path = slotPath(entry.index);
    status(`Copying ${nth + 1} of ${before.tables.length}: ${entry.name || path}…`);
    progress(nth, total);

    // A read that fails stops everything, here, with nothing sent. See this module's note.
    const copy = await readStoredFile(path, {
      transport,
      ...readFormOption(path),
      msgId: host.ids.reserve(IDS_FOR.oneObject),
      timeoutMs,
    });
    await options.onBackup({
      name: `waverider-${entry.index}-${entry.name || "table"}.bin`,
      kind: "storedFile",
      bytes: copy.bytes,
      slots: [entry.index],
    });
    copied += copy.bytes.length;
    names.push(entry.name || `slot ${entry.index}`);
  }

  // The pool lists, the same way. The name carries the project slot, which a restore reads back.
  for (const [nth, entry] of before.lists.entries()) {
    const path = `${WAVEPOOL}/${entry.index}`;
    status(`Copying pool list ${nth + 1} of ${before.lists.length}…`);
    progress(before.tables.length + nth, total);
    const copy = await readStoredFile(path, {
      transport,
      ...readFormOption(path),
      msgId: host.ids.reserve(IDS_FOR.oneObject),
      timeoutMs,
    });
    await options.onBackup({
      name: `wavepool-${entry.index}.bin`,
      kind: "storedFile",
      bytes: copy.bytes,
      slots: [entry.index],
    });
    copied += copy.bytes.length;
  }
  progress(total, total);

  const agreed = await host.confirm({
    tables: before.tables.length,
    lists: before.lists.length,
    copied,
    names,
  });
  if (!agreed) {
    return { cancelled: true, erased: false, tables: before.tables.length, lists: before.lists.length, copied };
  }

  /*
   * **The counts are the ones just shown.** Not re-read here: re-reading would defeat the guard,
   * which exists precisely to refuse a yes given against a listing that has since moved.
   */
  status("Erasing the wavetable region…");
  await safeWriteControl({
    transport,
    path: `${WAVEPOOL}/${ERASE_SLOT}`,
    bytes: buildEraseRequest({
      tables: before.tables.length,
      lists: before.lists.length,
    }),
    gate: host.gate,
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
    onStatus: status,
  });

  status("Checking the region is empty…");
  const after = await census(transport, host.ids, timeoutMs);

  // And the pool of the working project, which must now read as having none of its own.
  let poolEmpty = false;
  try {
    const record = readPoolFile(
      (await readStoredFile(`${WAVEPOOL}/0`, {
        transport,
        ...readFormOption(`${WAVEPOOL}/0`),
        msgId: host.ids.reserve(IDS_FOR.oneObject),
        timeoutMs,
      })).bytes,
    );
    poolEmpty = poolState(record) === "empty";
  } catch {
    // A pool that cannot be read is not proof of anything either way, and the two listings above
    // are the stronger evidence. Left false so the result says the check did not pass.
    poolEmpty = false;
  }

  const erased = after.tables.length === 0 && after.lists.length === 0 && poolEmpty;
  return {
    cancelled: false,
    erased,
    tables: before.tables.length,
    lists: before.lists.length,
    copied,
    ...(erased
      ? {}
      : {
          problem:
            `the instrument answered the request and ${after.tables.length} table(s) and ` +
            `${after.lists.length} pool list(s) are still listed` +
            (poolEmpty ? "" : ", and the working project's pool does not read as empty") +
            `. The likeliest cause is that the store changed between the question and the send, ` +
            `which the firmware refuses silently. Nothing was copied over and nothing else was ` +
            `changed: list again and ask again.`,
        }),
  };
}
