/**
 * The sample library: objects, the catalog, and which projects use what.
 *
 * **One job: the bookkeeping.** No bytes live here and nothing is sent. The master copy's bytes
 * are the caller's to store, by identity, and the device is `devicestore.ts`.
 *
 * ## Three things, so a move or a rename never touches a link
 *
 * 1. **Objects.** One per identity (`identity.ts`): the hash and size, the channel count and the
 *    frame count. Two imports of the same audio are one object.
 * 2. **The catalog.** Folders, and entries that give an object a name in a folder. An object can
 *    have several entries. Moving or renaming an entry, or a folder, edits the catalog only.
 * 3. **Uses.** Which projects use which object. A sound links to an object by identity, so these
 *    are the links a delete would break, and `deleteObject` refuses while any exist.
 *
 * This follows "Sample region plan" (2026-10-21): objects named by their hash, a catalog of
 * folders and names, and reverse links kept by DNX so a delete warns first.
 *
 * ## Folder paths
 *
 * A folder is a path: `/` is the root, and `/drums/kicks` is two levels down. A path segment is
 * any text without `/`, trimmed, and not empty. Names compare exactly, so `Kick` and `kick` are
 * two names, as on the device's own +Drive.
 */

import { SampleError } from "./errors.js";
import type { ChannelCount } from "./format.js";
import { parseSampleKey, sampleKey, type SampleId } from "./identity.js";

export interface SampleObject {
  id: SampleId;
  channels: ChannelCount;
  frames: number;
}

export interface CatalogEntry {
  /** Stable for the entry's life: moves and renames keep it. */
  entryId: string;
  folder: string;
  name: string;
  /** The object, by `sampleKey`. */
  sample: string;
}

/** The library as JSON, for the DNX folder. */
export interface LibraryJson {
  kind: "dnx-sample-library";
  version: 1;
  objects: { key: string; channels: ChannelCount; frames: number }[];
  folders: string[];
  entries: CatalogEntry[];
  uses: { project: string; samples: string[] }[];
  nextEntry: number;
}

/** Normalise a folder path, or throw if it is not one. */
export function folderPath(path: string): string {
  if (!path.startsWith("/")) throw new SampleError(`"${path}" is not a folder path: it must start with /`);
  const parts = path
    .split("/")
    .slice(1)
    .map((part) => part.trim());
  if (parts.length === 1 && parts[0] === "") return "/";
  if (parts.some((part) => part === "")) throw new SampleError(`"${path}" has an empty folder name`);
  return `/${parts.join("/")}`;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new SampleError("a sample's name cannot be empty");
  if (trimmed.includes("/")) throw new SampleError(`"${name}" contains a /, which separates folders`);
  return trimmed;
}

/** Whether `path` is `folder` or lies inside it. */
function within(path: string, folder: string): boolean {
  return folder === "/" || path === folder || path.startsWith(`${folder}/`);
}

export class SampleLibrary {
  private readonly objects = new Map<string, SampleObject>();
  private readonly folders = new Set<string>(["/"]);
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly uses = new Map<string, Set<string>>();
  private nextEntry = 1;

  // --- Objects -------------------------------------------------------------------------------

  /**
   * Add an object, or find the one already there. `added` is false for a duplicate, which is how
   * an import says "you already have this".
   */
  addObject(object: SampleObject): { key: string; added: boolean } {
    const key = sampleKey(object.id);
    const existing = this.objects.get(key);
    if (existing) {
      if (existing.channels !== object.channels || existing.frames !== object.frames) {
        throw new SampleError(
          `${key} is already in the library with different channels or length. Two different ` +
            `samples have the same hash and size, which xxHash64 makes very unlikely.`,
        );
      }
      return { key, added: false };
    }
    if (object.frames * object.channels * 2 !== object.id.size) {
      throw new SampleError(`${key}: ${object.frames} frames of ${object.channels} channels is not ${object.id.size} bytes`);
    }
    this.objects.set(key, { ...object, id: { ...object.id } });
    return { key, added: true };
  }

  object(key: string): SampleObject | undefined {
    return this.objects.get(key);
  }

  allObjects(): SampleObject[] {
    return [...this.objects.values()];
  }

  /** The projects that use an object. Empty means a delete breaks nothing. */
  usersOf(key: string): string[] {
    return [...(this.uses.get(key) ?? [])].sort();
  }

