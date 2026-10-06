/**
 * Writing one project's wavetable pool to `/wavepool/<project slot>`.
 *
 * **One job: the sequence around a pool write.** The record's bytes are `waverider/poolfile.ts`,
 * the safety sequence is `safewrite.ts`, and what the DSP will play is `waverider/pool.ts`. This
 * composes them and carries the one thing neither can know: **there is a second writer.**
 *
 * ## Two writers, and a refusal that cannot speak
 *
 * The instrument's own wavetable page writes record 0, and so does DNX. The sequence that loses
 * work without anything reporting a fault is the ordinary one:
 *
 * 1. DNX reads the pool, generation 4.
 * 2. The user adds a table on the instrument. Record 0 is generation 5.
 * 3. DNX writes the whole record. Step 2 is gone.
 *
 * The firmware answers this with a compare-and-swap on the generation: send `0` for no check, or
 * the generation you read, and anything else is refused. So this sends the generation it read.
 *
 * **But the refusal is silent.** The stock session answers the commit before the store's callback
 * runs, so a stale write replies `ok` and writes nothing — the same property that produced the
 * slot 9 silent write and the automatic-write trap. `wp_write.last` holds 26 for a stale write
 * and a PEEK is not something a user has.
 *
 * ## So the proof is the entries, and the generation is only corroboration
 *
 * The firmware session first suggested reading the generation back and checking it is `sent + 1`.
 * **That is not sound**, and the hole is exactly the case the compare-and-swap exists for: if the
 * other writer lands between our read and our write, our write is refused *and* the generation is
 * `before + 1` from theirs. A generation check calls that a success.
 *
 * What cannot be faked is the list. `compareStored` excuses the three fields the firmware owns —
 * the generation, the record hash and the container CRC — and compares everything else, so
 * `verified` means *the entries I sent are the entries it holds*. A malformed record is refused
 * the same silent way, so a failed comparison means **not written** and never says why on its own.
 *
 * That is why `stamped` exists on `safeWriteFile` rather than this module comparing by hand: the
 * excusal is a claim about the route, and it belongs next to the comparison it changes.
 */

import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { type BackupHook, type SafeFileWriteResult, safeWriteFile } from "./safewrite.js";
import { type DriveWriteHost } from "./driveproject.js";
import { readFormOption } from "./storagewrite.js";
import { type Entry, ListingError, listRequest, wholeListing } from "./storage.js";
import { IDS_FOR } from "./messageids.js";
import {
  type PoolRecord,
  PROJECT_SLOTS,
  RECORD,
  buildPoolFile,
  readPoolFile,
} from "../waverider/poolfile.js";
import { HEADER_BYTES, TRAILER_BYTES } from "../project/container.js";

/** The route. Project slot `0` is the working project; `1..128` are `/projects` numbers. */
export const WAVEPOOL = "/wavepool";

export function poolPath(projectSlot: number): string {
  return `${WAVEPOOL}/${projectSlot}`;
}

/**
 * The bytes of a pool file the firmware writes for itself, as offsets into the whole file.
 *
 * The generation, because it stamps `current + 1` and ignores what we send beyond the check; the
 * record's hash, because the generation changed under it; and the container's CRC, because the
 * body changed under that. Twelve bytes, named rather than discovered, and **everything else is
 * compared** — which is what makes the comparison the proof.
 */
export const STAMPED_BY_FIRMWARE: ReadonlySet<number> = new Set([
  ...[0, 1, 2, 3].map((i) => HEADER_BYTES + RECORD.generation + i),
  ...[0, 1, 2, 3].map((i) => HEADER_BYTES + RECORD.hash + i),
  ...[0, 1, 2, 3].map((i) => HEADER_BYTES + 512 + i),
]);

export class WavepoolWriteError extends Error {}

export interface WritePoolOptions {
  transport: ApiTransport;
  /** The switch, the dialog and the message ids, as every other write in core takes them. */
  host: DriveWriteHost;
  /** `0` the working project, `1..128` as `/projects` numbers them. */
  projectSlot: number;
  /**
   * The list to write: the **store slot** at each **pool index**, `undefined` for none.
   *
   * Shorter than a full pool is padded. An automatic pool is written by passing `automatic`.
   */
  entries?: readonly (number | undefined)[];
  /** Write the automatic record instead of a list. Refused together with `entries`. */
  automatic?: boolean;
  /**
   * Handed the record that is about to be replaced, before a byte is sent.
   *
   * Required, like every other overwrite in core: a pool slot almost always holds a record, so
   * this path is an overwrite nearly every time it runs.
   */
  onBackup: BackupHook;
  onStatus?: (message: string) => void;
  timeoutMs?: number;
}

export interface WritePoolResult {
  projectSlot: number;
  cancelled: boolean;
  written: number;
  committed: boolean;
  /** **The proof.** The entries read back are the entries that were sent. */
  landed: boolean;
  /** What the slot held before the write, which is also what was backed up. */
  before: PoolRecord;
  /** What it holds now. Read only when the write did not land, because that is when it matters. */
  after?: PoolRecord;
  /**
   * Another writer moved the record while this one held it.
   *
   * A guess, and labelled as one: the firmware cannot say why it refused, so a stale write and a
   * malformed one are indistinguishable from here. The generation having moved by something other
   * than our write is the only evidence there is, and it is evidence rather than proof.
   */
  probablyStale?: boolean;
  problem?: string;
}

