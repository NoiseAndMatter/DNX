/**
 * The browser half of the safe write path: the question, and the backup file.
 *
 * `src/device/safewrite.ts` decides what a write is allowed to do; this decides what it looks like.
 * Both halves are shared rather than written per page for the same reason: the manager and the
 * expander send the same records to the same instrument through the same function, and a dialog
 * that says less on one page than the other is a page where somebody agrees to something they were
 * not told about.
 *
 * ## The backup is a download, and a download can be refused
 *
 * `saveBlob` hands the browser an anchor and hopes. A blocked or cancelled download does not throw,
 * so this cannot promise the file reached the disk — only that it was offered. That is worth being
 * plain about rather than papering over: the status line says the name, so somebody who did not get
 * the file knows to look for it before trusting the write.
 *
 * digi-roll solves the same problem by also stashing the backup inside the browser, so its console
 * can restore without a file at all. Worth having here too, and not in this change: a stash is a
 * storage question — where it lives, how much of it is kept, when it is thrown away — and folding
 * it into the write path would be answering it by accident.
 */

import {
  type Backup,
  type BackupHook,
  type ConfirmHook,
  type FileWriteReview,
  type RecordWriteReview,
  type WriteStage,
  describeFileWrite,
  describeRecordWrite,
} from "../../src/device/safewrite.js";
import { askConfirm } from "./dialog.js";
import { saveBlob } from "./dom.js";
import { projectFile } from "./dnxfile.js";

/**
 * What the bar says during each pass of a safe write.
 *
 * Here rather than beside either caller. A safe write is three passes over the wire — read, write,
 * read — and on a bar that only counts they are indistinguishable; the backup pass in particular
 * runs *before* anything has been sent, which is the one somebody most needs to be able to tell
 * apart. Two pages showing different words for the same pass would be a small lie told twice.
 */
export const STAGE_LABEL: Record<WriteStage, string> = {
  backup: "Backing up",
  write: "Writing",
  verify: "Verifying",
};

/**
 * Offer the backup as a download.
 *
 * `onStatus` is called with the filename because that is the only evidence the user has that a
 * backup exists at all — see the note above about what a download can and cannot promise.
 *
 * `what` names the thing copied, because the two callers back up genuinely different objects and
 * the count alone cannot tell them apart: a whole project and a single pattern both arrive as one
 * slot, and "Backup of 1 pattern(s)" would be a plain untruth in front of a 250 KB project file.
 */
export function downloadBackup(
  onStatus: (message: string) => void,
  what: (backup: Backup) => string = (b) => `${b.slots.length} pattern(s)`,
  /**
   * The instrument's own firmware string, when it answered.
   *
   * Only used to wrap a `storedFile` copy into a real project file. **Absent means absent**: with
   * no firmware there is nothing honest to put in the manifest, so the payload is saved as a
   * payload rather than under a name it has no right to. The same rule `backupDevice` follows.
   */
  firmwareVersion?: string,
): BackupHook {
  return async (backup: Backup): Promise<void> => {
    /*
     * **A copy that opens in nothing is not a copy.** The bytes of a `storedFile` backup are one
     * +Drive file's payload, and a project file is that payload inside a zip beside a manifest.
     * Saved bare it opens in neither DNX nor Transfer — and this is the copy the confirmation
     * calls the only undo there is.
     *
     * Found on 2026-09-08 by opening one: 293,332 bytes starting `ac11d303`, the Elektron object
     * magic, where a project file starts `PK`.
     */
    const wrap = backup.kind === "storedFile" && firmwareVersion !== undefined;
    const name = wrap ? backup.name.replace(/\.payload$/, ".dn2prj") : backup.name;
    const bytes = wrap
      // The payload's own name inside the container. `projectFile` puts it in the manifest, which
      // is how a reader finds it again.
      ? await projectFile(backup.name.replace(/-before-.*$/, ""), firmwareVersion, backup.bytes)
      : backup.bytes;

    saveBlob(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), name);
    onStatus(`Backup of ${what(backup)} saved as ${name}`);
  };
}

/**
 * Ask before overwriting patterns on the instrument.
 *
 * `danger`, so the affirmative button is marked and focus starts on Cancel. The slot names go in
 * `list` rather than the body: a sixteen-slot write is something you scan, and `dialog.ts` lets a
 * long list scroll while the question and the buttons stay put.
 */
export const confirmRecordWrite: ConfirmHook<RecordWriteReview> = (review) =>
  askConfirm({
    title: `Write ${review.slots.length} pattern${review.slots.length === 1 ? "" : "s"} to the ${review.deviceName}?`,
    body: describeRecordWrite(review),
    list: review.labels,
    confirmLabel: "Write to the device",
    danger: true,
  });

/** Ask before writing a file to the +Drive. */
export const confirmFileWrite: ConfirmHook<FileWriteReview> = (review) =>
  askConfirm({
    // The question itself changes, not just the small print. "Write SONGWORK to /projects/6?" and
    // "Replace MORNING JAM in /projects/6?" are answered differently by the same person.
    title:
      review.replacing === undefined
        ? `Write ${review.name} to ${review.path}?`
        : `Replace ${review.replacing} with ${review.name}?`,
    body: describeFileWrite(review),
    confirmLabel: review.replacing === undefined ? "Write to the +Drive" : "Replace it",
    danger: true,
  });
