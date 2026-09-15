/**
 * The DNX folder: one place on disk where every file DNX makes lands, sorted by what it is.
 *
 * ## Why a folder as well as downloads
 *
 * A download is handed to the browser, and the browser decides what happens to it. Chrome holds the
 * downloads a site starts once its guard against many downloads has tripped, until somebody answers a
 * prompt in the address bar that no page can see. DNX saves a backup a minute after its click and a
 * copy before overwriting after a read, which are the downloads that guard counts. On 2026-09-15 that
 * prompt held every export of a test session while the status line said "Exported".
 *
 * A file written into a folder the person chose lands or throws, so the status line can say where the
 * file is.
 *
 * ## The convention
 *
 * The chosen folder is the root. DNX makes one subfolder per kind of file on first use, named in
 * `FOLDER_LAYOUT`, and the Settings help page describes the same list. Files are never replaced: a
 * name already taken gets " (1)", " (2)", as a download would.
 *
 * ## Downloads stay
 *
 * Only Chromium browsers can write to a chosen folder, and Chrome can ask for permission again after a
 * restart. Every save falls back to a download and says why, so a folder that cannot be reached costs
 * a sentence and never a file.
 *
 * ## Where the choice lives
 *
 * A folder handle cannot be put in `localStorage`. It is kept in an IndexedDB database of its own,
 * which Settings → Stored preferences → Clear deletes.
 */

import { saveBlob } from "./dom.js";

/** What a file is, which decides its subfolder. */
export type FileKind = "exports" | "backups" | "copies" | "probe";

/** The subfolder each kind of file goes in. The one list: the help page is tested against it. */
export const FOLDER_LAYOUT: Readonly<Record<FileKind, string>> = {
  exports: "Exports",
  backups: "Backups",
  copies: "Copies before writing",
  probe: "Probe",
};

/** Where a save went. `why` is set when a chosen folder could not take the file. */
export type Saved =
  | { where: "folder"; folder: string; path: string }
  | { where: "download"; name: string; why?: string };

type Permission = "granted" | "denied" | "prompt";

/** The parts of a directory handle this module uses, so a test can hand in one made of maps. */
export interface DirectoryLike {
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileLike>;
}

export interface FileLike {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

/** The chosen root also answers for its permission. Subfolders inherit it. */
export interface FolderHandle extends DirectoryLike {
  queryPermission(descriptor: { mode: "readwrite" }): Promise<Permission>;
  requestPermission(descriptor: { mode: "readwrite" }): Promise<Permission>;
}

export interface SaveEnvironment {
  /** The chosen folder, or undefined when none is. May reject: IndexedDB is refused in some modes. */
  folder(): Promise<FolderHandle | undefined>;
  download(blob: Blob, name: string): void;
}

/** Characters Windows and the File System Access API refuse in a file name. */
function safeName(name: string): string {
  return [...name].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch)).join("");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first of `name`, `name (1)`, `name (2)`… that the folder does not already hold. */
export async function freeName(dir: DirectoryLike, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${extension}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (error) {
      if ((error as { name?: string }).name === "NotFoundError") return candidate;
      throw error;
    }
  }
  throw new Error(`${name} and the next 999 numbered names are all taken`);
}

/** Save into the chosen folder, or download, given where the folder and the download come from. */
export async function saveFileWith(
  blob: Blob,
  name: string,
  kind: FileKind,
  env: SaveEnvironment,
): Promise<Saved> {
  const offer = (why?: string): Saved => {
    env.download(blob, name);
    return why === undefined ? { where: "download", name } : { where: "download", name, why };
  };

  let root: FolderHandle | undefined;
  try {
    root = await env.folder();
  } catch {
    root = undefined;
  }
  if (!root) return offer();

  try {
    let permission = await root.queryPermission({ mode: "readwrite" });
    if (permission === "prompt") {
      // Asking needs a click that is still fresh. A backup saved a minute after its click has none,
      // and the request throws rather than showing Chrome's question.
      permission = await root.requestPermission({ mode: "readwrite" }).catch((): Permission => "prompt");
    }
    if (permission !== "granted") {
      return offer(`DNX may not write to ${root.name} until you press Allow in Settings`);
    }
    const subfolder = FOLDER_LAYOUT[kind];
    const dir = await root.getDirectoryHandle(subfolder, { create: true });
    const free = await freeName(dir, safeName(name));
    const writable = await (await dir.getFileHandle(free, { create: true })).createWritable();
    await writable.write(blob);
    await writable.close();
    return { where: "folder", folder: root.name, path: `${subfolder}/${free}` };
  } catch (error) {
    return offer(`writing to ${root.name} failed: ${messageOf(error)}`);
  }
}

