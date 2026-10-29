/**
 * `/devslots`: the saved state slots, read whole for a diagnostics capture.
 *
 * **One job: read the files a diagnostic build serves, and nothing else.** No interpretation: the
 * bytes go to the firmware side as the unit sent them, and they compare them with a clean unit's.
 * The zip and the manifest are the page's (`web/src/devslotscapture.ts`), because hashing and
 * packing need the browser.
 *
 * Spec: `dn2_firmware/docs/for-dnx-devslots.md` rev 2. Diagnostic builds only: stock and released
 * builds do not list the root, so the capture asks the `/` listing first and stops there.
 *
 * ## Read-only, by construction
 *
 * Every request here is a listing or an open-read-close. The route refuses writes in the session
 * itself, and nothing in this module builds one.
 *
 * ## The form is the default, on purpose
 *
 * The route answers in the transfer container (header, body, trailer) without the trailing form
 * byte. The probe page reads it that way, and its files are what the firmware side compares
 * against, so this asks the same way rather than through `readFormOption`.
 */

import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { type MessageIds, IDS_FOR } from "./messageids.js";
import { listRequest, wholeListing } from "./storage.js";
import { MODINFO_PATH } from "../waverider/modinfo.js";

/** The root, as the `/` listing names it. */
export const DEVSLOTS_ROOT = "devslots";

/** The six listed files, by number. */
export const DEVSLOTS_FILES: readonly { file: number; name: string }[] = [
  { file: 0, name: "slot-40000" },
  { file: 1, name: "slot-48000" },
  { file: 2, name: "ram" },
  { file: 3, name: "crc-40000" },
  { file: 4, name: "crc-48000" },
  { file: 5, name: "crc-ram" },
];

/** The block files: `1000 + source x 256 + block`. Not listed. */
export const BLOCK_BASE = 1000;
export const BLOCK_SOURCES = ["slot-40000", "slot-48000", "ram"] as const;
export const BLOCKS_PER_SOURCE = 197;

/** The most block files one run reads. Each is 64 KiB, about 0.3 s on the unit. */
export const MAX_BLOCKS_PER_RUN = 16;

/**
 * Per request. A CRC file is computed when it is opened (12.9 MB read or copied), measured at 3.2
 * to 4.1 s on the unit on 2026-10-29, so the 5 s default is too close.
 */
export const DEVSLOTS_TIMEOUT_MS = 15_000;

/** A 64 KiB block at 2,048 bytes a chunk is 32 requests, plus the open and the close. */
const IDS_PER_FILE = 64;

export class DevslotsError extends Error {}

/** The file number of one block. */
export function blockFile(source: number, block: number): number {
  return BLOCK_BASE + source * 256 + block;
}

/** The source and block a file number names, or undefined when it names none. */
export function blockOf(file: number): { source: number; block: number } | undefined {
  if (!Number.isInteger(file) || file < BLOCK_BASE) return undefined;
  const source = Math.floor((file - BLOCK_BASE) / 256);
  const block = (file - BLOCK_BASE) % 256;
  if (source >= BLOCK_SOURCES.length || block >= BLOCKS_PER_SOURCE) return undefined;
  return { source, block };
}

/**
 * The block numbers somebody pasted, checked before anything is sent.
 *
 * Commas, spaces and new lines all separate. A repeat is read once. Anything that is not a block
 * file refuses the whole list, so a typo cannot turn into a read of something else.
 */
export function parseBlockList(text: string): number[] {
  const words = text.split(/[\s,;]+/).filter((word) => word.length > 0);
  if (words.length === 0) throw new DevslotsError("Type at least one block number.");
  const files: number[] = [];
  for (const word of words) {
    const file = /^\d+$/.test(word) ? Number(word) : NaN;
    if (blockOf(file) === undefined) {
      throw new DevslotsError(
        `${word} is not a block number. A block number is 1000 + source x 256 + block, with ` +
          `source 0 to 2 and block 0 to ${BLOCKS_PER_SOURCE - 1}.`,
      );
    }
    if (!files.includes(file)) files.push(file);
  }
  if (files.length > MAX_BLOCKS_PER_RUN) {
    throw new DevslotsError(
      `${files.length} blocks is more than ${MAX_BLOCKS_PER_RUN}. Send the rest in a second run.`,
    );
  }
  return files;
}

