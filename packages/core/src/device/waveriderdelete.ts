/**
 * Deleting one wavetable from `/waverider`, with a copy taken first.
 *
 * **One job: freeing a store slot.** The counterpart to `waveriderwrite.ts`, and the same shape:
 * a gate, one confirmation, a backup hook, and a proof read from the instrument rather than from
 * the reply to the command.
 *
 * ## Why this is in core rather than in the page that uses it
 *
 * The flow existed and worked — in `web/src/probe/deletetable.ts`, which is a diagnostic surface
 * nobody managing a library is expected to open. The owner put it plainly on 2026-10-13: *if the
 * manager is a manager, how come I cannot delete them*. Lifting it here is what lets the Library
 * offer the same operation without a second implementation of the careful part, and lets a test
 * drive it against the emulator, which the probe's copy never could.
 *
 * ## The copy is taken before the question, not after it
 *
 * There is no undo on the instrument. A delete whose copy failed is a delete nobody can reverse,
 * so a failure reading the table stops everything **before** anybody is asked — being told after
 * agreeing that the copy did not work is not consent, and it is the same rule `safeWriteFile`
 * follows for an overwrite.
 *
 * ## The listing is the proof
 *
 * The device answers a delete the way it answers everything else on this route, which is to say
 * optimistically. So the slot is listed again afterwards and `deleted` is that answer, not the
 * command's. This is the shape that cost us slot 9, where a commit answered ok and wrote nothing;
 * a delete that reports success and leaves the table there would be the same mistake upside down.
 *
 * ## What it does not do
 *
 * **Nothing to any pool.** A pool entry names a store slot, so deleting a table leaves every entry
 * that named it pointing at an empty slot, which `poolview.ts` reports as MISSING. That is
 * deliberate and argued there: clearing those entries on somebody's behalf digs a hole the next
 * add drops into, and every sound still set to a later number would then play an unrelated table.
 * The caller is expected to say which pool slots will go MISSING; it cannot say it for pools it
 * has not read, and the firmware session's own note of 2026-10-13 adds the sharper case — a slot
 * refilled later makes those entries play the *new* table, in every project, silently.
 */

import { type MessageIds, IDS_FOR } from "./messageids.js";
import { type BackupHook, type ConfirmHook } from "./safewrite.js";
import { type Entry, deleteRequest, listRequest, wholeListing } from "./storage.js";
import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { readFormOption } from "./storagewrite.js";
import { WAVERIDER, slotPath } from "./waveriderwrite.js";

export class WaveriderDeleteError extends Error {}

/**
 * What a person is told before a table goes.
 *
 * **Its own type rather than `FileWriteReview`.** That one describes a write — it carries the
 * number of `0x58` chunks and a `replacing` name that is present only for an overwrite — and
 * handing it to a confirmation for a delete would be giving the dialog a review that says the
 * wrong thing about what is happening. The two questions are not alike and must not be phrasable
 * alike by accident.
 */
export interface DeleteReview {
  /** `/waverider/<slot>`. */
  path: string;
  slot: number;
  /** The name the listing gives. Empty where the device reports none. */
  name: string;
  /** Bytes of the copy that **has already been saved** by the time this is asked. */
  copied: number;
  /** The listing entry the occupied check was made against, taken moments earlier. */
  target: Entry;
}

/** The same shape `DriveWriteHost` takes, with a review that describes a delete. */
export interface DeleteHost {
  ids: MessageIds;
  gate: () => void;
  confirm: ConfirmHook<DeleteReview>;
}

export interface DeleteTableOptions {
  transport: ApiTransport;
  /** The switch, the dialog and the message ids, as every other write in core takes them. */
  host: DeleteHost;
  /** The store slot to free, `0..255`. */
  slot: number;
  /**
   * Handed the table that is about to go, before the question is asked.
   *
   * **Required, with no overwrite flag to excuse it.** Every other path in core makes the backup
   * conditional on there being something to lose; here there always is, because a delete of an
   * empty slot is refused above this line.
   */
  onBackup: BackupHook;
  onStatus?: (message: string) => void;
  timeoutMs?: number;
}

