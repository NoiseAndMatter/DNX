/**
 * The one path that changes an instrument.
 *
 * ## What this replaces
 *
 * Pressing **Write to device** in the manager used to do this: diff the image, send the records
 * that differ, print how many went. No copy of what was there. No question asked. No check that the
 * bytes landed. The expander's write did the same, through the same function, and the probe's
 * +Drive write did its own third version of the sequence.
 *
 * Everything needed to do better already existed and was optional. `verifyWrite` has been in
 * `dumpwrite.ts` since the first write, with a note saying *"a write is not finished until it has
 * been read back and compared"* — and nothing outside the probe page called it. `readBackRecords`
 * had never been called at all, which is how a wrong `payloadBytes` sat in it undetected.
 *
 * **A guard nobody is obliged to use is documentation.** So this module is the obligation: the
 * primitives now require a `WritePermit`, only this file can produce one, and every step below runs
 * on the way past.
 *
 * ## The sequence, and what each step is actually for
 *
 * Adapted from digi-roll's `safe-write.js`, which is the same idea arrived at from the same
 * direction — its author had a pattern editor writing to a Digitakt II and the same problem of
 * several callers each remembering a different subset of the rules.
 *
 * 1. **Re-fetch.** The destination is read off the device *now*, not taken from the image in the
 *    editor. A manager session can sit open for an hour while somebody plays on the instrument, and
 *    writing a diff computed against an hour-old reading would silently revert whatever they did.
 *    This is also the only way to notice that it happened, which is step 2.
 * 2. **Say what moved.** Any destination slot whose bytes differ from what was read into the editor
 *    is named in the confirmation. Not merged — an image diff cannot be rebased, and pretending
 *    otherwise would be worse than saying so — but never overwritten silently.
 * 3. **Back up, or refuse.** The re-fetched records become a replayable `.syx` and go to the
 *    caller's hook before a byte is sent. If the hook throws, or if any destination slot did not
 *    answer, the write does not happen. **No backup, no write** — including the case where the
 *    backup is missing because the device went quiet, which is exactly when you want one.
 * 4. **Confirm.** A mandatory hook, handed a structured review rather than a string, so a caller
 *    cannot describe less than the write does. `describeRecordWrite` writes the sentences; a UI
 *    that uses it cannot leave one out.
 * 5. **Write**, through the existing primitive, which keeps every guard it already had: record
 *    size, slot range, and the storage version checked against a record the device itself produced.
 * 6. **Verify.** Read back and byte-compare. A device that stored the bytes and a device that
 *    ignored the message look identical from the sending end, so this is the only proof there is.
 *
 * ## Two protocols, two functions, one rule set
 *
 * A dump write lands in the **active project** and a +Drive write lands in **storage**, and the
 * difference decides which steps apply:
 *
 * | | `safeWriteRecords` | `safeWriteFile` |
 * |---|---|---|
 * | destination | the loaded project, one slot | a stored file, whole |
 * | backup | **required** — it overwrites | none, and see below |
 * | re-fetch / moved | yes | n/a, the target must be empty |
 * | confirm | required | required |
 * | verify | byte-exact | byte-exact except the slot stamp |
 *
 * **The file path takes no backup hook, and that is the empty-slot rule doing the work.**
 * `refuseUnlessEmpty` will not write into an occupied slot, an unlisted one, or one it cannot prove
 * is empty — so there is nothing to copy. That exemption is written as exactly that reason: if the
 * empty-slot rule is ever relaxed, the missing backup hook becomes a hole, and `safewrite.test.ts`
 * pins the pair together so the relaxation cannot happen quietly.
 *
 * ## What is not verified on hardware yet
 *
 * The byte-exact comparison for records. A written patternKit *should* read back identical — the
 * slot index it carries is maintained by the librarian and is already correct in the image — but
 * the +Drive taught us that a device stamps its own idea of a container's slot at `+24`, and no
 * write has yet been read back through this path on an instrument. If a benign device-authored
 * field shows up, it will appear here as a named offset rather than as a mystery, which is the
 * point of reporting offsets instead of a verdict.
 */

