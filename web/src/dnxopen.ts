/**
 * Reading a `.dnx` back: the first half of a restore.
 *
 * `dnxfile.ts` writes the format and `zip.ts` is the container. This is what turns a file somebody
 * picked off disk into something a restore can be built on, and it is deliberately the only place
 * that decides whether a backup is trustworthy.
 *
 * ## Why opening is its own module
 *
 * Writing a backup and reading one are different jobs with different failure modes. The writer
 * knows where every byte came from; the reader is handed a file by a person and has to establish
 * what it is. Putting both in `dnxfile.ts` would mean the writer's certainty and the reader's
 * suspicion sharing a file, and the reader's half is where a restore's safety lives.
 *
 * ## What is refused, and what is merely reported
 *
 * **Refused, because carrying on would write wrong bytes to an instrument:**
 *
 * | | |
 * |---|---|
 * | not a zip, or no `manifest.json` | it is not a backup |
 * | a manifest that is not the shape | the fields a restore reads are not there |
 * | `dnx` newer than this reader | a format we do not know, and guessing at one ends at a write |
 * | `form` other than `"stored"` | **a raw backup cannot be written back at all** |
 *
 * **Reported, because a damaged backup is still worth most of its contents:** an entry the manifest
 * lists and the zip does not, a file in the zip the manifest never mentioned, and a file whose
 * length disagrees with the manifest. Any of those makes *that* entry unusable. None of them says
 * anything about the other 1,868, and a reader who lost a whole backup over one bad slot would be
 * right to be angry.
 *
 * That split is the same rule `backupDevice` follows in the other direction: a slot that fails is
 * reported and skipped, never silently dropped.
 *
 * ## `source` is authoritative, not the path in the zip
 *
 * Both encode where a file belongs. Only `source` is what a restore writes back to, and the zip
 * path is a name chosen to be readable in a file browser. Where they could disagree, the one the
 * instrument will see is the one to believe.
 */

import { readZip, ZipError } from "./zip.js";
import { DNX_VERSION, type BackupEntry, type BackupManifest } from "./dnxfile.js";

/** A file that is not a backup this reader can be trusted with. */
export class DnxError extends Error {}

/** One entry the manifest lists and the zip holds. */
export interface OpenedEntry {
  entry: BackupEntry;
  bytes: Uint8Array;
  /**
   * The +Drive directory it belongs to: `projects`, `soundbanks` or `kits`.
   *
   * Read from `source` rather than assumed, so a firmware that adds a fourth arrives as its own
   * name instead of as one of these three.
   */
  kind: string;
  /** `A`..`H` for a sound or a kit. Absent for a project, which has no bank. */
  bank?: string;
}

/** An entry that cannot be restored, and what is wrong with it. */
export interface DamagedEntry {
  entry: BackupEntry;
  /** `missing` — not in the zip. `length` — there, and not the size the manifest recorded. */
  fault: "missing" | "length";
  /** Bytes found, for a length fault. */
  found?: number;
}

export interface OpenedBackup {
  manifest: BackupManifest;
  /** Everything usable, in manifest order. */
  entries: OpenedEntry[];
  /** Listed and not usable. Named so a reader can be told which slots they have lost. */
  damaged: DamagedEntry[];
  /**
   * Files in the zip that the manifest never mentioned.
   *
   * Not an error and not restorable: without a manifest row there is no `source`, so nothing knows
   * where such a file would go. Reported because a backup with strangers in it is worth a second
   * look, and because somebody adding files by hand should be told they are being ignored.
   */
  unlisted: string[];
}

const MANIFEST = "manifest.json";

