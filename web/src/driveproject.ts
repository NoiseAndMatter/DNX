/**
 * Writing a whole project to a +Drive slot.
 *
 * ## Why this exists at all
 *
 * A song lives in the image **tail**, and the tail is not transmittable: `writeChangedRecords` sends
 * pattern records and reports everything else as `untransmittable`. So the manager's existing write
 * — dump records into the *active* project — can never carry a song edit. The only route is to write
 * the whole project as a file into a +Drive slot, which the chunk-numbering and stored-form fixes
 * made possible.
 *
 * That gives the manager two write destinations with genuinely different meanings, and the UI must
 * not blur them:
 *
 * | edit | goes to | by |
 * |---|---|---|
 * | patterns, kits | the **active** project | dump records, `safeWriteRecords` |
 * | songs, or anything wholesale | a **stored** slot | this |
 *
 * ## What is actually new here, and what is not
 *
 * It is tempting to say this is the first time an instrument has been asked to read a payload **we**
 * compressed. **It is not.** `99_HardwareTest/` holds projects that are byte-identical to what
 * `buildPayload` produces — `CLAUDE_TEST`, `GLITCH_EXPLORE_EXPANDED`, `HWTEST_BASE_1629` and others
 * — and those are the files loaded onto the instrument for the expander and rearrange hardware
 * tests. The device has read our LZ4 repeatedly and played what came out.
 *
 * So the compression is **not** the risk. What is new is only the **transport**: the same payload
 * that reached the device through Elektron Transfer now goes over SysEx as a +Drive write. Every
 * earlier +Drive write sent bytes that had been read off the same device minutes before; this sends
 * bytes DNX assembled. That is a smaller gap than it first looked, and worth stating precisely
 * rather than dramatically.
 *
 * ## Verification compares images, not bytes
 *
 * `lz4encode.ts` says it plainly: LZ4 is a deterministic *format* and not a deterministic
 * *encoding*, so a rebuilt payload usually differs from the original while decoding to exactly the
 * same image. Ours is not even consistently larger — `HWTRK 1430-T5` is 109,907 bytes from Elektron
 * and 106,022 from us.
 *
 * A byte comparison would therefore fail on a correct write, which is the sort of false alarm that
 * teaches people to ignore a check. So the read-back is **decoded** and the images compared.
 *
 * ## Empty slots, and the one slot that is not
 *
 * `refuseUnlessEmpty` is relaxed in exactly one case: **the slot this project was opened from.**
 * Everything else is still refused, because for most people the +Drive is the only copy of that
 * work and there is no undo on the instrument.
 *
 * That case is not a special favour, it is the ordinary one. Open a project off the instrument, edit
 * a song, save — anything else is "save a copy", and a tool that could only ever do that leaves the
 * user to delete the original from the front panel and rename the copy. The restriction was written
 * to hold *until writing was proven*, and it now is: a project committed and read back at one chunk
 * (slot 13) and at three (slot 14), 2026-08-14.
 *
 * What replaces the rule is `overwrite`'s own condition — **a backup, taken off the device and
 * handed to the caller before a byte is sent.** `safeWriteFile` refuses the flag without a hook. So
 * the copy that the empty-slot rule used to make unnecessary is now simply made.
 */

import { type ConnectedDevice, apiTransport } from "./devicesource.js";
import { firstDifference, projectPath } from "./driveslot.js";

export { firstDifference, projectPath };
import {
  type Entry, type Listing, ShortListingError, listRequest, parseListing,
} from "../../src/device/storage.js";
import { IDS_FOR, reserveMessageIds } from "./messageids.js";
import { decodeProjectImage } from "../../src/project/dn2codec.js";
import { type BackupHook, safeWriteFile } from "../../src/device/safewrite.js";
import { confirmFileWrite } from "./safewriteui.js";
import { STORED_FORM } from "../../src/device/storage.js";
import { readStoredFile } from "../../src/device/storagesession.js";

export class DriveWriteError extends Error {}

