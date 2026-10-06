/**
 * Renaming a table in place, without moving its samples.
 *
 * **One job: change 64 bytes of an index entry.** `waveriderwrite.ts` sends a whole table and
 * `waveriderdelete` has no core module because the probe builds that request itself. This is here
 * rather than in the page because the rename is the one route whose *refusals are invisible*, and
 * the reasoning about them belongs beside the bytes rather than in a click handler.
 *
 * ## The write is an entry with no table after it
 *
 * The firmware takes a body of **exactly 128 bytes** on `/waverider/<slot>` as a rename: the index
 * entry, and nothing following it. Only the name, bytes 32 to 95, is read; **every other byte is
 * ignored**, which is why this sends zeros around it rather than fetching the stored entry first.
 *
 * That was not the first proposal. The original rule was that every other field must equal the
 * stored entry byte for byte, which sounds safer and is not: it would have made DNX copy a table
 * hash it did not compute, and a stale hash is the one input that passes every local check and
 * then silently writes nothing. Ignoring the rest gives the same guarantee — a rename **cannot**
 * change the geometry or the extent, because those bytes are never read — by construction instead
 * of by comparison.
 *
 * ## Two refusals that say nothing, and what this does about them
 *
 * A commit on this route cannot fail: the stock session answers before the store's callback runs.
 * So the firmware's two refusals are silent, and both are checked here instead:
 *
 * - **A free slot is refused.** Checked against a listing taken now, before anything is sent.
 * - **A name with no NUL in its 64 bytes writes nothing.** So a name of 64 characters is refused
 *   *locally*, with a message, rather than sent to vanish. 63 is the limit and the error says so.
 *
 * And the proof is the listing, as it is for a table write: the directory is read afterwards and
 * the name compared. A commit reply is not evidence on this route.
 *
 * ## What it does not touch
 *
 * The samples. A rename is one index write — the non-current group, then its superblock — so a
 * table of half a megabyte is renamed by moving 128 bytes, and nothing can go wrong with the audio
 * because the audio is never addressed.
 */

import { type ApiTransport } from "./storagesession.js";
import { type DriveWriteHost } from "./driveproject.js";
import { WAVERIDER, slotPath } from "./waveriderwrite.js";
import { type Entry, ListingError, listRequest, wholeListing } from "./storage.js";
import { IDS_FOR } from "./messageids.js";
import { type BackupHook, type SafeFileWriteResult, safeWriteFile } from "./safewrite.js";
import { ENTRY, encodeEntryName } from "../waverider/entries.js";
import { ENTRY_BYTES, INDEX_ENTRIES } from "../waverider/layout.js";
import { CONTENT_KIND_WAVETABLE, FORMAT_VERSION, STORE_FORMAT_VERSION } from "../waverider/slotfile.js";
import { WaveriderError } from "../waverider/errors.js";
import { buildContainer } from "../project/container.js";

/**
 * The longest name a rename may carry.
 *
 * **63, not 64**, and the one byte matters: the firmware looks for a NUL inside the 64, and a name
 * that fills them has none. It then writes nothing and answers `commit ok`, so a 64-character name
 * is a rename that reports success and does not happen.
 */
export const MAX_RENAME_LENGTH = ENTRY.nameBytes - 1;

/**
 * The 128-byte body that renames a slot: zeros, with the name in its place.
 *
 * Zeros rather than the stored entry because the firmware reads only the name. Sending a copy of
 * the entry would look more careful and would mean carrying a hash this code did not compute.
 */
export function buildRenameFile(slot: number, name: string): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot >= INDEX_ENTRIES) {
    throw new WaveriderError(`slot ${slot} is outside 0..${INDEX_ENTRIES - 1}`);
  }
  if (name.length === 0) {
    throw new WaveriderError("a rename needs a name; the device shows an empty one as blank");
  }
  if (name.length > MAX_RENAME_LENGTH) {
    throw new WaveriderError(
      `"${name}" is ${name.length} characters and a name may be ${MAX_RENAME_LENGTH}. The ` +
        `firmware looks for a NUL inside the entry's ${ENTRY.nameBytes} name bytes, so a name ` +
        `that fills them is written as nothing at all, and the commit still answers ok.`,
    );
  }

  const body = new Uint8Array(ENTRY_BYTES);
  body.set(encodeEntryName(name), ENTRY.name);

  return buildContainer({
    body,
    contentKind: CONTENT_KIND_WAVETABLE,
    objectVersion: STORE_FORMAT_VERSION,
    index: slot,
    formatVersion: FORMAT_VERSION,
  });
}