  /**
   * Delete an object and every catalog entry that names it.
   *
   * **Refused while a project uses it**, with the projects named, unless `force` is set. A forced
   * delete leaves those projects pointing at a missing sample. The device then shows a missing
   * sample, never a wrong one, because the link is by identity.
   */
  deleteObject(key: string, options: { force?: boolean } = {}): { removedEntries: number; brokenProjects: string[] } {
    if (!this.objects.has(key)) throw new SampleError(`${key} is not in the library`);
    const users = this.usersOf(key);
    if (users.length > 0 && !options.force) {
      throw new SampleError(
        `${key} is used by ${users.length} project${users.length === 1 ? "" : "s"}: ${users.join(", ")}`,
      );
    }
    let removedEntries = 0;
    for (const [entryId, entry] of this.entries) {
      if (entry.sample === key) {
        this.entries.delete(entryId);
        removedEntries++;
      }
    }
    this.objects.delete(key);
    return { removedEntries, brokenProjects: users };
  }

  /** Objects no entry names and no project uses: what a cleanup could remove. */
  orphans(): string[] {
    const named = new Set([...this.entries.values()].map((e) => e.sample));
    return [...this.objects.keys()].filter((key) => !named.has(key) && !this.uses.has(key)).sort();
  }

  // --- Folders -------------------------------------------------------------------------------

  /** Create a folder and any parents it needs. Creating one that exists is not an error. */
  addFolder(path: string): string {
    let folder = folderPath(path);
    const created = folder;
    while (!this.folders.has(folder)) {
      this.folders.add(folder);
      folder = parentOf(folder);
    }
    return created;
  }

  allFolders(): string[] {
    return [...this.folders].sort();
  }

  /** Remove an empty folder. A folder with entries or subfolders is refused. */
  removeFolder(path: string): void {
    const folder = folderPath(path);
    if (folder === "/") throw new SampleError("the root folder cannot be removed");
    if (!this.folders.has(folder)) throw new SampleError(`${folder} does not exist`);
    if ([...this.folders].some((f) => f !== folder && within(f, folder))) {
      throw new SampleError(`${folder} has folders in it`);
    }
    if ([...this.entries.values()].some((e) => e.folder === folder)) {
      throw new SampleError(`${folder} has samples in it`);
    }
    this.folders.delete(folder);
  }

  /**
   * Move or rename a folder, with everything inside it. Catalog only: no object and no project
   * use changes.
   */
  moveFolder(from: string, to: string): void {
    const source = folderPath(from);
    const target = folderPath(to);
    if (source === "/") throw new SampleError("the root folder cannot be moved");
    if (!this.folders.has(source)) throw new SampleError(`${source} does not exist`);
    if (within(target, source)) throw new SampleError(`${source} cannot move into itself`);
    if (this.folders.has(target)) throw new SampleError(`${target} already exists`);

    const rebase = (path: string): string => target + path.slice(source.length);
    const moved = [...this.folders].filter((f) => within(f, source));
    for (const f of moved) this.folders.delete(f);
    this.addFolder(parentOf(target));
    for (const f of moved) this.folders.add(rebase(f));
    for (const entry of this.entries.values()) {
      if (within(entry.folder, source)) entry.folder = rebase(entry.folder);
    }
  }

  // --- Entries -------------------------------------------------------------------------------

  /** Name an object in a folder. The folder must exist, and the name must be free there. */
  addEntry(folder: string, name: string, sample: string): CatalogEntry {
    const path = folderPath(folder);
    if (!this.folders.has(path)) throw new SampleError(`${path} does not exist`);
    if (!this.objects.has(sample)) throw new SampleError(`${sample} is not in the library`);
    const clean = checkName(name);
    this.refuseClash(path, clean);
    const entry: CatalogEntry = { entryId: `e${this.nextEntry++}`, folder: path, name: clean, sample };
    this.entries.set(entry.entryId, entry);
    return { ...entry };
  }

  entry(entryId: string): CatalogEntry | undefined {
    const entry = this.entries.get(entryId);
    return entry && { ...entry };
  }

