/**
 * A device as a project source and sink, so the manager and the expander stop needing a file.
 *
 * **The point of this module is that nothing above it has to change.** `rearrange.ts`,
 * `trackmove.ts`, `rename.ts` and `convert.ts` all work on a decoded image and know nothing about
 * MIDI. This reads an image off an instrument and writes one back, so every one of them works on a
 * live device without being touched.
 *
 * ## Why an image, when §4a says live management does not need one
 *
 * Both are true, and the difference is where the saving happens.
 *
 * Reading gives us an image because that is what the rest of the codebase speaks, and reading is
 * cheap in the sense that matters: it is one request per record and the device is idle afterwards.
 *
 * **Writing is where an image would be ruinous** — 128 patternKits is 14.6 MB and minutes of
 * transfer, to change one slot. So `writeChangedRecords` diffs the image the user edited against
 * the image that came off the device, and sends **only the records that differ**. A pattern move
 * becomes two messages. A rename becomes one. The plan layer stays exactly as it is, and the wire
 * carries what actually changed rather than what happens to be in memory.
 *
 * That is the whole trick: **edit as an image, transmit as a diff.**
 *
 * ## What a device-sourced image is missing, and why it is still safe to edit
 *
 * A capture is 99.5% of an image (§3c-vi): the header, the tail before the pool, and everything
 * after the settings record — the song table and the slot array — never come over the wire, so
 * they are filled from a donor.
 *
 * That would matter if we wrote the image back wholesale. **We never do.** Only records that
 * differ are sent, the donor-supplied regions are byte-identical on both sides of the diff by
 * construction, and so they are never transmitted. The 0.49% is inert.
 *
 * ## Pacing, which is not optional
 *
 * Every send is followed by `settleMsAfter`. A request issued immediately behind a 114 KB write is
 * dropped by a device still ingesting it — found on hardware, where a write landed correctly and
 * the read-back that followed it got no reply at all. elk-herd has always paced its sends this
 * way; see `dumpwrite.ts`.
 */

import { type SysExMessage, parseMessage } from "../sysex/container.js";
import { ProductId } from "../sysex/devices.js";
import { patternName } from "../project/naming.js";
import { type ImageLayout } from "../project/dn2image.js";
import { kitRecord, patternKitRecord, patternRecord } from "../project/dn2image.js";
import {
  type RebuildPlan,
  applyRebuild,
  planRebuild,
} from "../project/rebuild.js";
import { DumpReader, type ReadReport } from "./dumpreader.js";
import { RESPONSE_SIZES, type ReadStep, planProjectRead } from "./readplan.js";
import { WriteCode, dumpWrite, settleMsAfter, storageVersion } from "./dumpwrite.js";
import { type SysexPort } from "./port.js";
import { type WritePermit } from "./writepermit.js";

/**
 * The transport, reduced to what this needs: a `SysexPort` without the closing.
 *
 * Written as the port's own methods rather than as a second shape, so any `SysexPort` is already a
 * `DeviceIo` and a host implements one interface rather than two. Closing is left out because
 * nothing here opened the port, and a read must not shut a conversation it does not own.
 *
 * Arriving messages used to be pushed in by the caller through an exported `deliver`, backed by a
 * module-level registry keyed on the `DeviceIo`. That is the module-level mutable state core is
 * not allowed to keep, and it could hold only one listener per port.
 */
export interface DeviceIo extends Omit<SysexPort, "close" | "ready"> {
  /** Injected so tests need no real clock. */
  wait?(ms: number): Promise<void>;
}