/**
 * The destination's listing entry, **taken now**.
 *
 * Not cached and not passed in. `refuseUnlessEmpty` refuses an entry that did not come from a
 * listing, and an entry from ten minutes ago is not evidence about what is in a slot at the moment
 * of writing — somebody may have saved to it from the instrument's front panel since.
 */
export async function entryForSlot(device: ConnectedDevice, slot: number): Promise<Entry> {
  const transport = apiTransport(device);
  const id = reserveMessageIds(IDS_FOR.oneMessage);
  const reply = await transport.request(listRequest(id, "/projects"), id, 10_000);
  const entry = wholeListing(reply.body, "/projects").entries.find((e) => e.index === slot);
  if (!entry) {
    throw new DriveWriteError(
      `slot ${slot} is not in the +Drive's project listing, so there is nothing to check before ` +
        `writing to it`,
    );
  }
  return entry;
}

export interface WriteProjectResult {
  slot: number;
  cancelled: boolean;
  /** Bytes of payload sent. */
  written: number;
  chunks: number;
  committed: boolean;
  /**
   * True when the project read back decodes to the image that was sent.
   *
   * **Images, not bytes.** See the module note: our compression differs from Elektron's, so a
   * byte comparison would fail on a correct write.
   */
  verified: boolean;
  /** Why not, when `verified` is false. */
  problem?: string;
}

export interface WriteProjectOptions {
  device: ConnectedDevice;
  slot: number;
  /** The compressed payload, as `buildPayload` produces and a `.dn2prj` carries. */
  payload: Uint8Array;
  /** The decoded image the payload should reconstitute — the thing actually being checked. */
  image: Uint8Array;
  name: string;
  /**
   * Replace what is in the slot.
   *
   * Set only for the slot the open project came from — see the module note. Requires `onBackup`,
   * and `safeWriteFile` refuses it without one.
   */
  overwrite?: boolean;
  /** Handed the slot's current contents before the write. **Required with `overwrite`.** */
  onBackup?: BackupHook;
  onStatus?: (message: string) => void;
  onProgress?: (done: number, total: number, stage: "write" | "verify" | "backup") => void;
}

/**
 * Write a project into an empty +Drive slot, and prove it landed.
 *
 * Verification reads the slot back in its **stored** form and decodes it. That checks the whole
 * chain — our compression, the device's storage, the device's idea of the container — against the
 * one thing that matters: does the project come back as the project that was sent.
 */
export async function writeProjectToDrive(
  options: WriteProjectOptions,
): Promise<WriteProjectResult> {
  const { device, slot, payload, image, name } = options;
  const status = options.onStatus ?? ((): void => {});

  const target = await entryForSlot(device, slot);
  const transport = apiTransport(device);

  const result = await safeWriteFile({
    transport,
    path: projectPath(slot),
    name,
    bytes: payload,
    target,
    confirm: confirmFileWrite,
    ...(options.overwrite === true ? { overwrite: true } : {}),
    ...(options.onBackup === undefined ? {} : { onBackup: options.onBackup }),
    msgId: reserveMessageIds(IDS_FOR.wholeProject),
    verifyMsgId: reserveMessageIds(IDS_FOR.wholeProject),
    // A project is minutes of transfer, not seconds. The 5-second default is sized for a preset.
    timeoutMs: 120_000,
    // Byte verification is the wrong check here, so it is skipped and replaced below rather than
    // left to report a difference that means nothing.
    skipVerify: true,
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    // The stage is forwarded rather than flattened: with a backup in front of it, a bar that said
    // "writing" through a two-minute read of the old project would be describing the wrong thing.
    onProgress: (done, total, stage) => options.onProgress?.(done, total, stage),
  });

  if (result.cancelled) {
    return { slot, cancelled: true, written: 0, chunks: 0, committed: false, verified: false };
  }

  if (!result.committed) {
    return {
      slot,
      cancelled: false,
      written: result.written,
      chunks: result.chunks,
      committed: false,
      verified: false,
      problem: "the device did not acknowledge the commit, so nothing landed",
    };
  }

  status("Verifying — reading the project back off the +Drive…");
  const back = await readStoredForm(device, slot, (done) =>
    options.onProgress?.(done, payload.length, "verify"),
  );

  let decoded: Uint8Array;
  try {
    decoded = decodeProjectImage(back).image;
  } catch (error) {
    return {
      slot,
      cancelled: false,
      written: result.written,
      chunks: result.chunks,
      committed: true,
      verified: false,
      problem:
        `the slot read back but could not be decoded (${String(error)}). The device stored ` +
        `something; whether it is a usable project is exactly what this could not confirm.`,
    };
  }

  const at = firstDifference(decoded, image);
  return {
    slot,
    cancelled: false,
    written: result.written,
    chunks: result.chunks,
    committed: true,
    verified: at === undefined,
    ...(at === undefined
      ? {}
      : {
          problem:
            `the project read back decodes to a different image — first difference at byte ` +
            `${at.toLocaleString()} of ${image.length.toLocaleString()}`,
        }),
  };
}


