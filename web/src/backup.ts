/**
 * Reading a whole instrument into a `.dnx`.
 *
 * The format itself, and everything about it that needs no instrument, is in `dnxfile.ts`. This is
 * the half that talks to a device.
 *
 * ## What a `.dnx` is
 *
 * A zip. Rename it and every file inside opens in DNX, in Elektron Transfer, or in anything that
 * reads a zip. That is deliberate: a backup format nobody but its author can open is a way of
 * losing music slowly, and this one degrades into a folder of ordinary `.dn2prj` files the moment
 * somebody needs it to.
 *
 * ```
 * manifest.json          what was read, from which instrument, and where each file belongs
 * projects/01 PRESETS.dn2prj
 * projects/02 COREVAULT.dn2prj
 * ...
 * ```
 *
 * ## The manifest is what makes a restore possible
 *
 * A `.dn2prj` does not know which slot it came from. The device addresses projects by index and
 * `/projects/PRESETS` is refused, so a folder of files alone cannot be put back. `manifest.json`
 * carries the slot for each entry, plus the instrument and firmware it came off, so a restore can
 * say what it is about to overwrite and refuse a backup taken from a different machine.
 *
 * ## Stored form, and why a raw backup is not a backup
 *
 * Every read here asks for `STORED_FORM`. The device answers the same path two ways: the stored
 * payload, or the expanded image. **Only the stored form can be written back** — `refuseRawForm`
 * rejects the other at the door.
 *
 * This is not a precaution against a hypothetical. The first overwrite run on hardware, 2026-08-15,
 * backed up a slot in raw form: 12.9 MB, no container header, saved under a `.dn2prj` name it had
 * no right to, and unwritable by the very function that produced it.
 *
 * It is also the difference between a backup that takes minutes and one that takes an hour. A DN2
 * project is **12,889,647 bytes raw and about 90 KB stored**, 6,294 chunks against roughly 40.
 *
 * ## Empty slots are skipped, and that is load-bearing
 *
 * A +Drive has 128 project slots. The instrument this was built against uses 18. Reading all 128
 * would spend most of an hour on slots holding nothing.
 *
 * ## What is not here yet
 *
 * **Soundbanks.** Eight banks of 256 sounds are listed by `/soundbanks/A`, but opening one sound
 * needs a path form nobody has tested, and `0x54` is the message that froze a Digitone 1 three
 * times. One experiment settles it. The manifest carries a `contents` list so a later backup can
 * add banks without changing the format, and so a restore can tell a project-only backup from a
 * whole one rather than guessing from what happens to be inside.
 */

import { STORED_FORM } from "../../src/device/storage.js";
import { fileLengthFromHead } from "../../src/project/container.js";
import { readStoredFile } from "../../src/device/storagesession.js";
import type { DriveProject } from "../../src/device/drive.js";
import { projectPath } from "./driveslot.js";
import { apiTransport, listDeviceProjects, type ConnectedDevice } from "./devicesource.js";
import { IDS_FOR, reserveMessageIds } from "./messageids.js";
import {
  DNX_VERSION, projectFile, type BackupEntry, type DeviceBackup,
} from "./dnxfile.js";

export class BackupError extends Error {}

/** How a slot read reports itself while it runs. */
export interface BackupProgress {
  /** Slots finished, out of `total`. */
  done: number;
  total: number;
  /** The slot being read now. */
  name: string;
  bytes: number;
}

export interface BackupOptions {
  /** Which slots to read. Omitted means every occupied one. */
  slots?: readonly number[];
  onProgress?: (progress: BackupProgress) => void;
  /** Cooperative cancellation, checked between slots rather than mid-file. */
  shouldStop?: () => boolean;
}

/** A file name that survives a zip, a file system and a round trip through either. */
function safeName(slot: number, name: string, extension: string): string {
  const trimmed = name.replace(/[^ -~]/g, "").replace(/[\/:*?"<>|]/g, "-").trim();
  // The slot leads, because it is what addresses the project and what the instrument's own screen
  // shows. Two projects on one +Drive may share a name; two cannot share a slot.
  return `projects/${String(slot).padStart(3, "0")} ${trimmed || "UNNAMED"}${extension}`;
}

/**
 * Read every occupied project slot off an instrument.
 *
 * Slots that fail are **reported and skipped**, never silently dropped: a backup missing one
 * project is worth having, and a backup that quietly lost one is not.
 */
export async function backupDevice(
  device: ConnectedDevice,
  options: BackupOptions = {},
): Promise<{ backup: DeviceBackup; failed: { slot: number; name: string; why: string }[] }> {
  const listed = await listDeviceProjects(device);
  const occupied = listed.filter((p) => p.name.trim().length > 0);
  const wanted = options.slots
    ? occupied.filter((p) => options.slots!.includes(p.index))
    : occupied;

  if (wanted.length === 0) {
    throw new BackupError(
      listed.length === 0
        ? "The +Drive listing came back empty, so there is nothing to back up."
        : "Every slot on this +Drive is empty. There is nothing to back up.",
    );
  }

  const transport = apiTransport(device);
  const files: { path: string; bytes: Uint8Array }[] = [];
  const entries: BackupEntry[] = [];
  const failed: { slot: number; name: string; why: string }[] = [];

  for (const [at, project] of wanted.entries()) {
    if (options.shouldStop?.()) break;
    options.onProgress?.({ done: at, total: wanted.length, name: project.name, bytes: 0 });

    const source = projectPath(project.index);
    try {
      const read = await readStoredFile(source, {
        transport,
        // The whole reason this is minutes rather than an hour, and the only form a write accepts.
        form: STORED_FORM,
        msgId: reserveMessageIds(IDS_FOR.wholeProject),
        totalFromHead: fileLengthFromHead,
        onProgress: (_chunks, bytes, total) => {
          options.onProgress?.({ done: at, total: wanted.length, name: project.name, bytes });
          void total;
        },
      });
      /*
       * **Wrapped into a real `.dn2prj`, or named for what it is.**
       *
       * The device sends a payload; a `.dn2prj` is that payload inside a container. The first
       * backup this wrote saved payloads under a `.dn2prj` name and not one of the eighteen files
       * parsed. Wrapping needs the instrument's firmware, which it may not have answered — and
       * with no firmware there is nothing honest to put in the container, so the payload is kept
       * under a name that does not claim to be a project file.
       */
      const wrap = device.firmwareVersion;
      const file = safeName(project.index, project.name, wrap ? ".dn2prj" : ".payload");
      const bytes = wrap
        ? await projectFile(project.name, wrap, read.bytes)
        : read.bytes;
      files.push({ path: file, bytes });
      entries.push({
        file,
        source,
        slot: project.index,
        name: project.name,
        bytes: bytes.length,
      });
    } catch (error) {
      failed.push({ slot: project.index, name: project.name, why: String(error) });
    }
  }

  options.onProgress?.({ done: entries.length, total: wanted.length, name: "", bytes: 0 });

  return {
    backup: {
      manifest: {
        dnx: DNX_VERSION,
        taken: new Date().toISOString(),
        device: {
          name: device.name,
          productId: device.productId,
          ...(device.firmwareVersion === undefined ? {} : { firmwareVersion: device.firmwareVersion }),
        },
        contents: ["projects"],
        form: "stored",
        entries,
      },
      files,
    },
    failed,
  };
}