export interface RenameSlotOptions {
  transport: ApiTransport;
  host: DriveWriteHost;
  slot: number;
  name: string;
  /**
   * Handed the slot's current contents before the rename is sent. **Required**, as it is for
   * every overwrite in core.
   *
   * Worth knowing what it costs: the copy is the whole slot file, so a rename reads 16 KiB to
   * change 64 bytes. For one table that is nothing. For a batch it is the dominant cost, and the
   * honest options are to accept it or to change what a backup means for a field edit — which is
   * a change to the safety architecture and not one to make in passing.
   */
  onBackup: BackupHook;
  onStatus?: (message: string) => void;
  timeoutMs?: number;
}

export interface RenameSlotResult {
  slot: number;
  cancelled: boolean;
  /** What the listing called it before. Worth showing: a rename nobody can undo should say what it replaced. */
  was: string;
  name: string;
  committed: boolean;
  /** **The proof.** The listing calls it the new name afterwards. */
  renamed: boolean;
  /** What the listing calls it now, which on a failure is the interesting part. */
  listedAs?: string;
  problem?: string;
}

export class WaveriderRenameError extends Error {}

async function entryForSlot(
  transport: ApiTransport,
  slot: number,
  msgId: number,
  timeoutMs: number,
): Promise<Entry> {
  const reply = await transport.request(listRequest(msgId, WAVERIDER), msgId, timeoutMs);
  const entry = wholeListing(reply, WAVERIDER).entries.find((e) => e.index === slot);
  if (!entry) {
    throw new WaveriderRenameError(
      `slot ${slot} is not in the ${WAVERIDER} listing, so there is nothing to rename`,
    );
  }
  return entry;
}

/**
 * Rename one slot, and prove the store took it.
 *
 * Returns rather than throws for a rename that was refused or could not be confirmed, because each
 * is something to show a person. A transport failure still throws.
 */
export async function renameSlot(options: RenameSlotOptions): Promise<RenameSlotResult> {
  const { transport, host, slot, name } = options;
  const status = options.onStatus ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? 30_000;

  // Built first, so a name the firmware would silently discard is refused before anything is read
  // or anyone is asked.
  const bytes = buildRenameFile(slot, name);

  const before = await entryForSlot(
    transport,
    slot,
    host.ids.reserve(IDS_FOR.oneMessage),
    timeoutMs,
  );
  const was = before.name ?? "";

  /*
   * **The occupancy check is the firmware's other silent refusal.** A rename of a free slot writes
   * nothing and answers ok, so it is caught here where it can be explained.
   */
  if (before.occupied !== true) {
    return {
      slot,
      cancelled: false,
      was,
      name,
      committed: false,
      renamed: false,
      problem:
        `slot ${slot} is empty, and a rename needs a slot in use. Nothing was sent: the ` +
        `instrument would have answered ok and done nothing.`,
    };
  }

  host.gate();
  status(`Renaming ${slotPath(slot)} to "${name}"…`);
  const sent: SafeFileWriteResult = await safeWriteFile({
    gate: host.gate,
    transport,
    path: slotPath(slot),
    name,
    bytes,
    target: before,
    // A rename always targets an occupied slot, so it is always an overwrite by the rule's own
    // definition, and the rule requires a copy. See the note on what that copy costs.
    overwrite: true,
    onBackup: options.onBackup,
    confirm: host.confirm,
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
    /*
     * **The read-back cannot be compared, and skipping it is not a weaker check here.** What comes
     * back from the slot is the whole file, entry and table, 16,555 bytes against the 171 that
     * were sent. A byte comparison is not strict about a partial write; it is meaningless about
     * one. The proof is the listing below, which is the same proof a table write uses and for the
     * same reason: a commit on this route cannot refuse.
     */
    skipVerify: true,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  });

  if (sent.cancelled) {
    return { slot, cancelled: true, was, name, committed: false, renamed: false };
  }

  status("Confirming — reading the listing back…");
  let after: Entry;
  try {
    after = await entryForSlot(transport, slot, host.ids.reserve(IDS_FOR.oneMessage), timeoutMs);
  } catch (error) {
    if (!(error instanceof ListingError) && !(error instanceof WaveriderRenameError)) throw error;
    return {
      slot,
      cancelled: false,
      was,
      name,
      committed: sent.committed,
      renamed: false,
      problem: `the rename reported success and the listing could not be read back: ${(error as Error).message}`,
    };
  }

  const renamed = after.name === name;
  return {
    slot,
    cancelled: false,
    was,
    name,
    committed: sent.committed,
    renamed,
    ...(after.name === undefined ? {} : { listedAs: after.name }),
    ...(renamed
      ? {}
      : {
          problem:
            `the commit answered ok and the listing still calls slot ${slot} ` +
            `"${after.name ?? ""}". A refusal on this route cannot speak, so the reason is not ` +
            `knowable from here.`,
        }),
  };
}
