/**
 * The order of one send to digikit's sample store: new folders, uploads and deletes together.
 *
 * **One job: the steps and their order.** The page keeps the changes the user makes (folders to
 * make, files to send, samples and folders to delete). Nothing is written until the user sends the
 * plan, with one confirmation. This module turns the changes into the steps, in the order they run,
 * and says why a plan cannot run.
 *
 * ## The order
 *
 * New folders come first, parents before their children, so an upload into a new folder finds it.
 * Uploads come next, and deletes last, so a failed upload deletes nothing.
 *
 * One exception: when the uploads do not fit in the free space but fit in the space the deletes
 * give back, the sample deletes run first. Folder deletes always run last, deepest first, because
 * the store deletes only an empty folder.
 *
 * ## What a plan refuses
 *
 * - A sample that is sent and deleted in the same plan. The two steps would undo each other.
 * - A folder that is deleted while it still holds a sample, a folder, or a file to send.
 * - A plan with nothing to do.
 */

import { type ConvertedFile, type ImportPlan, type ListedEntry, fitProblem, planImport } from "./importplan.js";
import { folderPath, isFolderEntry } from "./storelisting.js";

export interface SendChanges {
  /** The store's listing. */
  entries: readonly ListedEntry[];
  /** The folders to make, relative to `samples/`. */
  folders: readonly string[];
  /** The files to send. */
  uploads: readonly ConvertedFile[];
  /** The store paths to delete, `samples/...`: samples and folders. */
  deletes: readonly string[];
  /** The store's free bytes. */
  free: number;
}

export type SendStep =
  | { kind: "mkdir"; folder: string }
  /** `index` is the file's place in `uploads`. */
  | { kind: "upload"; index: number }
  | { kind: "delete"; path: string; folder: boolean };

export interface SendPlan {
  /** The uploads, file by file. A file with a problem is left out of the steps. */
  uploads: ImportPlan;
  steps: SendStep[];
  /** The bytes the uploads send. */
  bytes: number;
  /** The bytes the sample deletes give back. */
  freed: number;
  /** The free bytes when every step is done. */
  freeAfter: number;
  /** The sample deletes run before the uploads, to make the space. */
  deletesFirst: boolean;
  /** Why the plan cannot run, or undefined when it can. */
  problem?: string;
}

const depth = (path: string): number => path.split("/").length;

export function planSend(changes: SendChanges): SendPlan {
  const { entries, uploads, free } = changes;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const deletes = [...new Set(changes.deletes)];
  const fileDeletes = deletes.filter((path) => {
    const entry = byPath.get(path);
    return entry !== undefined && !isFolderEntry(entry);
  });
  const folderDeletes = deletes.filter((path) => !fileDeletes.includes(path));
  const freed = fileDeletes.reduce((sum, path) => sum + byPath.get(path)!.size, 0);

  // The space check is this module's, so the import plan gets all the space there is.
  const imported = planImport(entries, uploads, Number.POSITIVE_INFINITY);
  const going = imported.files.flatMap((file, index) => (file.problem ? [] : [{ file, index }]));
  const bytes = imported.bytes;

  const problems: string[] = [];
  for (const { file } of going) {
    if (fileDeletes.includes(file.path)) problems.push(`${file.path} is sent and deleted in one plan. Undo one of the two.`);
  }
  for (const path of folderDeletes) {
    const inside = `${path}/`;
    const kept = entries.find((entry) => entry.path.startsWith(inside) && !deletes.includes(entry.path));
    if (kept) problems.push(`${path}/ still holds ${kept.path.slice(inside.length)}.`);
    const sent = going.find(({ file }) => file.path.startsWith(inside));
    if (sent) problems.push(`${path}/ gets ${sent.file.name} in this plan.`);
    if (changes.folders.some((folder) => folderPath(folder).startsWith(inside))) {
      problems.push(`${path}/ gets a new folder in this plan.`);
    }
  }

  const deletesFirst = bytes > free && bytes <= free + freed;
  if (!deletesFirst) {
    const fit = fitProblem(bytes, free + freed);
    if (fit) problems.push(fit);
  }

  const mkdirs: SendStep[] = [...new Set(changes.folders)].sort().map((folder) => ({ kind: "mkdir", folder }));
  const sends: SendStep[] = going.map(({ index }) => ({ kind: "upload", index }));
  const sampleSteps: SendStep[] = [...fileDeletes].sort().map((path) => ({ kind: "delete", path, folder: false }));
  const folderSteps: SendStep[] = [...folderDeletes]
    .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))
    .map((path) => ({ kind: "delete", path, folder: true }));
  const steps = deletesFirst
    ? [...sampleSteps, ...mkdirs, ...sends, ...folderSteps]
    : [...mkdirs, ...sends, ...sampleSteps, ...folderSteps];

  if (steps.length === 0) problems.push(uploads.length > 0 ? "No file can be sent." : "The plan is empty.");

  return {
    uploads: imported,
    steps,
    bytes,
    freed,
    freeAfter: free + freed - bytes,
    deletesFirst,
    ...(problems.length > 0 ? { problem: problems[0] } : {}),
  };
}

/** What finished, for the status line when a send stops partway. */
export function describeDone(done: readonly SendStep[], names: (index: number) => string): string {
  const made = done.filter((step) => step.kind === "mkdir").length;
  const sent = done.flatMap((step) => (step.kind === "upload" ? [names(step.index)] : []));
  const deleted = done.filter((step) => step.kind === "delete").length;
  const parts = [
    ...(made > 0 ? [`made ${made} ${made === 1 ? "folder" : "folders"}`] : []),
    ...(sent.length > 0 ? [`sent and verified ${sent.join(", ")}`] : []),
    ...(deleted > 0 ? [`deleted ${deleted}`] : []),
  ];
  if (parts.length === 0) return "Nothing was changed.";
  const text = parts.join(", ");
  return `Done before it stopped: ${text}.`;
}
