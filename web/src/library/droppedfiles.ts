/**
 * The WAV files in a drop, with the folders they came in.
 *
 * **One job: read a drop.** A drop can hold files and folders. A folder's structure comes with its
 * files, and the store makes a sample's folders from its path, so the structure costs nothing to
 * keep.
 *
 * `webkitGetAsEntry` works only during the drop event, so `droppedEntries` runs in the handler and
 * `readDropped` may run after it.
 */

/** A dropped file, and the folders it came in, relative to the drop. */
export interface DroppedFile {
  file: File;
  folder: string;
}

export interface Dropped {
  wavs: DroppedFile[];
  /** Files in the drop that are not WAV files. */
  skipped: number;
}

/** The part of the browser's `FileSystemEntry` this reads. */
export interface DropEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(done: (file: File) => void, failed?: (error: unknown) => void): void;
  createReader?(): { readEntries(done: (batch: DropEntry[]) => void, failed?: (error: unknown) => void): void };
}

const isWav = (name: string): boolean => /\.wav$/i.test(name);

/** The entries of a drop. Call this in the drop handler. */
export function droppedEntries(transfer: DataTransfer): DropEntry[] {
  const entries: DropEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    const entry = item.kind === "file" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry as unknown as DropEntry);
  }
  if (entries.length > 0) return entries;
  // A browser that gives no entries still gives the files. Their folders are not known.
  return Array.from(transfer.files).map((file) => ({
    name: file.name,
    isFile: true,
    isDirectory: false,
    file: (done: (file: File) => void) => done(file),
  }));
}

/** One batch of a folder. A folder's reader gives its entries in batches, until an empty one. */
const nextBatch = (reader: ReturnType<NonNullable<DropEntry["createReader"]>>): Promise<DropEntry[]> =>
  new Promise((resolve, reject) => reader.readEntries(resolve, reject));

/** Every WAV file under `entries`. */
export async function readDropped(entries: readonly DropEntry[]): Promise<Dropped> {
  const out: Dropped = { wavs: [], skipped: 0 };
  const walk = async (entry: DropEntry, folder: string): Promise<void> => {
    if (entry.isFile && entry.file) {
      if (!isWav(entry.name)) {
        out.skipped += 1;
        return;
      }
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      out.wavs.push({ file, folder });
      return;
    }
    if (!entry.isDirectory || !entry.createReader) return;
    const inside = folder === "" ? entry.name : `${folder}/${entry.name}`;
    const reader = entry.createReader();
    for (let batch = await nextBatch(reader); batch.length > 0; batch = await nextBatch(reader)) {
      for (const child of batch) await walk(child, inside);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}
