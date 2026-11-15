/**
 * The bytes of the firmware's `/samples` route: a part to send, and the two records it reads.
 *
 * **One job: the formats.** Nothing here talks to a device. `device/samplesroute.ts` sends the
 * parts and reads the records. The contract is the firmware's `docs/for-dnx-samples.md`
 * (2026-11-15), and every number below comes from it.
 *
 * ```
 * a part      container: kind 0x53, version 1, index n, raw
 *             body: a 256-byte part record, then that part's file bytes
 * info        container: a 96-byte record, the capacity and the open upload
 * index       container: an 8-byte head, then a 200-byte row for each file
 * ```
 *
 * The id of a file is the SHA-256 of the whole native file. DNX computes it, and the instrument
 * stores it and never computes it. The instrument proves each part with an xxHash32 (seed 0) of
 * the bytes that it reads back from the card.
 */

import { HEADER_BYTES, TRAILER_BYTES, buildContainer, contentKind } from "../project/container.js";

/** `0x0D` of a part's container. The firmware refuses another kind at the first chunk. */
export const CONTENT_KIND_SAMPLE_PART = 0x53;
/** `0x11` of a part's container. */
export const PART_OBJECT_VERSION = 1;
/** The four ASCII at `0x09`, as the reference sender writes them. */
const FORMAT_VERSION = "0059";

export const PART_RECORD_BYTES = 256;
export const PART_MAGIC = "DKPT";
export const PART_RECORD_VERSION = 1;
export const INFO_BYTES = 96;
export const INDEX_HEAD_BYTES = 8;
export const INDEX_ROW_BYTES = 200;
export const ID_BYTES = 32;
/** The store path's field holds 160 bytes with the closing zero. */
export const STORE_PATH_MAX = 159;
/** The longest file: 64 MiB. `info` says the same at +16. */
export const LONGEST_FILE = 67_108_864;
/** The folder every sample path starts with. */
export const SAMPLES_FOLDER = "samples";

export class SampleRouteError extends Error {}

/** One part of a file, as DNX builds it. */
export interface PartSpec {
  part: number;
  /** The whole file's length. Every part of one file carries the same. */
  whole: number;
  /** The SHA-256 of the whole file. */
  id: Uint8Array;
  /** The store path, `samples/...`. */
  path: string;
  /** This part's file bytes. */
  bytes: Uint8Array;
}

/** The container for one part, ready for `/samples/<part>`. */
export function buildPart(spec: PartSpec): Uint8Array {
  const { part, whole, id, path, bytes } = spec;
  if (!Number.isInteger(part) || part < 0) throw new SampleRouteError(`part ${part} is not a part number`);
  if (id.length !== ID_BYTES) throw new SampleRouteError(`an id is ${ID_BYTES} bytes, this one is ${id.length}`);
  const why = storePathProblem(path);
  if (why) throw new SampleRouteError(why);

  const body = new Uint8Array(PART_RECORD_BYTES + bytes.length);
  const view = new DataView(body.buffer);
  for (let i = 0; i < PART_MAGIC.length; i++) body[i] = PART_MAGIC.charCodeAt(i);
  view.setUint32(4, PART_RECORD_VERSION);
  view.setUint32(8, part);
  view.setUint32(12, whole);
  body.set(id, 16);
  for (let i = 0; i < path.length; i++) body[48 + i] = path.charCodeAt(i);
  body.set(bytes, PART_RECORD_BYTES);

  return buildContainer({
    body,
    contentKind: CONTENT_KIND_SAMPLE_PART,
    objectVersion: PART_OBJECT_VERSION,
    index: part,
    formatVersion: FORMAT_VERSION,
  });
}

/** How many parts a file of `whole` bytes takes. */
export function partCount(whole: number, partSize: number): number {
  return Math.ceil(whole / partSize);
}

/** The file bytes of part `n`. Every part but the last carries exactly one part size. */
export function partBytes(file: Uint8Array, n: number, partSize: number): Uint8Array {
  return file.subarray(n * partSize, Math.min(file.length, (n + 1) * partSize));
}

/**
 * Why `path` cannot be a store path in version 1, or undefined when it can.
 *
 * The firmware's rule: at most 159 characters, no empty, `.` or `..` part. Version 1 takes the
 * characters 0x20 to 0x7E only. The firmware side checked the others in the emulator on
 * 2026-11-15: no fault, but a byte from 0x7F to 0xFF draws as one of the instrument's symbols, a
 * UTF-8 letter as two symbols, and a byte below 0x20 as a gap.
 */
export function storePathProblem(path: string): string | undefined {
  if (!path.startsWith(`${SAMPLES_FOLDER}/`)) return `a sample path starts with ${SAMPLES_FOLDER}/, not "${path}"`;
  if (path.length > STORE_PATH_MAX) return `a sample path holds at most ${STORE_PATH_MAX} characters`;
  if (!/^[\x20-\x7e]+$/.test(path)) return "a sample path holds the characters 0x20 to 0x7E only";
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return `"${path}" has an empty, "." or ".." part`;
  }
  return undefined;
}

