/**
 * Writing a whole project to a +Drive slot, from a browser.
 *
 * The work is `src/device/driveproject.ts` now. What stays here is the host's half of it: the
 * page's one message-id allocator, the confirmation dialog a person actually reads, and
 * `requireWriteEnabled`, the switch on this page.
 *
 * **The switch is passed in rather than assumed.** Core cannot know whether a host has one, so it
 * takes a `gate` it calls before a byte is sent. Wiring it here keeps consent where the person is,
 * and keeps the property `writeenable.test.ts` guards: no path reaches a write primitive without
 * the switch being checked first.
 *
 * Every name the manager and the library already imported is re-exported, so no call site changed.
 */

import {
  type DriveWriteHost,
  type WriteProjectOptions,
  type WriteProjectResult,
  entryForSlot as coreEntryForSlot,
  emptyProjectSlots as coreEmptySlots,
  projectSlotEntries as coreSlotEntries,
  writeProjectToDrive as coreWriteProject,
} from "@noiseandmatter/dnx-core/device/driveproject.js";
import { type ConnectedDevice } from "./devicesource.js";
import { type Entry } from "@noiseandmatter/dnx-core/device/storage.js";
import { confirmFileWrite } from "./safewriteui.js";
import { pageMessageIds } from "./messageids.js";
import { requireWriteEnabled } from "./writeenable.js";

export {
  DriveWriteError,
  firstDifference,
  projectPath,
  type WriteProjectResult,
} from "@noiseandmatter/dnx-core/device/driveproject.js";

/** This page's half: its allocator, its dialog, and its write switch. */
const host: DriveWriteHost = {
  ids: pageMessageIds,
  gate: requireWriteEnabled,
  confirm: confirmFileWrite,
};

/** The destination's listing entry, taken now. */
export function entryForSlot(device: ConnectedDevice, slot: number): Promise<Entry> {
  return coreEntryForSlot(device, pageMessageIds, slot);
}

/** Write a project into a +Drive slot, and prove it landed. */
export function writeProjectToDrive(
  options: Omit<WriteProjectOptions, "host">,
): Promise<WriteProjectResult> {
  return coreWriteProject({ ...options, host });
}

/** Every project slot's listing entry. */
export function projectSlotEntries(device: ConnectedDevice): Promise<Entry[]> {
  return coreSlotEntries(device, pageMessageIds);
}

/** The slots with nothing in them. */
export function emptyProjectSlots(device: ConnectedDevice): Promise<number[]> {
  return coreEmptySlots(device, pageMessageIds);
}