/**
 * Read a stored file in its compressed form.
 *
 * `readDriveProject` asks for the raw uncompressed image, which is what the rest of DNX wants and
 * is 12.9 MB. For checking a write, the stored form is the same information in ~79 KB.
 *
 * **This used to be a private read loop, and it should never have been one.** It open/read/closed
 * by hand because `readStoredFile` could not ask for the stored form; the moment that gained a
 * `form` option the copy was simply a worse version of it — no retry on a dropped reply, no check
 * that the chunk index is the one asked for, and a `finally` that swallowed the close. On a link
 * that dropped replies at 199, 700 and 899 chunks in one evening, "no retry" is not a detail.
 */
async function readStoredForm(
  device: ConnectedDevice,
  slot: number,
  onProgress: (bytes: number) => void,
): Promise<Uint8Array> {
  const file = await readStoredFile(projectPath(slot), {
    transport: apiTransport(device),
    form: STORED_FORM,
    msgId: reserveMessageIds(IDS_FOR.wholeProject),
    timeoutMs: 20_000,
    onProgress: (_chunks, bytes) => onProgress(bytes),
  });
  return file.bytes;
}

/**
 * Slots with nothing in them, for a picker that should not offer to overwrite anything.
 *
 * Read from a **fresh listing** rather than from `DriveProject`, which carries a name and an
 * allocation but not occupancy — `listProjects` reports every slot, named or not. Occupancy is a
 * property of the directory entry, and the only place it is stated.
 */
/**
 * A listing, refused unless it is whole.
 *
 * **A partial +Drive listing must never be presented as the +Drive.** Slot numbers come from these
 * entries, and a project opened from the wrong slot is the mistake this whole subsystem is arranged
 * to prevent — so a page that carried 45 of a declared 128 is an error here, not a shorter list.
 *
 * The two causes look identical and both matter: a directory larger than one reply needs paging,
 * which this does not yet do; a reply crossed with another application's traffic needs that
 * application closed. The message names both, because the reader is the one who can tell.
 */
function wholeListing(body: Uint8Array, path: string): Listing {
  const listing = parseListing(body);
  if (!listing.complete) {
    throw new ShortListingError(
      `${path} answered with ${listing.entries.length} of the ${listing.declared} entries it ` +
        `declared. Either the directory needs more than one request — which this does not do yet — ` +
        `or the reply was not the answer to this request. Close any Elektron Transfer or ` +
        `Overbridge running on the same port and try again.`,
    );
  }
  return listing;
}

export async function emptyProjectSlots(device: ConnectedDevice): Promise<number[]> {
  const transport = apiTransport(device);
  const id = reserveMessageIds(IDS_FOR.oneMessage);
  const reply = await transport.request(listRequest(id, "/projects"), id, 10_000);
  return wholeListing(reply.body, "/projects")
    .entries.filter((e) => e.occupied === false)
    .map((e) => e.index);
}
