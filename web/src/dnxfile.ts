/**
 * The `.dnx` backup format: everything about it that involves no instrument.
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
 * projects/001 PRESETS.dn2prj
 * projects/002 COREVAULT.dn2prj
 * ```
 *
 * ## The manifest is what makes a restore possible
 *
 * A `.dn2prj` does not know which slot it came from. The device addresses projects by index and
 * `/projects/PRESETS` is refused, so a folder of files alone cannot be put back. `manifest.json`
 * carries the slot for each entry, plus the instrument and firmware it came off, so a restore can
 * say what it is about to overwrite and refuse a backup taken from a different machine.
 *
 * ## Why this is a separate module from `backup.ts`
 *
 * `backup.ts` reaches Web MIDI through `devicesource.ts`, and importing that from a test drags
 * `MIDIInputMap` into the Node typecheck that runs over `test/`. `driveslot.ts` was split out of
 * `driveproject.ts` for the same reason, and `songview.ts` hit it with `grid.ts` before that.
 *
 * So the format lives here, where a test can read it with no browser types in sight, and the
 * device read lives next door.
 */

import { buildZip, type ZipEntry } from "./zip.js";
import { parsePayload } from "@noiseandmatter/dnx-core/project/container.js";
import { storedProjectEntries } from "@noiseandmatter/dnx-core/project/projectfile.js";
import { isDn1Payload } from "@noiseandmatter/dnx-core/device/drive.js";
import { type DeviceBackup } from "@noiseandmatter/dnx-core/project/dnxfile.js";

/*
 * The version, the manifest types and `backupFileName` moved to `src/project/dnxfile.ts`: they are
 * a shape, a number and a string, with no compression in them, so an Android host needs them as
 * much as this one does. Re-exported here under their old names, so every reader and writer of a
 * backup keeps the import it had.
 */
export {
  DNX_VERSION,
  backupFileName,
  type BackupEntry,
  type BackupManifest,
  type DeviceBackup,
} from "@noiseandmatter/dnx-core/project/dnxfile.js";

export function projectFile(name: string, firmwareVersion: string, payload: Uint8Array): Promise<Uint8Array> {
  return buildZip(storedProjectEntries(name, firmwareVersion, payload));
}

/** What a project file holding this payload is called: `.dnprj` for a Digitone 1, `.dn2prj` otherwise. */
export function projectExtensionFor(payload: Uint8Array): ".dnprj" | ".dn2prj" {
  return isDn1Payload(parsePayload(payload)) ? ".dnprj" : ".dn2prj";
}

/** Pack a backup into one `.dnx`. The manifest goes first, so a reader meets it before the data. */
export async function packBackup(backup: DeviceBackup): Promise<Uint8Array> {
  const manifest = new TextEncoder().encode(JSON.stringify(backup.manifest, undefined, 2));
  const entries: ZipEntry[] = [
    { name: "manifest.json", data: manifest },
    ...backup.files.map((f) => ({ name: f.path, data: f.bytes })),
  ];
  return buildZip(entries);
}