import { type ImageLayout } from "../project/dn2image.js";
import { patternName } from "../sheet/naming.js";
import { buildMessage } from "../sysex/container.js";
import { PRODUCT_NAMES } from "../sysex/devices.js";
import { patternKitRecord } from "../project/dn2image.js";
import {
  type DeviceIo,
  type WriteOutcome,
  planChangedRecords,
  readBackRecords,
  writeChangedRecords,
} from "./deviceproject.js";
import { WriteCode, verifyWrite } from "./dumpwrite.js";
import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { type ChunkChecksum, refuseUnlessEmpty, writeStoredFile } from "./storagewrite.js";
import { type Entry } from "./storage.js";
import { type WritePermit } from "./writepermit.js";

/**
 * The permit, minted once, here, and never handed out.
 *
 * The single cast in the codebase that produces one — `writepermit.ts` explains why it has to be a
 * cast and what that does and does not guarantee. `safewrite.test.ts` fails if a second one appears
 * anywhere.
 */
const PERMIT = Object.freeze({}) as unknown as WritePermit;

/** Raised when a write is refused before anything reaches the wire. */
export class WriteRefusal extends Error {}

/** A replayable copy of what was about to be overwritten. */
export interface Backup {
  /** A filename that says what it is, which device it came from, and when. */
  name: string;
  /** SysEx messages, ready to send straight back to the instrument. */
  bytes: Uint8Array;
  /** The slots it covers. */
  slots: number[];
}

/**
 * Receives the backup before the write.
 *
 * **Throwing aborts the write**, and that is the intended way to refuse: a UI that could not save
 * the file should stop the write rather than proceed without a copy.
 */
export type BackupHook = (backup: Backup) => void | Promise<void>;

/** Returns false to cancel. Handed structured facts, never a pre-written sentence. */
export type ConfirmHook<T> = (review: T) => boolean | Promise<boolean>;

/** One place a write did not land as sent. */
export interface Mismatch {
  label: string;
  /** First differing byte, when the record came back at all. */
  at?: number;
  reason: string;
}

// --- records: the active project ------------------------------------------------------------------

/** What a record write is about to do, as the confirmation is given it. */
export interface RecordWriteReview {
  deviceName: string;
  /** Slot numbers about to be overwritten. */
  slots: number[];
  /** Their names — `A01`, `B14`. */
  labels: string[];
  /**
   * Slots whose bytes on the device differ from the reading the edit was made against.
   *
   * Somebody has been playing. Writing replaces what is there **now**, not what was on screen.
   */
  moved: string[];
  /** Regions that changed and cannot be transmitted at all. */
  untransmittable: string[];
  /** Roughly what will go on the wire. */
  bytes: number;
}

export interface SafeRecordWriteOptions {
  productId: number;
  io: DeviceIo;
  /** The image as it came off the device — the diff baseline. */
  before: Uint8Array;
  /** The image after editing. */
  after: Uint8Array;
  layout: ImageLayout;
  /** A record the device produced, proving the storage version. */
  witness: Uint8Array;
  /** Required. Throw from it to abort. */
  onBackup: BackupHook;
  /** Required. Return false to cancel. */
  confirm: ConfirmHook<RecordWriteReview>;
  onStatus?: (message: string) => void;
  /** `stage` is `backup`, `write` or `verify`, so a bar can say which of the three it is drawing. */
  onProgress?: (done: number, total: number, stage: WriteStage) => void;
  limit?: number;
  /** Injected for tests; the clock the read-backs use. */
  timeoutMs?: number;
  now?: () => Date;
}

export type WriteStage = "backup" | "write" | "verify";