/** The path of a devslots file. */
export function devslotsPath(file: number): string {
  return `/${DEVSLOTS_ROOT}/${file}`;
}

/** What a file is called inside the zip: its number and what it holds. */
export function captureEntryName(path: string): string {
  if (path === MODINFO_PATH) return "modinfo_0.bin";
  const file = Number(path.slice(DEVSLOTS_ROOT.length + 2));
  const listed = DEVSLOTS_FILES.find((f) => f.file === file);
  if (listed) return `devslots_${file}_${listed.name}.bin`;
  const at = blockOf(file);
  if (at) return `devslots_${file}_${BLOCK_SOURCES[at.source]}_block-${at.block}.bin`;
  throw new DevslotsError(`${path} is not a devslots file`);
}

/**
 * `dn2-diagnostics_20261029-1412_1a2b3c4d.zip`, in local time so it matches the clock of the person
 * sending it. The image id is `unknown` when `/modinfo` could not be read. A block run says so in
 * the name, so two zips from one session cannot be mistaken for each other.
 */
export function captureFileName(taken: Date, imageId: number | undefined, blocks: boolean): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${taken.getFullYear()}${two(taken.getMonth() + 1)}${two(taken.getDate())}-` +
    `${two(taken.getHours())}${two(taken.getMinutes())}`;
  const image = imageId === undefined ? "unknown" : imageId.toString(16).padStart(8, "0");
  return `dn2-diagnostics${blocks ? "-blocks" : ""}_${stamp}_${image}.zip`;
}

export interface CapturedFile {
  path: string;
  bytes: Uint8Array;
  /** From the open to the acknowledged close. */
  ms: number;
  /** Whether the close was acknowledged. False is a warning, not a failed read. */
  closed: boolean;
}

export interface CaptureOptions {
  transport: ApiTransport;
  ids: MessageIds;
  /** The devslots files to read, by number. `/modinfo/0` is always read first. */
  files: readonly number[];
  /** Called before each read, so a page can say which file it is on. */
  onFile?: (path: string, index: number, total: number) => void;
  timeoutMs?: number;
  /** The clock, for a test. */
  now?: () => number;
}

/** The sentence a build without the route gets. The page shows it as it is. */
export const NEEDS_DIAGNOSTIC_FIRMWARE = "This needs the diagnostics firmware. Flash it first.";

/**
 * Check the build serves `/devslots`, then read `/modinfo/0` and each file, in order.
 *
 * Throws `DevslotsError` with `NEEDS_DIAGNOSTIC_FIRMWARE` when the root is not listed, before any
 * file is opened. Any other failure throws as the read threw it.
 */
export async function captureDevslots(options: CaptureOptions): Promise<CapturedFile[]> {
  const { transport, ids, files, onFile } = options;
  const timeoutMs = options.timeoutMs ?? DEVSLOTS_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const id = ids.reserve(IDS_FOR.oneMessage);
  const reply = await transport.request(listRequest(id, "/"), id, timeoutMs);
  const roots = wholeListing(reply, "/").entries.map((entry) => entry.name.trim());
  if (!roots.includes(DEVSLOTS_ROOT)) throw new DevslotsError(NEEDS_DIAGNOSTIC_FIRMWARE);

  const paths = [MODINFO_PATH, ...files.map(devslotsPath)];
  const captured: CapturedFile[] = [];
  for (const [index, path] of paths.entries()) {
    onFile?.(path, index, paths.length);
    const started = now();
    const file = await readStoredFile(path, {
      transport,
      msgId: ids.reserve(IDS_PER_FILE),
      timeoutMs,
    });
    captured.push({ path, bytes: file.bytes, ms: now() - started, closed: file.closed });
  }
  return captured;
}
