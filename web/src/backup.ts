/**
 * Reading an instrument's whole +Drive, from a browser.
 *
 * The work is `src/device/backup.ts` now, which needs two things this page owns: the one message
 * id allocator every conversation on this port shares, and a way to wrap a project payload into a
 * real project file, which is a zip and therefore a compression codec. Both are passed in, so the
 * same backup runs on a host that has neither Web MIDI nor `CompressionStream`.
 *
 * Everything is re-exported under its old name, so the manager's import did not change.
 */

import { backupDevice as readBackup, type BackupHost } from "../../src/device/backup.js";
import { type ConnectedDevice } from "./devicesource.js";
import { type BackupOptions } from "../../src/device/backup.js";
import { type DeviceBackup } from "../../src/project/dnxfile.js";
import { projectFile } from "./dnxfile.js";
import { pageMessageIds } from "./messageids.js";

export {
  BackupError,
  type BackupOptions,
  type BackupProgress,
  type BackupStage,
} from "../../src/device/backup.js";

/**
 * This page's host services, as one object.
 *
 * The page's own allocator, not one of this module's, because a second allocator on one port is
 * the collision `messageids.ts` exists to prevent.
 */
const host: BackupHost = { ids: pageMessageIds, wrapProject: projectFile };

/** Read every occupied slot off an instrument, into one `.dnx`'s worth of files. */
export function backupDevice(
  device: ConnectedDevice,
  options: BackupOptions = {},
): Promise<{ backup: DeviceBackup; failed: { slot: number; name: string; why: string }[] }> {
  return readBackup(device, host, options);
}
