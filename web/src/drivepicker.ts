/**
 * Picking a project off a +Drive: find the slot, read it, keep the page honest while it happens.
 *
 * ## Why this is one module and not three
 *
 * The library, the expander's source and the expander's destination each grew their own copy of
 * the same twenty lines: look the slot up in the listing we hold, refuse if that listing has gone
 * stale, start an indeterminate bar, repaint every few chunks, and stop the bar in a `finally`.
 * Three copies drifted in exactly the way copies do. The library repainted every 64 chunks and
 * showed a real bar once the length was known; the expander repainted every 8 and never showed
 * one, although it reads the same files through the same function.
 *
 * ## `working`, not a percentage, until the file says otherwise
 *
 * A +Drive listing reports a **flat allocation**, 4 MiB on a Digitone 1 and 16 MiB on a Digitone
 * II, rather than the size of the file in the slot. So there is no honest denominator at the
 * start, and `working()` is the truthful thing to draw. The container header carries the real
 * length, which arrives with the first chunk, and from then on a real bar is honest. See
 * `progress.ts`, which is where that distinction is argued.
 *
 * The bar is stopped in a `finally`, so a read that throws does not leave a page sweeping a bar
 * over work that has stopped.
 */

import {
  type ConnectedDevice,
  DeviceSourceError,
  type DriveProjectHandle,
  openDeviceProject,
} from "./devicesource.js";
import { type DriveProject } from "@noiseandmatter/dnx-core/device/drive.js";
import { type Progress, describeBytes } from "./progress.js";

/** What a page lends this while a read is running. */
export interface DriveReadHooks {
  onStatus: (message: string) => void;
  progress: Progress;
  /**
   * Repaint every this many chunks. Defaults to 32.
   *
   * A project is thousands of chunks, and repainting on each one is how a 114 KB read once
   * blocked the main thread; the three call sites had picked 8 and 64 by hand.
   */
  every?: number;
}

/**
 * The project a listing says is in that slot.
 *
 * **Throws when the listing does not have it**, which means the instrument was swapped or the
 * page has been sitting on an old answer. Reading whatever is in that slot now would be the
 * wrong file with the right number.
 */
export function projectInSlot(
  projects: readonly DriveProject[] | undefined,
  index: number,
): DriveProject {
  const project = projects?.find((p) => p.index === index);
  if (!project) throw new DeviceSourceError("browse the +Drive again — that listing is stale");
  return project;
}

/** Read one stored project, reporting progress the way the page asked for. */
export async function readDriveSlot(
  device: ConnectedDevice,
  project: DriveProject,
  hooks: DriveReadHooks,
): Promise<DriveProjectHandle> {
  const every = hooks.every ?? 32;
  const label = `Reading ${project.name}`;

  hooks.onStatus(`${label} from slot ${project.index}…`);
  hooks.progress.working(label);
  try {
    return await openDeviceProject(device, project, (chunks, bytes, total) => {
      if (chunks % every !== 0) return;
      if (total) hooks.progress.at(bytes, total, label);
      else hooks.progress.working(label);
      hooks.onStatus(
        `${label}: ${describeBytes(bytes)}${total ? ` of ${describeBytes(total)}` : ""}…`,
      );
    });
  } finally {
    hooks.progress.done();
  }
}