/** The one place that decides a parsed object is a manifest, naming the field that is not. */
function asManifest(value: unknown): BackupManifest {
  const fault = (why: string): never => {
    throw new DnxError(`${MANIFEST} is not a backup manifest: ${why}.`);
  };
  if (typeof value !== "object" || value === null) fault("it is not an object");
  const m = value as Record<string, unknown>;

  if (typeof m["dnx"] !== "number") fault("`dnx` is missing or is not a number");
  if (typeof m["taken"] !== "string") fault("`taken` is missing or is not a string");
  if (typeof m["form"] !== "string") fault("`form` is missing or is not a string");
  if (!Array.isArray(m["entries"])) fault("`entries` is missing or is not a list");
  if (!Array.isArray(m["contents"])) fault("`contents` is missing or is not a list");

  const device = m["device"];
  if (typeof device !== "object" || device === null) fault("`device` is missing");
  const d = device as Record<string, unknown>;
  if (typeof d["name"] !== "string") fault("`device.name` is missing or is not a string");
  if (typeof d["productId"] !== "number") fault("`device.productId` is missing or is not a number");

  (m["entries"] as unknown[]).forEach((raw, at) => {
    if (typeof raw !== "object" || raw === null) fault(`entry ${at} is not an object`);
    const e = raw as Record<string, unknown>;
    for (const key of ["file", "source", "name"]) {
      if (typeof e[key] !== "string") fault(`entry ${at} has no \`${key}\``);
    }
    for (const key of ["slot", "bytes"]) {
      if (typeof e[key] !== "number") fault(`entry ${at} has no \`${key}\``);
    }
  });

  return value as BackupManifest;
}

/**
 * Where an entry belongs, from the +Drive path it was read from.
 *
 * `/projects/56` gives `projects`; `/soundbanks/A/12` gives `soundbanks` and bank `A`. A path that
 * fits neither shape yields its first segment and no bank, so an unfamiliar directory is carried
 * through under its own name rather than being forced into one of the three we know.
 */
function placeOf(source: string): { kind: string; bank?: string } {
  const parts = source.split("/").filter((part) => part.length > 0);
  const kind = parts[0] ?? "";
  const bank = parts.length === 3 ? parts[1] : undefined;
  return bank === undefined ? { kind } : { kind, bank };
}

/**
 * Open a `.dnx`.
 *
 * Throws `DnxError` when the file is not a backup this reader can be trusted with, and otherwise
 * returns everything it holds along with everything wrong with it.
 */
export async function openBackup(file: Uint8Array): Promise<OpenedBackup> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(file);
  } catch (error) {
    // A `.dnx` is a zip, so "this is not a zip" is the same sentence as "this is not a backup", and
    // the reader should hear the second one.
    if (error instanceof ZipError) {
      throw new DnxError(`This is not a .dnx: it is not a zip file. (${error.message})`);
    }
    throw error;
  }

  const raw = files.get(MANIFEST);
  if (!raw) {
    throw new DnxError(
      `This zip has no ${MANIFEST}, so nothing in it says which instrument or which slots it came ` +
      "from. A folder of project files alone cannot be put back.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    throw new DnxError(`${MANIFEST} is not valid JSON. (${String(error)})`);
  }
  const manifest = asManifest(parsed);

  if (manifest.dnx > DNX_VERSION) {
    throw new DnxError(
      `This backup is version ${manifest.dnx} and this version of DNX reads up to ${DNX_VERSION}. ` +
      "Reading it anyway would mean guessing at a format, and the guess would end at a write to " +
      "your instrument.",
    );
  }

  if (manifest.form !== "stored") {
    throw new DnxError(
      `This backup was taken in ${manifest.form} form, and only the stored form can be written ` +
      "back. It can be opened and read, but nothing in it can be restored to an instrument.",
    );
  }

  const entries: OpenedEntry[] = [];
  const damaged: DamagedEntry[] = [];

  for (const entry of manifest.entries) {
    const bytes = files.get(entry.file);
    if (!bytes) {
      damaged.push({ entry, fault: "missing" });
      continue;
    }
    if (bytes.length !== entry.bytes) {
      // **Length is the only check the manifest can support**, and it is worth having: a truncated
      // file written to a slot is a corrupt project, not a failed write. The manifest records no
      // checksum, so this cannot prove a file is intact — only catch one that plainly is not.
      damaged.push({ entry, fault: "length", found: bytes.length });
      continue;
    }
    entries.push({ entry, bytes, ...placeOf(entry.source) });
  }

  const listed = new Set(manifest.entries.map((entry) => entry.file));
  const unlisted = [...files.keys()].filter((name) => name !== MANIFEST && !listed.has(name));

  return { manifest, entries, damaged, unlisted };
}