/** Where a saved file is, in words for a status line. */
export function whereSaved(saved: Saved): string {
  return saved.where === "folder"
    ? `${saved.folder}/${saved.path}`
    : `${saved.name} in your downloads${saved.why === undefined ? "" : ` (${saved.why})`}`;
}

/** A save that missed a chosen folder is worth a warning. One that was never meant for one is not. */
export function savedTone(saved: Saved): "ok" | "warn" {
  return saved.where === "download" && saved.why !== undefined ? "warn" : "ok";
}

/* ---- the browser --------------------------------------------------------------------------- */

const DATABASE = "dnx-folder";
const STORE = "handles";
const RECORD = "root";

interface Picker {
  showDirectoryPicker(options: { id: string; mode: "readwrite"; startIn: string }): Promise<unknown>;
}

/** True when this browser can write into a folder the person chooses. */
export function folderSupported(): boolean {
  return typeof (globalThis as Partial<Picker>).showDirectoryPicker === "function" &&
    typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function inStore<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** The chosen folder, if one is. */
export async function storedFolder(): Promise<FolderHandle | undefined> {
  if (!folderSupported()) return undefined;
  return ((await inStore("readonly", (store) => store.get(RECORD))) as FolderHandle | undefined) ?? undefined;
}

/** Ask for a folder and remember it. Rejects with an `AbortError` when the picker is cancelled. */
export async function chooseFolder(): Promise<FolderHandle> {
  const handle = (await (globalThis as unknown as Picker).showDirectoryPicker({
    id: "dnx-folder",
    mode: "readwrite",
    startIn: "documents",
  })) as FolderHandle;
  await inStore("readwrite", (store) => store.put(handle, RECORD));
  return handle;
}

/** Ask again for permission to write to the chosen folder. Call it from a click. */
export async function allowFolder(): Promise<Permission> {
  const root = await storedFolder();
  return root ? root.requestPermission({ mode: "readwrite" }) : "prompt";
}

/** Forget the chosen folder. True when there was one. The folder and its files are untouched. */
export async function forgetFolder(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const had = (await storedFolder().catch(() => undefined)) !== undefined;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  return had;
}

export type FolderState =
  | { kind: "unsupported" }
  | { kind: "none" }
  | { kind: "set"; name: string; permission: Permission };

/** What Settings shows. */
export async function folderState(): Promise<FolderState> {
  if (!folderSupported()) return { kind: "unsupported" };
  const root = await storedFolder();
  if (!root) return { kind: "none" };
  return { kind: "set", name: root.name, permission: await root.queryPermission({ mode: "readwrite" }) };
}

/** Save a file into the DNX folder when one is chosen, and download it otherwise. */
export function saveFile(blob: Blob, name: string, kind: FileKind): Promise<Saved> {
  return saveFileWith(blob, name, kind, { folder: storedFolder, download: saveBlob });
}

/**
 * The same, for bytes.
 *
 * The `slice()` copies into a fresh buffer: a `Uint8Array` over a `SharedArrayBuffer` is not a valid
 * `BlobPart`, and which kind a caller has depends on how the runtime allocated it.
 */
export function saveBytesTo(bytes: Uint8Array, name: string, kind: FileKind): Promise<Saved> {
  return saveFile(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }), name, kind);
}