const realWait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReadProjectOptions {
  /** Dump-protocol product id — `0x0D` or `0x15`. */
  productId: number;
  io: DeviceIo;
  /**
   * A project of the same family, supplying the 0.49% no capture carries.
   *
   * Required, and the requirement is honest rather than incidental: without it there is no image,
   * only most of one. A device-authored blank is the right default — it contributes an *empty*
   * song table rather than another project's.
   */
  donor: Uint8Array;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface DeviceProject {
  image: Uint8Array;
  /** What arrived, so a caller can refuse to edit a project that did not read cleanly. */
  report: ReadReport;
  plan: RebuildPlan;
  /**
   * Records the device answered with, kept as the **witness** every later write is checked
   * against. `dumpwrite.ts` refuses a write whose storage version disagrees with a record the
   * device itself produced, and this is where those records come from.
   */
  witness: Map<number, Uint8Array>;
}

/** Read a whole project off a device and assemble it into an editable image. */
export async function readProjectFromDevice(options: ReadProjectOptions): Promise<DeviceProject> {
  const { productId, io, donor } = options;
  const received: Uint8Array[] = [];

  const reader = new DumpReader({
    productId,
    send: (bytes) => io.send(bytes),
    onProgress: (result, done, total) => options.onProgress?.(done, total, result.step.label),
  });

  const stop = io.subscribe((data) => {
    received.push(Uint8Array.from(data));
    reader.receive(data);
  });

  try {
    const report = await reader.run(planProjectRead(productId));
    const messages = parse(received);
    const plan = planRebuild(messages);
    const image = applyRebuild(donor, plan);

    const witness = new Map<number, Uint8Array>();
    for (const m of messages) {
      if (!witness.has(m.dumpType)) witness.set(m.dumpType, m.payload);
    }

    return { image, report, plan, witness };
  } finally {
    stop();
  }
}

export interface WriteChangedOptions {
  productId: number;
  io: DeviceIo;
  /** The image as it came off the device. */
  before: Uint8Array;
  /** The image after editing. */
  after: Uint8Array;
  layout: ImageLayout;
  /** A patternKit the device produced, proving the storage version we are writing. */
  witness: Uint8Array;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Refuse to send more than this many records without the caller saying so. */
  limit?: number;
  /**
   * Proof this write came through `safewrite.ts`.
   *
   * Not checked here, because there is nothing here that could check it — whether a backup was
   * taken and whether the person agreed are properties of a sequence, and this function is one step
   * of that sequence. The type is the check: `WritePermit` cannot be constructed outside the safe
   * path, so a caller that skipped it cannot call this at all.
   */
  permit: WritePermit;
}

export interface WrittenRecord {
  slot: number;
  label: string;
  bytes: number;
}

export interface WriteOutcome {
  written: WrittenRecord[];
  /** Total bytes put on the wire, framing included. */
  bytes: number;
  /**
   * True when the edit touched regions this cannot transmit — the header, the song table, the
   * slot array, the sound pool.
   *
   * Reported rather than silently dropped. An edit that changed a song and was told "3 patterns
   * written" would be a lie by omission, and songs are the one thing this project has always
   * refused to risk.
   */
  untransmittable: string[];
}

/**
 * The default ceiling on one operation.
 *
 * A manager move touches two slots and a batch move a handful. Anything approaching a whole
 * project is either a mistake or a transfer, and a transfer should say so explicitly rather than
 * arrive as a surprise 14.6 MB send.
 */
export const DEFAULT_WRITE_LIMIT = 16;

export class WriteTooLarge extends Error {}

/** What a write is about to do, worked out before a byte goes anywhere. */
export interface WritePlan {
  /** Pattern slots whose record differs between the two images. */
  changed: number[];
  /** Regions that differ and cannot be transmitted at all. */
  untransmittable: string[];
}

/**
 * Work out what would be sent, without sending it.
 *
 * Split out of `writeChangedRecords` because **the safe path needs this answer before the write,
 * not after it**: it is what the destination slots are read back from for a backup, and what the
 * confirmation names. Two separate diffs would be two chances to disagree about which slots the
 * user was warned about and which slots were actually overwritten.
 */
export function planChangedRecords(
  before: Uint8Array,
  after: Uint8Array,
  layout: ImageLayout,
  limit: number = DEFAULT_WRITE_LIMIT,
): WritePlan {
  if (before.length !== after.length || !layout.imageSizes.includes(before.length)) {
    throw new WriteTooLarge(
      `the two images are ${before.length} and ${after.length} bytes; this layout is ` +
        `${layout.imageSizes.join(" or ")}. Only two readings of the same project can be diffed.`,
    );
  }

  const changed: number[] = [];
  for (let slot = 0; slot < layout.patternCount; slot++) {
    if (
      differs(patternRecord(before, slot, layout), patternRecord(after, slot, layout)) ||
      differs(kitRecord(before, slot, layout), kitRecord(after, slot, layout))
    ) {
      changed.push(slot);
    }
  }

  if (changed.length > limit) {
    throw new WriteTooLarge(
      `${changed.length} patterns changed and the limit is ${limit}. That is a transfer rather ` +
        `than an edit — raise the limit deliberately, because at ${Math.round(
          (changed.length * 114) / 1024,
        )} MB it is minutes of transfer, not seconds.`,
    );
  }

  return { changed, untransmittable: elsewhere(before, after, layout) };
}

/**
 * Send only the records that changed.
 *
 * Diffing whole records rather than tracking edits is deliberate. It means this cannot disagree
 * with the librarian about what an operation did — whatever `rearrange` or `trackmove` produced,
 * the bytes are the bytes — and it works for an edit path that has not been written yet.
 *
 * **Reachable only through `safewrite.ts`.** This puts bytes on the wire that overwrite an
 * instrument, and it takes no backup and asks nobody. `WritePermit` is what makes that a compile
 * error rather than a habit; see `writepermit.ts`.
 */
export async function writeChangedRecords(options: WriteChangedOptions): Promise<WriteOutcome> {
  const { productId, io, before, after, layout, witness } = options;
  const wait = io.wait ?? realWait;

  const { changed, untransmittable } = planChangedRecords(before, after, layout, options.limit);

  const written: WrittenRecord[] = [];
  let bytes = 0;

  for (const slot of changed) {
    // The same assembly the verifier compares against — see `patternKitRecord`. Two derivations of
    // "what a slot's record is" would make a verified write and a corrupt one indistinguishable.
    const payload = patternKitRecord(after, slot, layout);

    const message = dumpWrite(productId, {
      code: WriteCode.PatternKit,
      objNr: slot,
      payload,
      witness,
    });

    io.send(message);
    bytes += message.length;
    written.push({ slot, label: patternName(slot), bytes: message.length });
    options.onProgress?.(written.length, changed.length, patternName(slot));

    // Not optional. See the module note: a device still ingesting a dump drops whatever comes next.
    await wait(settleMsAfter(message.length, productId));
  }

  return { written, bytes, untransmittable };
}

/**
 * Read whole patternKit records back off the device, by slot.
 *
 * Separate from the write on purpose. A device acknowledges nothing, so the write path cannot know
 * whether it succeeded, and a function that claimed to *write and verify* would be reporting one
 * outcome for two operations — which is how a partial success gets called a success.
 * `safeWriteRecords` calls this **twice**, and the two calls mean different things: before the
 * write it is the backup, after it is the proof.
 *
 * ## The size declared here is the patternKit's, not the pattern's
 *
 * `payloadBytes` is what `timeoutFor` sizes the wait from, and this asked for `layout.patternSize`
 * — the pattern half alone, 89,088 of the 99,840 bytes a Digitone II actually sends back. So every
 * read-back allowed 89% of the time it needed, and only the reader's slack covered the difference.
 *
 * It never bit because nothing called this function until the safe write path did. That is the
 * fifth fact this codebase had written down twice: `RESPONSE_SIZES[…].patternKit` and
 * `layout.patternSize + layout.kitSize` are the same number, and a test now pins them together.
 */
export async function readBackRecords(
  options: { productId: number; io: DeviceIo; slots: readonly number[]; timeoutMs?: number },
): Promise<Map<number, Uint8Array>> {
  const { productId, io, slots } = options;
  const wait = io.wait ?? realWait;
  const out = new Map<number, Uint8Array>();

  for (const slot of slots) {
    const step: ReadStep = {
      code: 0x60,
      objNr: slot,
      expect: 0x50,
      label: patternName(slot),
      payloadBytes: RESPONSE_SIZES[productId]?.patternKit ?? 0,
    };
    const reader = new DumpReader({
      productId,
      send: (bytes) => io.send(bytes),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const seen: Uint8Array[] = [];
    const stop = io.subscribe((data) => {
      seen.push(Uint8Array.from(data));
      reader.receive(data);
    });
    try {
      await reader.run([step]);
      const reply = parse(seen).find((m) => m.dumpType === 0x50 && m.objNr === slot);
      if (reply) out.set(slot, reply.payload);
    } finally {
      stop();
    }
    await wait(settleMsAfter(0, productId));
  }

  return out;
}

/** Storage version of a device's own patternKit, for a caller that wants to show it. */
export function deviceStorageVersion(witness: Uint8Array, layout: ImageLayout): number | undefined {
  // The kit half opens with BEEFBACE; the pattern half does not, on either family.
  return storageVersion(witness.subarray(layout.patternSize));
}

// --- plumbing ------------------------------------------------------------------------------------

function parse(raw: readonly Uint8Array[]): SysExMessage[] {
  const out: SysExMessage[] = [];
  for (const bytes of raw) {
    try {
      out.push(parseMessage(bytes));
    } catch {
      // Not a dump — clock, notes, someone else's traffic.
    }
  }
  return out;
}

function differs(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

/**
 * Regions that changed but cannot be sent, named.
 *
 * The honest half of "edit as an image, transmit as a diff": an image has parts the wire does not
 * carry, and an edit that touched them has to be told about rather than quietly dropped.
 */
function elsewhere(before: Uint8Array, after: Uint8Array, layout: ImageLayout): string[] {
  const out: string[] = [];
  if (differs(before.subarray(0, layout.headerSize), after.subarray(0, layout.headerSize))) {
    out.push("the image header — project name and identity, which no dump carries");
  }
  if (differs(before.subarray(layout.tailBase), after.subarray(layout.tailBase))) {
    out.push(
      "the tail — the sound pool, project settings, the slot array and the song table. Only some " +
        "of that is transmittable at all, and none of it by this function.",
    );
  }
  return out;
}

export { ProductId };
