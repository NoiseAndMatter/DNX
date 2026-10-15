/**
 * Backing up a connected instrument's +Drive, for any page that can reach one.
 *
 * ## Why this is not in `manager/main.ts` any more
 *
 * It was, and so the control was the manager's alone: the settings sheet is shared by four pages,
 * but only the manager ever registered a runner, so on the library the *Back up the +Drive* button
 * sat disabled — beside an **Erase the wavetable region** button that worked. The owner found that
 * on 2026-10-14 and it reads as a page that will empty the region but not save it first, which is
 * the opposite of what DNX promises about destructive work.
 *
 * The library connects to an instrument and reads its +Drive all day, so there was nothing to
 * build: the job only ever needed the device and somewhere to say what it is doing. Both pages
 * now hand those in. See `shared-logic-lives-in-a-common-library`: the second caller is when it
 * moves, and this is the second caller.
 *
 * **It reads and never writes.** `backupDevice` opens each slot, reads it and closes it; the
 * write-enable switch is not involved because nothing is sent. That is the point of a backup
 * being the first thing a nervous person does.
 */

import { type ConnectedDevice } from "./devicesource.js";
import { saveFile, savedTone, whereSaved } from "./dnxfolder.js";
import { describeBytes } from "./progress.js";
import { type BackupRunner } from "./settings.js";
import { type StatusWriter } from "./statusbar.js";
import { backupDevice } from "./backup.js";
import { backupFileName, packBackup } from "./dnxfile.js";
import { claimDevice, deviceJobRefusal } from "./devicejob.js";

export interface BackupJobHost {
  /**
   * The instrument to read, asked for at the press.
   *
   * A function rather than a device, because the sheet can be opened before anything is connected
   * and the answer may be *ask the person which one* — which is the page's business, not this
   * module's. It may reject; the message is reported as the reason the backup stopped.
   */
  device(): Promise<ConnectedDevice>;
  status: StatusWriter;
}

/** The runner to hand `registerBackup`. */
export function backupJob(host: BackupJobHost): BackupRunner {
  return async (report) => {
    const release = claimDevice("A backup");
    if (!release) {
      report.say(deviceJobRefusal());
      host.status(deviceJobRefusal(), "warn");
      return;
    }
    try {
      report.say("Looking for an instrument…");
      const connected = await host.device();

      const { backup, failed } = await backupDevice(connected, {
        onList: () => report.say("Listing the +Drive…"),
        onProgress: ({ done, total, name, kind, bytes, stages }) => {
          report.at(stages);
          void total;
          report.say(
            name
              ? `${kind === "projects" ? "Project" : kind === "kits" ? "Kit" : "Sound"} ${name}` +
                `${bytes ? `, ${describeBytes(bytes)}` : ""}…`
              : `Packing ${done.toLocaleString()} items…`,
          );
        },
      });

      const bytes = await packBackup(backup);
      const name = backupFileName(backup.manifest);
      const saved = await saveFile(
        new Blob([bytes as BlobPart], { type: "application/zip" }),
        name,
        "backups",
      );

      const lost = failed.length
        ? ` ${failed.length} slot${failed.length === 1 ? "" : "s"} could not be read: ` +
          failed.map((f) => `${f.slot} ${f.name}`).join(", ") + "."
        : "";
      const kinds = backup.manifest.contents.join(", ");
      /*
       * **Said out loud rather than left to the manifest.** The drive is listed rather than
       * assumed, so a firmware adding a directory is discovered; but the reader handles three, and
       * a backup that passes over a fourth in silence reports success while being incomplete.
       * Nobody reads a manifest until they are restoring, which is the worst moment to find out.
       */
      const missed = backup.manifest.skipped ?? [];
      const unread = missed.length
        ? ` The +Drive also holds ${missed.join(", ")}, which DNX cannot read — this backup does ` +
          `not contain ${missed.length === 1 ? "it" : "them"}.`
        : "";
      report.say(
        `Saved ${whereSaved(saved)} — ${backup.manifest.entries.length} items (${kinds}), ` +
          `${describeBytes(bytes.length)}.${lost}${unread}`,
      );
      host.status(
        missed.length ? "Backup saved, but not everything on the +Drive" : `Backup saved to ${whereSaved(saved)}`,
        failed.length || missed.length ? "warn" : savedTone(saved),
      );
    } catch (error) {
      report.say(`Backup stopped: ${String(error)}`);
      host.status(`Backup stopped: ${String(error)}`, "error");
    } finally {
      release();
    }
  };
}
