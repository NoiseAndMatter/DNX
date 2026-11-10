/**
 * digikit's sample store as one outline: every folder that is open, and what it holds.
 *
 * **One job: rows for a tree.** LIST returns the whole `samples/` subtree in one call, so the page
 * already holds the whole store. This turns that listing into rows. It makes no request.
 *
 * It builds the tree in one pass over the entries. Asking `listFolder` once for each folder would
 * read every entry once for each folder, and the page draws these rows on each click.
 */

import { STORE_FOLDER, isFolderEntry } from "./storelisting.js";

/** The least the outline needs of a listed entry (digikit's `DkEntry`). */
export interface OutlineEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface OutlineFolder {
  kind: "folder";
  name: string;
  /** The full store path, `samples/...`, without a trailing slash. */
  path: string;
  /** The folder, relative to `samples/`. */
  folder: string;
  depth: number;
  /** A folder entry of its own (MKDIR), so it can be deleted when empty. */
  entry: boolean;
  /** Files anywhere under it. */
  files: number;
  /** Its own folders. A folder with only files has none. */
  folders: number;
  open: boolean;
}

export interface OutlineFile {
  kind: "file";
  name: string;
  /** The full store path, `samples/...`. */
  path: string;
  /** The folder that holds it, relative to `samples/`. */
  folder: string;
  depth: number;
  size: number;
  sha256: string;
}

export type OutlineRow = OutlineFolder | OutlineFile;

interface Node {
  name: string;
  folder: string;
  entry: boolean;
  count: number;
  folders: Map<string, Node>;
  files: { name: string; size: number; sha256: string }[];
}

const newNode = (name: string, folder: string): Node => ({
  name,
  folder,
  entry: false,
  count: 0,
  folders: new Map(),
  files: [],
});

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function buildTree(entries: readonly OutlineEntry[]): Node {
  const prefix = `${STORE_FOLDER}/`;
  const root = newNode("", "");
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const parts = entry.path.slice(prefix.length).split("/").filter((part) => part !== "");
    if (parts.length === 0) continue;
    const isFolder = isFolderEntry(entry);
    const last = parts.length - 1;
    const chain = [root];
    let node = root;
    parts.slice(0, isFolder ? parts.length : last).forEach((part) => {
      let next = node.folders.get(part);
      if (!next) {
        next = newNode(part, node.folder === "" ? part : `${node.folder}/${part}`);
        node.folders.set(part, next);
      }
      node = next;
      chain.push(node);
    });
    if (isFolder) {
      node.entry = true;
      continue;
    }
    node.files.push({ name: parts[last]!, size: entry.size, sha256: entry.sha256 });
    for (const holder of chain) holder.count += 1;
  }
  return root;
}

const folderPathOf = (folder: string): string => `${STORE_FOLDER}/${folder}`;
const filePathOf = (folder: string, name: string): string =>
  folder === "" ? `${STORE_FOLDER}/${name}` : `${STORE_FOLDER}/${folder}/${name}`;

/** Rows for the outline. A folder's rows follow it when `open` holds it. Folders come before files. */
export function storeOutline(entries: readonly OutlineEntry[], open: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (node: Node, depth: number): void => {
    for (const child of [...node.folders.values()].sort(byName)) {
      const isOpen = open.has(child.folder);
      rows.push({
        kind: "folder",
        name: child.name,
        path: folderPathOf(child.folder),
        folder: child.folder,
        depth,
        entry: child.entry,
        files: child.count,
        folders: child.folders.size,
        open: isOpen,
      });
      if (isOpen) walk(child, depth + 1);
    }
    for (const file of [...node.files].sort(byName)) {
      rows.push({ kind: "file", ...file, path: filePathOf(node.folder, file.name), folder: node.folder, depth });
    }
  };
  walk(buildTree(entries), 0);
  return rows;
}

/**
 * Every folder and sample whose path holds `query`, in any case, as a flat list.
 *
 * Each row's name is its path after `samples/`, because a flat list shows no parent.
 */
export function storeSearch(entries: readonly OutlineEntry[], query: string): OutlineRow[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [];
  const rows: OutlineRow[] = [];
  const walk = (node: Node): void => {
    for (const child of [...node.folders.values()].sort(byName)) {
      if (child.folder.toLowerCase().includes(wanted)) {
        rows.push({
          kind: "folder",
          name: child.folder,
          path: folderPathOf(child.folder),
          folder: child.folder,
          depth: 0,
          entry: child.entry,
          files: child.count,
          folders: child.folders.size,
          open: false,
        });
      }
      walk(child);
    }
    for (const file of [...node.files].sort(byName)) {
      const name = node.folder === "" ? file.name : `${node.folder}/${file.name}`;
      if (name.toLowerCase().includes(wanted)) {
        rows.push({ kind: "file", ...file, name, path: filePathOf(node.folder, file.name), folder: node.folder, depth: 0 });
      }
    }
  };
  walk(buildTree(entries));
  return rows;
}