export interface SafeRecordWriteResult {
  cancelled: boolean;
  /** Records sent. */
  written: number;
  bytes: number;
  untransmittable: string[];
  /** Empty when every record read back byte-identical. */
  mismatches: Mismatch[];
  /** True only when every written record was read back **and** matched. */
  verified: boolean;
  /** Absent only when the write was cancelled before the backup was taken. */
  backup?: Backup;
  /** Slots that had changed on the device since the project was read. */
  moved: string[];
}

/**
 * Write the changed records, safely.
 *
 * Everything the manager and the expander send to an instrument goes through here.
 */
export async function safeWriteRecords(
  options: SafeRecordWriteOptions,
): Promise<SafeRecordWriteResult> {
  const { productId, io, before, after, layout, witness } = options;
  const status = options.onStatus ?? ((): void => {});
  const progress = options.onProgress ?? ((): void => {});
  const deviceName = PRODUCT_NAMES[productId] ?? `product 0x${productId.toString(16)}`;

  // Thrown rather than defaulted. A hook that is missing because a caller forgot is the case this
  // module exists for, and quietly writing without a backup is what it is here to make impossible.
  if (typeof options.onBackup !== "function") {
    throw new WriteRefusal("refusing to write without a backup hook");
  }
  if (typeof options.confirm !== "function") {
    throw new WriteRefusal("refusing to write without a confirmation hook");
  }

  const plan = planChangedRecords(before, after, layout, options.limit);
  if (plan.changed.length === 0) {
    return {
      cancelled: false,
      written: 0,
      bytes: 0,
      untransmittable: plan.untransmittable,
      mismatches: [],
      verified: true,
      moved: [],
    };
  }

  // Step 1 and 2. This is the backup and the staleness check at once — one read, two jobs, and they
  // have to be the same read or they could disagree about what is in the slot.
  status(`Reading ${plan.changed.length} destination pattern(s) back for a backup…`);
  const onDevice = await readBackRecords({
    productId,
    io,
    slots: plan.changed,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  progress(plan.changed.length, plan.changed.length, "backup");

  const missing = plan.changed.filter((slot) => !onDevice.has(slot));
  if (missing.length > 0) {
    throw new WriteRefusal(
      `no backup for ${missing.map(patternName).join(", ")} — the device did not answer for ` +
        `${missing.length} of the ${plan.changed.length} slot(s) about to be overwritten. A device ` +
        `that has gone quiet is exactly when a copy matters, so nothing was sent.`,
    );
  }

  const moved = plan.changed
    .filter((slot) => !sameRecord(onDevice.get(slot)!, before, slot, layout))
    .map(patternName);

  const review: RecordWriteReview = {
    deviceName,
    slots: plan.changed,
    labels: plan.changed.map(patternName),
    moved,
    untransmittable: plan.untransmittable,
    bytes: plan.changed.length * (layout.patternSize + layout.kitSize),
  };

  // Step 4 before step 3, deliberately: the backup hook downloads a file, and downloading one for a
  // write the user then cancels is rude. digi-roll settled on the same order for the same reason.
  if (!(await options.confirm(review))) {
    return {
      cancelled: true,
      written: 0,
      bytes: 0,
      untransmittable: plan.untransmittable,
      mismatches: [],
      verified: false,
      moved,
    };
  }

  const backup = buildRecordBackup(productId, deviceName, plan.changed, onDevice, options.now?.());
  await options.onBackup(backup);
  status(`Backup taken: ${backup.name}`);

  const outcome: WriteOutcome = await writeChangedRecords({
    productId,
    io,
    before,
    after,
    layout,
    witness,
    permit: PERMIT,
    onProgress: (done, total) => progress(done, total, "write"),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  // Step 6. Not folded into the write's own report: these are two operations and a single "ok"
  // covering both is how a partial success gets called a success.
  status("Verifying — reading the written patterns back…");
  const readBack = await readBackRecords({
    productId,
    io,
    slots: plan.changed,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  progress(plan.changed.length, plan.changed.length, "verify");

  const mismatches: Mismatch[] = [];
  for (const slot of plan.changed) {
    const label = patternName(slot);
    const got = readBack.get(slot);
    if (!got) {
      mismatches.push({ label, reason: "the device did not answer when asked for it back" });
      continue;
    }
    const verdict = verifyWrite(patternKitRecord(after, slot, layout), got);
    if (!verdict.ok) {
      mismatches.push({
        label,
        ...(verdict.at === undefined ? {} : { at: verdict.at }),
        reason: verdict.reason ?? "the bytes differ",
      });
    }
  }

  return {
    cancelled: false,
    written: outcome.written.length,
    bytes: outcome.bytes,
    untransmittable: outcome.untransmittable,
    mismatches,
    verified: mismatches.length === 0,
    backup,
    moved,
  };
}

function sameRecord(
  fromDevice: Uint8Array,
  image: Uint8Array,
  slot: number,
  layout: ImageLayout,
): boolean {
  const ours = patternKitRecord(image, slot, layout);
  if (ours.length !== fromDevice.length) return false;
  for (let i = 0; i < ours.length; i++) if (ours[i] !== fromDevice[i]) return false;
  return true;
}

/**
 * The re-fetched records as one replayable file.
 *
 * One file rather than one per slot: somebody restoring a botched write wants a single thing to
 * send back, and a folder of sixteen `.syx` files in the right order is not that. They concatenate
 * because SysEx messages are self-delimiting — `F0 … F7` — which is the same reason the probe's
 * captures are stored this way.
 */
export function buildRecordBackup(
  productId: number,
  deviceName: string,
  slots: readonly number[],
  records: ReadonlyMap<number, Uint8Array>,
  now: Date = new Date(),
): Backup {
  const messages = slots.map((slot) =>
    buildMessage({
      productId,
      dumpType: WriteCode.PatternKit,
      objNr: slot,
      payload: records.get(slot)!,
    }),
  );
  const total = messages.reduce((n, m) => n + m.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const message of messages) {
    bytes.set(message, at);
    at += message.length;
  }

  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const slug = deviceName.toLowerCase().replaceAll(" ", "-");
  return {
    name: `dnx-${slug}-prewrite-${stamp}.syx`,
    bytes,
    slots: [...slots],
  };
}

// --- files: the +Drive ----------------------------------------------------------------------------

/** What a file write is about to do. */
export interface FileWriteReview {
  /** The destination, e.g. `/kits/A/38`. */
  path: string;
  /** The name of the file being written, for a person who is not reading paths. */
  name: string;
  bytes: number;
  /** How many `0x58` messages it will take. More than one is refused by the device today. */
  chunks: number;
  /** The listing entry the empty-slot rule was checked against. */
  target: Entry;
}

export interface SafeFileWriteOptions {
  transport: ApiTransport;
  /** Where it goes. */
  path: string;
  /** What is being written, for the review — the source file's name, or a description. */
  name: string;
  bytes: Uint8Array;
  /** The destination's entry, **from a listing taken now**. See `refuseUnlessEmpty`. */
  target: Entry;
  /** Required. Return false to cancel. */
  confirm: ConfirmHook<FileWriteReview>;
  /**
   * Left to the caller, because the checksum question is still open and the probe page exists to
   * push on it. `undefined` is the answer that has ever worked.
   */
  checksum?: number | ChunkChecksum;
  chunkSize?: number;
  /** Message ids for the write, and separately for the verifying read. */
  msgId?: number;
  verifyMsgId?: number;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
  onProgress?: (done: number, total: number, stage: WriteStage) => void;
  /**
   * Skip the read-back.
   *
   * Only for the probe page's corruption experiment, where the write is *expected* to be refused
   * and a verifying read would report a failure that is the finding rather than a fault. Named
   * rather than inferred: nothing should be able to arrive at "do not check" by accident.
   */
  skipVerify?: boolean;
}

export interface SafeFileWriteResult {
  cancelled: boolean;
  written: number;
  chunks: number;
  /** The device acknowledged the commit. Nothing lands without this. */
  committed: boolean;
  /** Offsets that came back differently, with the device's own slot stamp already allowed for. */
  mismatches: Mismatch[];
  verified: boolean;
}

/**
 * The byte a Digitone II stamps itself.
 *
 * `/kits/A/1` written verbatim into `/kits/A/38` reads back differing in exactly one byte of
 * 10,795: container offset 24, `0x00` → `0x25`, which is 37 for slot 38. It is the container's own
 * zero-based slot index — the same idea as `slotIndexOffset` in a pattern record — and **the
 * instrument writes it**, so a byte-exact comparison has to expect it or call every correct write a
 * corruption. Measured 2026-08-13; see `storagewrite.ts`.
 */
export const CONTAINER_SLOT_OFFSET = 24;

/**
 * Write one file to the +Drive, safely.
 *
 * No backup hook, and that is `refuseUnlessEmpty` doing the work: the destination must be provably
 * empty in a listing taken now, so there is nothing there to copy. The two are a pair, checked as a
 * pair in `safewrite.test.ts`.
 */
export async function safeWriteFile(
  options: SafeFileWriteOptions,
): Promise<SafeFileWriteResult> {
  const { transport, path, bytes, target } = options;
  const status = options.onStatus ?? ((): void => {});
  const progress = options.onProgress ?? ((): void => {});

  if (typeof options.confirm !== "function") {
    throw new WriteRefusal("refusing to write without a confirmation hook");
  }

  // Checked here as well as inside `writeStoredFile`, and not as belt and braces: this is the step
  // that stands in for the backup, so it has to run **before the person is asked**. Being told
  // "this will overwrite Chords 3" after agreeing to a write is not consent.
  refuseUnlessEmpty(target, path);

  const chunkSize = options.chunkSize ?? bytes.length;
  const review: FileWriteReview = {
    path,
    name: options.name,
    bytes: bytes.length,
    chunks: Math.max(1, Math.ceil(bytes.length / chunkSize)),
    target,
  };
  if (!(await options.confirm(review))) {
    return { cancelled: true, written: 0, chunks: 0, committed: false, mismatches: [], verified: false };
  }

  const result = await writeStoredFile(path, bytes, options.checksum, {
    transport,
    target,
    permit: PERMIT,
    chunkSize,
    ...(options.msgId === undefined ? {} : { msgId: options.msgId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onProgress: (written, total) => progress(written, total, "write"),
  });

  if (options.skipVerify) {
    return { ...result, cancelled: false, mismatches: [], verified: false };
  }

  status(`Verifying — reading ${path} back…`);
  const readBack = await readStoredFile(path, {
    transport,
    ...(options.verifyMsgId === undefined ? {} : { msgId: options.verifyMsgId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onProgress: (_chunks, got) => progress(got, bytes.length, "verify"),
  });

  const mismatches = compareStored(bytes, readBack.bytes);
  return { ...result, cancelled: false, mismatches, verified: mismatches.length === 0 };
}

/**
 * Compare a stored file against what came back, allowing for the one byte the device owns.
 *
 * Reports the first difference and how many there are, rather than a verdict. A single unexpected
 * offset is a finding — it is how `+24` was identified in the first place — and a boolean would
 * throw that away.
 */
export function compareStored(sent: Uint8Array, readBack: Uint8Array): Mismatch[] {
  if (sent.length !== readBack.length) {
    return [
      {
        label: "length",
        reason: `sent ${sent.length.toLocaleString()} bytes, the device holds ` +
          `${readBack.length.toLocaleString()}`,
      },
    ];
  }

  const differing: number[] = [];
  for (let i = 0; i < sent.length; i++) {
    if (sent[i] === readBack[i]) continue;
    // The device's own slot index, and the only byte it is known to write for itself.
    if (i === CONTAINER_SLOT_OFFSET) continue;
    differing.push(i);
    if (differing.length >= 8) break;
  }
  if (differing.length === 0) return [];

  return [
    {
      label: "content",
      at: differing[0]!,
      reason:
        `${differing.length}${differing.length >= 8 ? "+" : ""} byte(s) differ, first at ` +
        `${differing[0]} — the device did not store what was sent`,
    },
  ];
}

// --- the sentences no confirmation may leave out --------------------------------------------------

/**
 * Every confirmation ends with this, so no dialog can imply the backup is optional.
 */
export const BACKUP_LINE =
  "A copy of every destination pattern is saved first — if that fails, nothing is sent.";

/**
 * What a record write does, in sentences.
 *
 * Shared rather than written per caller, because each line here is a way for somebody to be
 * surprised: work replaced that they made on the instrument after opening the project, or an edit
 * they think is going that cannot be sent at all. A path that drops one of them silently is the
 * bug this function exists to prevent.
 */
export function describeRecordWrite(review: RecordWriteReview): string[] {
  const lines: string[] = [];
  const n = review.slots.length;
  lines.push(
    `${n} pattern${n === 1 ? "" : "s"} on the ${review.deviceName} will be overwritten: ` +
      `${review.labels.join(", ")}.`,
  );

  if (review.moved.length > 0) {
    // The one that has to be said before the write rather than discovered after it.
    lines.push(
      `${review.moved.join(", ")} ${review.moved.length === 1 ? "has" : "have"} changed on the ` +
        `device since this project was read — someone has been playing. Writing replaces what is ` +
        `there now, not what is on screen.`,
    );
  }

  if (review.untransmittable.length > 0) {
    lines.push(`NOT sent: ${review.untransmittable.join("; ")}. Export to a file for those.`);
  }

  lines.push(
    "This reaches the active project, not the +Drive — press SAVE PROJECT on the instrument to " +
      "keep it.",
  );
  lines.push(BACKUP_LINE);
  return lines;
}

/** What a +Drive write does, in sentences. */
export function describeFileWrite(review: FileWriteReview): string[] {
  const lines = [
    `${review.name} — ${review.bytes.toLocaleString()} bytes — will be written to ${review.path}.`,
    `That slot is empty in a listing taken just now, and an occupied one is refused rather than ` +
      `overwritten. There is no undo on the instrument.`,
  ];
  if (review.chunks > 1) {
    lines.push(
      `This needs ${review.chunks} messages, and a Digitone II has refused every multi-message ` +
        `write tried so far. Expect it to fail.`,
    );
  }
  return lines;
}

/** The one-line report for a finished record write, worded the same wherever it is shown. */
export function recordWriteMessage(
  result: SafeRecordWriteResult,
): { text: string; level: "ok" | "warn" | "error" } {
  if (result.cancelled) return { text: "Write cancelled — nothing was sent.", level: "warn" };
  if (result.written === 0 && result.untransmittable.length === 0) {
    return { text: "Nothing to write — the device already holds this.", level: "ok" };
  }

  if (!result.verified) {
    const first = result.mismatches[0];
    return {
      text:
        `Write NOT verified: ${result.mismatches.length} pattern(s) did not read back as sent` +
        (first ? ` — ${first.label}: ${first.reason}` : "") +
        `. The backup ${result.backup?.name ?? ""} has what was there before; send it back to ` +
        `restore.`,
      level: "error",
    };
  }

  const parts = [
    `${result.written} pattern(s) written and verified byte-for-byte, ` +
      `${result.bytes.toLocaleString()} bytes.`,
    "Press SAVE PROJECT on the device to keep this — a write reaches the active project, not the " +
      "+Drive, so it survives a power cycle but is lost when another project is loaded.",
  ];
  if (result.untransmittable.length > 0) {
    parts.push(`NOT sent: ${result.untransmittable.join("; ")}. Export to a file for those.`);
  }
  return { text: parts.join(" "), level: result.untransmittable.length > 0 ? "warn" : "ok" };
}