export interface DeleteTableResult {
  slot: number;
  cancelled: boolean;
  /** **The proof**: the slot reads free in a listing taken after the delete. */
  deleted: boolean;
  /** The name the listing gave before the delete, for a sentence afterwards. */
  name?: string;
  /** Size of the copy that was taken. */
  copied?: number;
  problem?: string;
}

/** One listing of the route, as the entry for a slot. */
async function entryFor(
  transport: ApiTransport,
  slot: number,
  msgId: number,
  timeoutMs: number,
): Promise<Entry> {
  const reply = await transport.request(listRequest(msgId, WAVERIDER), msgId, timeoutMs);
  const listing = wholeListing(reply, WAVERIDER);
  const entry = listing.entries.find((e) => e.index === slot);
  if (!entry) {
    throw new WaveriderDeleteError(
      `slot ${slot} is not in the ${WAVERIDER} listing, so there is nothing to check before ` +
        `deleting it. The listing held ${listing.entries.length} entries.`,
    );
  }
  return entry;
}

/**
 * Delete the table in one store slot.
 *
 * Returns rather than throws for the outcomes a person should see — an empty slot, a refusal, a
 * delete that did not take. A transport failure still throws.
 */
export async function deleteTableSlot(options: DeleteTableOptions): Promise<DeleteTableResult> {
  const { transport, host, slot } = options;
  const status = options.onStatus ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (!Number.isInteger(slot) || slot < 0 || slot > 255) {
    throw new WaveriderDeleteError(`store slot ${slot} is outside 0..255`);
  }
  host.gate();
  if (typeof host.confirm !== "function") {
    throw new WaveriderDeleteError("refusing to delete without a confirmation hook");
  }
  if (typeof options.onBackup !== "function") {
    throw new WaveriderDeleteError(
      "refusing to delete a table without a backup hook — there is no undo on the instrument, " +
        "so the copy is the only one there will be",
    );
  }

  const path = slotPath(slot);

  // **A listing taken now.** What matters is what is in the slot at this moment, and a delete of
  // an already-empty slot is a question not worth asking anybody.
  status(`Checking what is in ${path}…`);
  const before = await entryFor(transport, slot, host.ids.reserve(IDS_FOR.oneMessage), timeoutMs);
  if (before.occupied !== true) {
    return { slot, cancelled: false, deleted: false, problem: `${path} is already empty` };
  }

  // The copy, before the question. See this module's note.
  status(`Copying ${path} before deleting it…`);
  const copy = await readStoredFile(path, {
    transport,
    ...readFormOption(path),
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
  });
  await options.onBackup({
    name: `waverider-${slot}-${before.name || "table"}.bin`,
    kind: "storedFile",
    bytes: copy.bytes,
    slots: [slot],
  });

  const agreed = await host.confirm({
    path,
    slot,
    name: before.name ?? "",
    copied: copy.bytes.length,
    target: before,
  });
  if (!agreed) return { slot, cancelled: true, deleted: false, name: before.name };

  status(`Deleting ${path}…`);
  const msgId = host.ids.reserve(IDS_FOR.oneMessage);
  await transport.request(deleteRequest(msgId, path), msgId, timeoutMs);

  // The listing again, because the command's own reply is not evidence. See this module's note.
  status(`Checking ${path} is gone…`);
  const after = await entryFor(transport, slot, host.ids.reserve(IDS_FOR.oneMessage), timeoutMs);
  const deleted = after.occupied !== true;

  return {
    slot,
    cancelled: false,
    deleted,
    name: before.name,
    copied: copy.bytes.length,
    ...(deleted
      ? {}
      : {
          problem:
            `the instrument answered the delete and ${path} is still listed as in use` +
            `${after.name ? ` under the name ${after.name}` : ""}. Nothing else was changed.`,
        }),
  };
}
