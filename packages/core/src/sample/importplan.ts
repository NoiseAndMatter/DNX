/**
 * What an import into one folder of digikit's sample store would do, before anything is sent.
 *
 * **One job: the plan.** The page converts the WAV files (digikit's converter) and passes the
 * results here with the store's listing. The plan says, file by file, where each one goes, whether
 * it replaces a sample, and why a file cannot go. It also gives the one check on the whole batch.
 *
 * ## The fits check
 *
 * `fitProblem` is the place for the check that a batch fits. Today it compares the bytes with the
 * store's free space only. The store puts a file in the first free gap that is large enough, so a
 * batch that passes can still be refused by the device (E_FULL). A later check (for example a
 * project's pool budget) goes into this function, so the page does not change.
 */

import { cleanFolder, folderPath, isFolderEntry, sampleNameProblem } from "./storelisting.js";

/** The least the plan needs of a listed entry (digikit's `DkEntry`). */
export interface ListedEntry {
  path: string;
  size: number;
  sha256: string;
}

/** The least the plan needs of a converted file (digikit's `Prepared`). */
export interface ConvertedFile {
  /** The name in the store: the WAV's name without `.wav`. */
  name: string;
  /** The file the store holds. */
  stored: Uint8Array;
}

export interface PlannedFile {
  name: string;
  /** The full store path, `samples/...`. */
  path: string;
  size: number;
  /** A sample with this path is in the store, and the upload replaces it. */
  replaces: boolean;
  /** Why this file is not sent, or undefined when it is. */
  problem?: string;
}

export interface ImportPlan {
  folder: string;
  files: PlannedFile[];
  /** The files that are sent. */
  sent: number;
  /** Their bytes. */
  bytes: number;
  /** Why the whole batch is not sent, or undefined when it can be. */
  problem?: string;
}

/** Why `bytes` do not fit in a store with `free` bytes free, or undefined when they may. */
export function fitProblem(bytes: number, free: number): string | undefined {
  if (bytes <= free) return undefined;
  const mib = (n: number): string => `${(n / 1_048_576).toFixed(1)} MiB`;
  return `The samples need ${mib(bytes)}, and the store has ${mib(free)} free.`;
}

export function planImport(
  entries: readonly ListedEntry[],
  folder: string,
  files: readonly ConvertedFile[],
  free: number,
): ImportPlan {
  const base = folderPath(folder);
  const listed = new Set(entries.filter((e) => !isFolderEntry(e)).map((e) => e.path));
  const folders = new Set(entries.filter((e) => isFolderEntry(e)).map((e) => e.path));
  const taken = new Set<string>();
  const planned: PlannedFile[] = [];

  for (const file of files) {
    const path = `${base}/${file.name}`;
    let problem = sampleNameProblem(folder, file.name);
    if (!problem && taken.has(path)) problem = `Another file in this import is also called ${file.name}.`;
    // A folder of that name: its path is the sample's path, and a sample cannot replace a folder.
    if (!problem && (folders.has(path) || entries.some((e) => e.path.startsWith(`${path}/`)))) {
      problem = `${file.name} is a folder here.`;
    }
    if (!problem) taken.add(path);
    planned.push({
      name: file.name,
      path,
      size: file.stored.length,
      replaces: listed.has(path),
      ...(problem ? { problem } : {}),
    });
  }

  const going = planned.filter((p) => !p.problem);
  // A replaced sample's space comes back, but only after its upload, so it is not counted as free.
  const bytes = going.reduce((sum, p) => sum + p.size, 0);
  const problem = going.length === 0 ? "No file can be sent." : fitProblem(bytes, free);
  return { folder: cleanFolder(folder), files: planned, sent: going.length, bytes, ...(problem ? { problem } : {}) };
}