async function readRecord(
  transport: ApiTransport,
  host: DriveWriteHost,
  projectSlot: number,
  timeoutMs: number,
): Promise<PoolRecord> {
  const file = await readStoredFile(poolPath(projectSlot), {
    transport,
    // Asked rather than assumed, so a new route cannot inherit another's form. `/wavepool` is raw.
    ...readFormOption(poolPath(projectSlot)),
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
  });
  return readPoolFile(file.bytes);
}

async function entryFor(
  transport: ApiTransport,
  projectSlot: number,
  msgId: number,
  timeoutMs: number,
): Promise<Entry> {
  const reply = await transport.request(listRequest(msgId, WAVEPOOL), msgId, timeoutMs);
  const entry = wholeListing(reply, WAVEPOOL).entries.find((e) => e.index === projectSlot);
  if (!entry) {
    throw new WavepoolWriteError(
      `project slot ${projectSlot} is not in the ${WAVEPOOL} listing, so there is nothing to ` +
        `check before writing to it`,
    );
  }
  return entry;
}

/**
 * Write a project's pool, and prove the instrument took the list.
 *
 * Returns rather than throws for a write that was refused or could not be confirmed, because each
 * of those is something to show a person. A transport failure still throws.
 */
export async function writePool(options: WritePoolOptions): Promise<WritePoolResult> {
  const { transport, host, projectSlot } = options;
  const status = options.onStatus ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? 30_000;
  const automatic = options.automatic === true;

  if (!Number.isInteger(projectSlot) || projectSlot < 0 || projectSlot >= PROJECT_SLOTS) {
    throw new WavepoolWriteError(`project slot ${projectSlot} is outside 0..${PROJECT_SLOTS - 1}`);
  }
  if (automatic && options.entries !== undefined && options.entries.some((e) => e !== undefined)) {
    throw new WavepoolWriteError(
      `project slot ${projectSlot}: an automatic pool carries no entries. Pass one or the other.`,
    );
  }

  /*
   * **Read first, and not only for the backup.** The generation this read returns is the
   * compare-and-swap token: sending it is what makes the instrument refuse the write if somebody
   * moved the record in between.
   */
  status(`Reading the pool at ${poolPath(projectSlot)}…`);
  const before = await readRecord(transport, host, projectSlot, timeoutMs);

  const bytes = buildPoolFile({
    projectSlot,
    automatic,
    entries: automatic ? [] : (options.entries ?? []),
    generation: before.generation,
  });

  const target = await entryFor(
    transport,
    projectSlot,
    host.ids.reserve(IDS_FOR.oneMessage),
    timeoutMs,
  );

  host.gate();
  const result: SafeFileWriteResult = await safeWriteFile({
    gate: host.gate,
    transport,
    path: poolPath(projectSlot),
    name: `the wavetable pool of project slot ${projectSlot}`,
    bytes,
    target,
    overwrite: true,
    onBackup: options.onBackup,
    confirm: host.confirm,
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    verifyMsgId: host.ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
    // See this module's note: these three fields are the firmware's, and everything else being
    // compared is what makes `verified` mean the entries landed.
    stamped: STAMPED_BY_FIRMWARE,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  });

  if (result.cancelled) {
    return {
      projectSlot,
      cancelled: true,
      written: 0,
      committed: false,
      landed: false,
      before,
    };
  }

  if (result.verified) {
    status(`The pool of project slot ${projectSlot} is written.`);
    return {
      projectSlot,
      cancelled: false,
      written: result.written,
      committed: result.committed,
      landed: true,
      before,
    };
  }

  /*
   * It did not land. One more read, only here, so the caller can show what the slot holds now
   * rather than only that something went wrong — which is the difference between a pane that can
   * offer *reload or overwrite* and one that can only apologise.
   */
  let after: PoolRecord | undefined;
  try {
    after = await readRecord(transport, host, projectSlot, timeoutMs);
  } catch (error) {
    if (!(error instanceof ListingError)) throw error;
  }

  const moved = after !== undefined && after.generation !== before.generation;
  return {
    projectSlot,
    cancelled: false,
    written: result.written,
    committed: result.committed,
    landed: false,
    before,
    ...(after === undefined ? {} : { after }),
    ...(moved ? { probablyStale: true } : {}),
    problem: moved
      ? `the pool of project slot ${projectSlot} was not written: it moved from generation ` +
        `${before.generation} to ${after!.generation} while this edit was open, so the ` +
        `instrument refused a write that would have discarded that change. The commit still ` +
        `reported success, because a refusal on this route cannot.`
      : `the pool of project slot ${projectSlot} was not written, and the record did not move. ` +
        `The commit reported success either way, because a refusal on this route cannot speak. ` +
        `${result.mismatches.map((m) => m.reason).join("; ")}`,
  };
}
