/**
 * Writing one wavetable to a `/waverider` slot on the instrument.
 *
 * **One job: the sequence around a single slot write.** The file's bytes are
 * `waverider/slotfile.ts`, the safety sequence is `safewrite.ts`, and whether the table will play
 * is `waverider/pool.ts`. This composes them and adds the one check the generic path cannot make.
 *
 * ## Almost all of this already existed
 *
 * `safeWriteFile` arms a gate, asks a person, copies what it is about to replace, sends, and reads
 * back to compare. None of that needed changing for this route, because the per-route form work
 * made it correct here: `refuseWrongForm` expects raw on `/waverider`, `readFormOption` reads it
 * back raw, and `compareStored` already excuses the two bytes the device stamps. A route that
 * needed a parallel write path would have been a sign the first one was wrong.
 *
 * ## The check that is new, and why it has to be here
 *
 * **The device cannot refuse at the commit.** The stock session decides the `0x59` reply before it
 * calls the store's commit callback and ignores what the callback returns, so a write the store
 * rejects answers `commit ok` and writes nothing. Measured on slot 9: the commit succeeded and the
 * slot never appeared in a listing.
 *
 * So a successful commit is not evidence. This re-lists the directory afterwards and requires the
 * slot to be occupied, which is the thing the firmware session's own trace used as proof. The
 * read-back comparison would also catch it — an open on an empty slot answers `slot 7: empty` — but
 * a listing says *the store took it* rather than *something answered*, and it is one message.
 *
 * ## Silence is not failure here
 *
 * The pool refills on the next UI pass after a commit, about a second, and only for tables of
 * the one geometry it loads.
 * A caller is told both: `willPlay` for the geometry, and the delay in the status line, because a
 * table that is stored, verified and silent is otherwise indistinguishable from a failed write.
 */

import { type ApiTransport } from "./storagesession.js";
import { type BackupHook, type SafeFileWriteResult, safeWriteFile } from "./safewrite.js";
import { type DriveWriteHost } from "./driveproject.js";
import { type Entry, ListingError, listRequest, wholeListing } from "./storage.js";
import { IDS_FOR } from "./messageids.js";
import { type PendingSlot, buildSlotFile } from "../waverider/slotfile.js";
import { INDEX_ENTRIES } from "../waverider/layout.js";
import { type PlayableBounds, unplayableReason } from "../waverider/pool.js";

/** The route. Zero-based, deliberately unlike `/projects`. */
export const WAVERIDER = "/waverider";

export function slotPath(slot: number): string {
  return `${WAVERIDER}/${slot}`;
}

export interface WriteTableOptions {
  transport: ApiTransport;
  /**
   * The switch, the dialog and the message ids, the same shape every other write in core takes.
   *
   * **`gate` is required rather than assumed**, because core has no idea whether a host has such a
   * switch, and it is called before a byte is sent. `writeenable.test.ts` holds that property by
   * scanning for it, and it caught this module when it first took a bare `gate` of its own instead
   * of the house shape. A convention a guard can check is worth more than a slightly tidier
   * signature.
   */
  host: DriveWriteHost;
  /** The table and everything the index records about it. The hash is computed, never passed. */
  table: PendingSlot;
  /** Allow a slot that already holds a table. Requires `onBackup`. */
  overwrite?: boolean;
  /**
   * What this instrument's pool plays, from `askWaveriderSupport`. Omitted means the 16 x 512 rule.
   *
   * **Taken rather than read here.** This path has a transport and could ask `/modinfo` itself, and
   * that would put the capability gate in the write primitive, where a second copy of the rule
   * would drift from `featuresFrom`. A caller that has asked passes the answer; one that has not
   * gets the older rule, which is right for the builds that have no record at all.
   */
  playable?: PlayableBounds;
  onBackup?: BackupHook;
  onStatus?: (message: string) => void;
  onProgress?: (done: number, total: number, stage: "write" | "verify" | "backup") => void;
  timeoutMs?: number;
}

export interface WriteTableResult {
  slot: number;
  cancelled: boolean;
  /** Bytes of file sent, which is the entry and the table and the container around them. */
  written: number;
  committed: boolean;
  /** The read-back matched what was sent, the stamped bytes excused. */
  verified: boolean;
  /** The directory shows the slot in use afterwards. **The only proof the store took it.** */
  listed: boolean;
  /** The name the directory reports, which is the entry's name as the device read it. */
  listedAs?: string;
  /** `undefined` when the pool will load it; otherwise why it will not. */
  unplayable?: string;
  problem?: string;
}