/** What `/samples/info` says. */
export interface SamplesInfo {
  version: number;
  /** An upload is open. */
  open: boolean;
  files: number;
  partSize: number;
  storeKiB: number;
  /** The free space. It can be in more than one gap. */
  freeKiB: number;
  longest: number;
  /** The open upload's whole length. */
  whole: number;
  /** The part the open upload expects. */
  next: number;
  /** The last part's xxHash32, from the card. */
  sum: number;
  /** The last part's result. 0 is good. See `RESULTS`. */
  result: number;
  /** Parts, failed transfers and deletes handled since the boot. It moves once for each. */
  handled: number;
  /** The open upload's id, or the last one's, as 64 lower-case hex. */
  id: string;
  sequence: number;
}

/** The body of a container that the route sent, after its checks. */
function bodyOf(container: Uint8Array, what: string): Uint8Array {
  if (container.length < HEADER_BYTES + TRAILER_BYTES || contentKind(container) === undefined) {
    throw new SampleRouteError(`${what} is not in a transfer container`);
  }
  return container.subarray(HEADER_BYTES, container.length - TRAILER_BYTES);
}

export function parseInfo(container: Uint8Array): SamplesInfo {
  const body = bodyOf(container, "/samples/info");
  if (body.length < INFO_BYTES) throw new SampleRouteError(`/samples/info is ${body.length} bytes, not ${INFO_BYTES}`);
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  const info: SamplesInfo = {
    version: body[0]!,
    open: body[1] === 1,
    files: view.getUint16(2),
    partSize: view.getUint32(4),
    storeKiB: view.getUint32(8),
    freeKiB: view.getUint32(12),
    longest: view.getUint32(16),
    whole: view.getUint32(20),
    next: view.getUint32(24),
    sum: view.getUint32(28),
    result: view.getInt32(32),
    handled: view.getUint32(36),
    id: hex(body.subarray(40, 40 + ID_BYTES)),
    sequence: view.getUint32(72),
  };
  if (info.version !== 1) throw new SampleRouteError(`/samples/info is version ${info.version}, and DNX reads version 1`);
  if (info.partSize === 0) throw new SampleRouteError("/samples/info gives a part size of 0");
  return info;
}

/** One file of the store, as `/samples/index` gives it. */
export interface IndexRow {
  /** 64 lower-case hex. */
  id: string;
  length: number;
  path: string;
}

export interface SamplesIndex {
  /** The files in the store. More than `rows.length` when the store holds over 1,024. */
  files: number;
  rows: IndexRow[];
}

export function parseIndex(container: Uint8Array): SamplesIndex {
  const body = bodyOf(container, "/samples/index");
  if (body.length < INDEX_HEAD_BYTES) throw new SampleRouteError("/samples/index is shorter than its head");
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  const files = view.getUint32(0);
  const count = view.getUint32(4);
  if (body.length < INDEX_HEAD_BYTES + count * INDEX_ROW_BYTES) {
    throw new SampleRouteError(`/samples/index says ${count} rows and holds ${body.length} bytes`);
  }
  const rows: IndexRow[] = [];
  for (let r = 0; r < count; r++) {
    const at = INDEX_HEAD_BYTES + r * INDEX_ROW_BYTES;
    const field = body.subarray(at + 36, at + 36 + STORE_PATH_MAX + 1);
    const end = field.indexOf(0);
    rows.push({
      id: hex(body.subarray(at, at + ID_BYTES)),
      length: view.getUint32(at + 32),
      path: String.fromCharCode(...field.subarray(0, end < 0 ? field.length : end)),
    });
  }
  return { files, rows };
}

/** The results at `/samples/info` +32, as the contract names them. */
export const RESULT = {
  good: 0,
  resend: 1,
  badRecord: 2,
  notNext: 3,
  busy: 4,
  badSize: 5,
  readOnly: 6,
  absent: 7,
  exists: 8,
  pathTaken: -51,
  noGap: -52,
  cardLost: -57,
  cardRead: -58,
  order: -73,
  foreignStore: -74,
  badLength: -75,
} as const;

/** What a result means, in a sentence for the page. */
export function resultText(result: number): string {
  switch (result) {
    case RESULT.good: return "the part went in";
    case RESULT.resend: return "the transfer failed before the commit";
    case RESULT.badRecord: return "the instrument refused the part record";
    case RESULT.notNext: return "the instrument expected another part";
    case RESULT.busy: return "another upload is open";
    case RESULT.badSize: return "the part or the file has a wrong size";
    case RESULT.readOnly: return "the instrument refused a write to a read-only path";
    case RESULT.absent: return "the store does not hold that id";
    case RESULT.exists: return "the store already holds this sample";
    case RESULT.pathTaken: return "the path is taken or not valid";
    case RESULT.noGap: return "the store has no free gap for the file";
    case RESULT.cardLost: return "the card did not keep the bytes";
    case RESULT.cardRead: return "a card read failed";
    case RESULT.order: return "the store refused the order of the parts";
    case RESULT.foreignStore: return "the card holds a store that this firmware does not write";
    case RESULT.badLength: return "the file is empty or over 64 MiB";
    default: return `result ${result}`;
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(text: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(text) || text.length % 2 !== 0) throw new SampleRouteError(`"${text}" is not lower-case hex`);
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** The SHA-256 of `bytes`, as 64 lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}