  /** A folder's entries, by name. */
  entriesIn(folder: string): CatalogEntry[] {
    const path = folderPath(folder);
    return [...this.entries.values()]
      .filter((e) => e.folder === path)
      .map((e) => ({ ...e }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Every entry that names an object. */
  entriesFor(sample: string): CatalogEntry[] {
    return [...this.entries.values()].filter((e) => e.sample === sample).map((e) => ({ ...e }));
  }

  /** Move an entry to another folder, and rename it if `name` is given. Catalog only. */
  moveEntry(entryId: string, folder: string, name?: string): CatalogEntry {
    const entry = this.mustEntry(entryId);
    const path = folderPath(folder);
    if (!this.folders.has(path)) throw new SampleError(`${path} does not exist`);
    const clean = name === undefined ? entry.name : checkName(name);
    if (path !== entry.folder || clean !== entry.name) this.refuseClash(path, clean);
    entry.folder = path;
    entry.name = clean;
    return { ...entry };
  }

  renameEntry(entryId: string, name: string): CatalogEntry {
    return this.moveEntry(entryId, this.mustEntry(entryId).folder, name);
  }

  /** Remove a name. The object stays, so other names and every project use still reach it. */
  removeEntry(entryId: string): void {
    this.mustEntry(entryId);
    this.entries.delete(entryId);
  }

  // --- Uses ----------------------------------------------------------------------------------

  /**
   * Record the objects one project uses, replacing what was recorded for it before. An object
   * the library does not hold is refused: recording it would hide a missing sample.
   */
  setProjectSamples(project: string, samples: readonly string[]): void {
    for (const key of samples) {
      if (!this.objects.has(key)) throw new SampleError(`${project} uses ${key}, which is not in the library`);
    }
    this.forgetProject(project);
    for (const key of samples) {
      let users = this.uses.get(key);
      if (!users) this.uses.set(key, (users = new Set()));
      users.add(project);
    }
  }

  /** The objects a project uses. */
  samplesOf(project: string): string[] {
    return [...this.uses].filter(([, users]) => users.has(project)).map(([key]) => key).sort();
  }

  /** Drop every use a project recorded, for a project that was deleted. */
  forgetProject(project: string): void {
    for (const [key, users] of this.uses) {
      users.delete(project);
      if (users.size === 0) this.uses.delete(key);
    }
  }

  // --- JSON ----------------------------------------------------------------------------------

  toJSON(): LibraryJson {
    const projects = new Map<string, string[]>();
    for (const [key, users] of this.uses) {
      for (const project of users) {
        const list = projects.get(project) ?? [];
        list.push(key);
        projects.set(project, list);
      }
    }
    return {
      kind: "dnx-sample-library",
      version: 1,
      objects: [...this.objects.entries()].map(([key, o]) => ({ key, channels: o.channels, frames: o.frames })),
      folders: this.allFolders(),
      entries: [...this.entries.values()].map((e) => ({ ...e })),
      uses: [...projects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([project, samples]) => ({
        project,
        samples: samples.sort(),
      })),
      nextEntry: this.nextEntry,
    };
  }

  /** Read a library back. Every rule the methods enforce is checked again, so a bad file throws. */
  static fromJSON(json: LibraryJson): SampleLibrary {
    if (json?.kind !== "dnx-sample-library") throw new SampleError("this is not a DNX sample library");
    if (json.version !== 1) throw new SampleError(`sample library version ${String(json.version)} is not one this DNX reads`);
    const library = new SampleLibrary();
    for (const o of json.objects) {
      library.addObject({ id: parseSampleKey(o.key), channels: o.channels, frames: o.frames });
    }
    for (const folder of json.folders) library.addFolder(folder);
    let highest = 0;
    for (const e of json.entries) {
      const path = folderPath(e.folder);
      if (!library.folders.has(path)) throw new SampleError(`${e.entryId} is in ${path}, which is not listed`);
      if (!library.objects.has(e.sample)) throw new SampleError(`${e.entryId} names ${e.sample}, which is not listed`);
      if (library.entries.has(e.entryId)) throw new SampleError(`${e.entryId} appears twice`);
      const clean = checkName(e.name);
      library.refuseClash(path, clean);
      library.entries.set(e.entryId, { entryId: e.entryId, folder: path, name: clean, sample: e.sample });
      const n = /^e(\d+)$/.exec(e.entryId);
      if (n) highest = Math.max(highest, Number(n[1]));
    }
    for (const u of json.uses) library.setProjectSamples(u.project, [...library.samplesOf(u.project), ...u.samples]);
    library.nextEntry = Math.max(json.nextEntry, highest + 1);
    return library;
  }

  // --- Internals -----------------------------------------------------------------------------

  private mustEntry(entryId: string): CatalogEntry {
    const entry = this.entries.get(entryId);
    if (!entry) throw new SampleError(`there is no entry ${entryId}`);
    return entry;
  }

  private refuseClash(folder: string, name: string): void {
    for (const e of this.entries.values()) {
      if (e.folder === folder && e.name === name) {
        throw new SampleError(`${folder === "/" ? "" : folder}/${name} already exists`);
      }
    }
  }
}