export class WaveriderWriteError extends Error {}

/** One listing of the route, as the entry for a slot. */
async function entryForSlot(
  transport: ApiTransport,
  slot: number,
  msgId: number,
  timeoutMs: number,
): Promise<Entry> {
  const reply = await transport.request(listRequest(msgId, WAVERIDER), msgId, timeoutMs);
  const listing = wholeListing(reply, WAVERIDER);
  const entry = listing.entries.find((e) => e.index === slot);
  if (!entry) {
    throw new WaveriderWriteError(
      `slot ${slot} is not in the ${WAVERIDER} listing, so there is nothing to check before ` +
        `writing to it. The listing held ${listing.entries.length} entries.`,
    );
  }
  return entry;
}

/**
 * Write a table into a slot, and prove the store took it.
 *
 * Returns rather than throws for a write that was refused or could not be confirmed, because every
 * one of those outcomes is something to show a person. A transport failure still throws.
 */
export async function writeTableToSlot(options: WriteTableOptions): Promise<WriteTableResult> {
  const { transport, host, table } = options;
  const slot = table.slot;
  const status = options.onStatus ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (!Number.isInteger(slot) || slot < 0 || slot >= INDEX_ENTRIES) {
    throw new WaveriderWriteError(`slot ${slot} is outside 0..${INDEX_ENTRIES - 1}`);
  }

  // Built before anything is asked or sent, so a table the firmware would refuse is refused here
  // and the person is never asked about a write that cannot work.
  const bytes = buildSlotFile(table);
  const unplayable = unplayableReason(table, options.playable);

  const target = await entryForSlot(transport, slot, host.ids.reserve(IDS_FOR.oneMessage), timeoutMs);

  // Checked here as well as inside `safeWriteFile`, and not as belt and braces: this one arrives
  // before the listing work and the dialog, and the write primitive requires its own rather than
  // taking a caller's word that one was consulted.
  host.gate();
  const result: SafeFileWriteResult = await safeWriteFile({
    gate: host.gate,
    transport,
    path: slotPath(slot),
    name: table.name,
    bytes,
    target,
    confirm: host.confirm,
    ...(options.overwrite === true ? { overwrite: true } : {}),
    ...(options.onBackup === undefined ? {} : { onBackup: options.onBackup }),
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    verifyMsgId: host.ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  if (result.cancelled) {
    return { slot, cancelled: true, written: 0, committed: false, verified: false, listed: false };
  }

  /*
   * **The listing, which is the only proof.** A commit cannot fail, so `committed` says a reply
   * arrived and nothing more. This is the step the firmware session's trace used: write, list, see
   * the slot.
   */
  status(`Confirming — reading the ${WAVERIDER} listing…`);
  let listed = false;
  let listedAs: string | undefined;
  try {
    const after = await entryForSlot(transport, slot, host.ids.reserve(IDS_FOR.oneMessage), timeoutMs);
    listed = after.occupied === true;
    listedAs = after.name;
  } catch (error) {
    if (!(error instanceof ListingError) && !(error instanceof WaveriderWriteError)) throw error;
    return {
      slot, cancelled: false, written: bytes.length, committed: result.committed,
      verified: result.verified, listed: false,
      ...(unplayable === undefined ? {} : { unplayable }),
      problem: `the write reported success and the listing could not be read back: ${(error as Error).message}`,
    };
  }

  const problem = !listed
    ? `the commit reported success and slot ${slot} is still empty in the listing. The store ` +
      `rejected the file after the commit had already been answered, which it cannot refuse.`
    : !result.verified
      ? `the slot is in use but the read-back differs: ${result.mismatches.map((m) => m.reason).join("; ")}`
      : undefined;

  if (problem === undefined) {
    status(
      unplayable === undefined
        ? `Slot ${slot} written and confirmed. The pool reloads on the next pass, about a second, so give it a moment before listening.`
        : `Slot ${slot} written and confirmed, and it will not play yet: ${unplayable}`,
    );
  }

  return {
    slot,
    cancelled: false,
    written: bytes.length,
    committed: result.committed,
    verified: result.verified,
    listed,
    ...(listedAs === undefined ? {} : { listedAs }),
    ...(unplayable === undefined ? {} : { unplayable }),
    ...(problem === undefined ? {} : { problem }),
  };
}
