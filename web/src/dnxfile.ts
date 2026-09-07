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
import type { ProjectManifest } from "../../src/project/container.js";

/** The format this file writes. Bumped when a reader would get it wrong, never for new fields. */
export const DNX_VERSION = 1;

/** One file inside the backup, and where it came from. */
export interface BackupEntry {
  /** Path inside the zip. */
  file: string;
  /** The +Drive path it was read from, which is what a restore writes back to. */
  source: string;
  /** Project slot, 1-based, as the instrument numbers them. */
  slot: number;
  name: string;
  bytes: number;
}

export interface BackupManifest {
  dnx: number;
  /** When the read finished, ISO 8601. */
  taken: string;
  device: {
    name: string;
    productId: number;
    /**
     * The instrument's own firmware string, **absent when it did not answer**.
     *
     * Left absent rather than filled in. A manifest claiming a firmware nobody read is exactly the
     * plausible-looking wrong field this codebase keeps paying for, and a restore that refuses on a
     * firmware mismatch has to be able to tell "different" from "unknown".
     */
    firmwareVersion?: string;
  };
  /**
   * Which kinds of thing were read.
   *
   * **Present so a restore can tell what is missing.** A backup with no `soundbanks` entry is one
   * that never read them; a reader that inferred this from an empty folder could not tell that
   * apart from an instrument with no sounds.
   */
  contents: string[];
  /**
   * The form every file was read in.
   *
   * Recorded because a raw-form backup cannot be restored, and a restore should say so plainly
   * rather than failing at the write.
   */
  form: "stored";
  entries: BackupEntry[];
}

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

export interface DeviceBackup {
  manifest: BackupManifest;
  /** Every file read, in manifest order, so a caller can zip them or save them loose. */
  files: { path: string; bytes: Uint8Array }[];
}

/** A file name that survives a zip, a file system and a round trip through either. */
function safeName(slot: number, name: string): string {
  const trimmed = name.replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|]/g, "-").trim();
  // The slot leads, because it is what addresses the project and what the instrument's own screen
  // shows. Two projects on one +Drive may share a name; two cannot share a slot.
  return `projects/${String(slot).padStart(3, "0")} ${trimmed || "UNNAMED"}.dn2prj`;
}

/**
 * Wrap a stored payload into a real `.dn2prj`.
 *
 * **The device sends a payload, not a file.** A `.dn2prj` is itself a zip holding `manifest.json`
 * and the payload, and the +Drive read returns only the second. The first backup written here
 * saved the payload under a `.dn2prj` name and **not one of the eighteen files parsed** — the same
 * mistake `safewrite.ts` records from 2026-08-15, in the other direction: a name the bytes had no
 * right to.
 *
 * **Nothing here is invented.** Every field is either read off the instrument or constant across
 * all 26 DN2 projects in the corpus:
 *
 * | field | where it comes from |
 * |---|---|
 * | `FormatVersion` | `"1.0"` in all 26 |
 * | `ProductType` | `[]` in all 26. DN1 files list `["24","30"]`; DN2 files list nothing |
 * | `FileType` | `"Project"` in all 26 |
 * | `Payload` | the project name, which the +Drive listing gives |
 * | `FirmwareVersion` | the instrument's own answer |
 *
 * `firmwareVersion` is required rather than optional for exactly that reason. A caller whose device
 * did not answer has nothing honest to write here, and `backupDevice` keeps the bare payload
 * instead of guessing.
 */
export function projectFile(name: string, firmwareVersion: string, payload: Uint8Array): Promise<Uint8Array> {
  const manifest: ProjectManifest = {
    FormatVersion: "1.0",
    ProductType: [],
    Payload: name,
    FileType: "Project",
    FirmwareVersion: firmwareVersion,
  };
  return buildZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, undefined, 2)) },
    { name, data: payload },
  ]);
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

/** A name that says what it holds and when, and sorts by date in a folder. */
export function backupFileName(manifest: BackupManifest): string {
  const stamp = manifest.taken.replace(/[:T]/g, "-").replace(/\..*$/, "");
  const device = manifest.device.name.replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|]/g, "-");
  return `${device} ${stamp}.dnx`;
}
