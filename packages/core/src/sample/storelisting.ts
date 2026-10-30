/**
 * One folder of digikit's sample store, out of a LIST of the whole `samples/` subtree.
 *
 * **Folders are part of the paths.** The store has no directories. A folder exists in two ways:
 * an entry of its own (size 0, a zero sha256), made by MKDIR, or only because a file path runs
 * through it. Only the first kind can be deleted on its own. The second kind goes when its last
 * file goes. A folder can be both at once.
 *
 * The rules come from digikit's `docs/design/digikit-store.md` ("Format") and its
 * `MODULE-AUTHORING.md` (files section): a store path is 1 to 159 bytes of printable ASCII
 * (0x20 to 0x7E), with no empty, `.` or `..` part, and a DN2 sample path is at most 151 bytes
 * after `samples/`.
 */

import type { DkEntry } from "../vendor/digikit/dkupload-core.js";
import { STORE_FOLDER } from "../vendor/digikit/samples.js";

export { STORE_FOLDER };

/** The most bytes of a DN2 sample path after `samples/`. */
export const SAMPLE_PATH_MAX = 151;

export interface StoreFile {
  name: string;
  /** The full store path, `samples/...`. */
  path: string;
  size: number;
  sha256: string;
}

export interface StoreFolder {
  name: string;
  /** The full store path, `samples/...`, without a trailing slash. */
  path: string;
  /** A folder entry of its own (MKDIR), so it can be deleted when empty. */
  entry: boolean;
  /** Files anywhere under it. */
  files: number;
}

export interface StoreListing {
  /** The folder, relative to `samples/` (`""` is the top), without slashes at the ends. */
  folder: string;
  /** Sorted by name, in byte order, as the store sorts. */
  folders: StoreFolder[];
  files: StoreFile[];
}

/** A folder entry, as digikit marks one: no bytes and a zero hash. */
export const isFolderEntry = (entry: DkEntry): boolean =>
  entry.size === 0 && /^0+$/.test(entry.sha256);

/** `a/b/` or `/a/b` as `a/b`. */
export const cleanFolder = (folder: string): string => folder.replace(/^\/+|\/+$/g, "");

/** The store path of `folder` (relative to `samples/`). */
export const folderPath = (folder: string): string =>
  cleanFolder(folder) === "" ? STORE_FOLDER : `${STORE_FOLDER}/${cleanFolder(folder)}`;

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** What `folder` holds, from the entries of a LIST. Entries outside `samples/` are ignored. */
export function listFolder(entries: readonly DkEntry[], folder: string): StoreListing {
  const prefix = `${folderPath(folder)}/`;
  const folders = new Map<string, StoreFolder>();
  const files: StoreFile[] = [];

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    if (slash < 0 && !isFolderEntry(entry)) {
      files.push({ name: rest, path: entry.path, size: entry.size, sha256: entry.sha256 });
      continue;
    }
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const known = folders.get(name) ?? { name, path: prefix + name, entry: false, files: 0 };
    if (slash < 0) known.entry = true;
    else if (!isFolderEntry(entry)) known.files += 1;
    folders.set(name, known);
  }

  return { folder: cleanFolder(folder), folders: [...folders.values()].sort(byName), files: files.sort(byName) };
}

/**
 * Why `name` cannot be a new folder in `folder`, or undefined when it can.
 *
 * One part, so a slash is refused rather than read as two folders.
 */
export function folderNameProblem(folder: string, name: string): string | undefined {
  if (name === "") return "Type a name.";
  if (name.includes("/")) return "A folder name cannot hold a slash.";
  if (name === "." || name === "..") return "A folder cannot be called . or ..";
  if (name !== name.trim()) return "A folder name cannot start or end with a space.";
  if (!/^[\x20-\x7e]+$/.test(name)) return "Use letters, digits, spaces and ASCII punctuation only.";
  const inside = cleanFolder(folder) === "" ? name : `${cleanFolder(folder)}/${name}`;
  // Room for a slash and a one-letter file name, or the folder can hold nothing.
  if (inside.length + 2 > SAMPLE_PATH_MAX) {
    return `The path is too long. A sample path holds at most ${SAMPLE_PATH_MAX} characters after ${STORE_FOLDER}/.`;
  }
  return undefined;
}

/**
 * How long to wait for a VERIFY of a whole file.
 *
 * The runtime hashes the file from a fresh card read, at about 2 MB a second (digikit's
 * `VERIFY_PIECE` note). The session's default of 6 s would run out on a file above about 12 MB
 * and send the request again. This allows 0.5 MB a second, a quarter of that rate, plus 6 s.
 */
export function verifyTimeoutMs(size: number): number {
  return 6_000 + Math.ceil(size / 500);
}
