/**
 * The Digitone's +Drive, as a directory of projects and sound banks.
 *
 * `docs/device-storage.md` has the derivation. The short version: a Digitone *does* implement a
 * path-based file API — it just does not use the codes elk-herd uses for the Digitakt. This is the
 * client for it.
 *
 * ## What is known, and what is a guess
 *
 * **The responses are [verified]**, decoded from a capture of Elektron's own Transfer application
 * talking to a Digitone 1. Every field in `parseListing` was read off real bytes.
 *
 * **The requests are inferred.** Web MIDI let us listen on the input while Transfer held the ports,
 * so we saw the device's half of every exchange and never Transfer's. What goes *out* is a
 * reconstruction from two things: the response's shape, and the fact that this API's other
 * messages — `Device`, `Version`, `DirList` — take their arguments as a NUL-terminated
 * Windows-1252 string with no framing (`api.ts`'s `string0`).
 *
 * That guess is cheap to be wrong about. **The device answers a bad path with `Invalid path`**, in
 * as many words, which is about as forgiving as a failure mode gets — and it is a *read*, so being
 * wrong costs a round trip and nothing else.
 *
 * ## Why this matters more than the dump protocol
 *
 * A listing carries each entry's **index** in a 32-bit field. The dump protocol's object number is
 * seven bits, which is why a bank of more than 128 loses its numbering and a bulk dump can only be
 * reassembled by send order (§5c). Nothing here has that problem: positions are stated, they are
 * wide, and they survive holes.
 */

import { ApiError, encodeMessage } from "./api.js";

/** Request codes, each paired with the response `+0x80` that was observed. */
export const StorageCode = {
  /** Directory listing. Answers `Invalid path` when the path is wrong. */
  List: 0x53,
  /** Open a file for reading. */
  Open: 0x54,
  /** Read a chunk. */
  Read: 0x55,
  /** Close. */
  Close: 0x56,
} as const;

export type StorageCode = (typeof StorageCode)[keyof typeof StorageCode];

/** The two roots a Digitone 1 reported. */
export const ROOTS = ["projects", "soundbanks"] as const;

/**
 * Ask for a directory listing.
 *
 * `start` is the index to resume from — a listing is paginated and its response carries the cursor
 * for the next page. Sent only when non-zero, because the simplest shape is the likeliest to be
 * right and an unrecognised trailing field is a good way to get `Invalid path` for a valid path.
 */
export function listRequest(msgId: number, path: string, start = 0): Uint8Array {
  const name = string0(path);
  if (start === 0) return encodeMessage(msgId, StorageCode.List, name);

  const body = new Uint8Array(name.length + 4);
  body.set(name, 0);
  body[name.length] = (start >>> 24) & 0xff;
  body[name.length + 1] = (start >>> 16) & 0xff;
  body[name.length + 2] = (start >>> 8) & 0xff;
  body[name.length + 3] = start & 0xff;
  return encodeMessage(msgId, StorageCode.List, body);
}

export class ListingError extends Error {}

export type EntryKind = "directory" | "file";

export interface Entry {
  name: string;
  kind: EntryKind;
  /** Position in the directory. **32-bit**, so unaffected by the dump protocol's 7-bit limit. */
  index: number;
  /** Bytes, for a file. A DN1 sound reads 302, which is how the format was recognised. */
  size?: number;
  /** Children, for a directory. */
  children?: number;
  /**
   * Two bytes whose meaning is unestablished — `0x0012` and `0x007e` on two sounds.
   *
   * **Hypothesis: the sound's tag bitmask**, which `src/project/tags.ts` already models. Carried
   * through rather than interpreted, because a plausible wrong reading of a field is worse than an
   * honest unknown one.
   */
  unknown?: number;
}

export interface Listing {
  entries: Entry[];
  /** Index of the first entry in this page. */
  first: number;
  /** Where a following request resumes. Equal to `first + entries.length` in every sample. */
  next: number;
  /** True when `next` is past the end — i.e. this is the last page. */
  complete: boolean;
}

/**
 * Decode a listing response body.
 *
 * Refuses rather than guesses on anything it does not recognise. A directory listing is the thing
 * a project browser is built on, and an entry decoded wrongly is a project opened from the wrong
 * slot — which is exactly the class of mistake this codebase keeps paying for.
 */
export function parseListing(body: Uint8Array): Listing {
  // The device says so in as many words when the path is wrong. Recognised explicitly so a caller
  // reports the device's own message rather than "malformed response".
  const text = new TextDecoder("windows-1252").decode(body).replace(/\0+$/, "");
  if (text.includes("Invalid path")) throw new ListingError("Invalid path");

  if (body.length < HEADER) {
    throw new ListingError(`listing is ${body.length} bytes, too short for a ${HEADER}-byte header`);
  }
  if (body[0] !== 1) throw new ListingError(`listing status byte is ${body[0]}, expected 1`);

  const first = u32(body, 1);
  const next = u32(body, 5);
  const count = u32(body, 9);

  const entries: Entry[] = [];
  let at = HEADER;
  for (let i = 0; i < count; i++) {
    const end = body.indexOf(0, at);
    if (end === -1) throw new ListingError(`entry ${i} has no terminated name`);
    const name = new TextDecoder("windows-1252").decode(body.subarray(at, end));
    at = end + 1;

    // The two bytes after the name say what kind of entry it is. Only two kinds have been seen, so
    // anything else is refused rather than assumed to be a file.
    if (at + 2 > body.length) throw new ListingError(`entry "${name}" is truncated`);
    const kindMark = (body[at]! << 8) | body[at + 1]!;
    at += 2;

    if (kindMark === DIRECTORY) {
      if (at + 4 > body.length) throw new ListingError(`directory "${name}" is truncated`);
      entries.push({ name, kind: "directory", index: i + first, children: u32(body, at) });
      at += 4;
    } else if (kindMark === FILE) {
      if (at + 12 > body.length) throw new ListingError(`file "${name}" is truncated`);
      entries.push({
        name,
        kind: "file",
        index: u32(body, at),
        size: u32(body, at + 4),
        unknown: (body[at + 8]! << 8) | body[at + 9]!,
      });
      at += 12;
    } else {
      throw new ListingError(
        `entry "${name}" has kind 0x${kindMark.toString(16).padStart(4, "0")}, which is neither ` +
          `directory (0x${DIRECTORY.toString(16)}) nor file (0x${FILE.toString(16)})`,
      );
    }
  }

  return { entries, first, next, complete: next <= first + entries.length && entries.length < 256 };
}

/** `01` + first + next + count. */
const HEADER = 13;

/** The two bytes after a name. Directories carry a child count, files an index and a size. */
const DIRECTORY = 0x0101;
const FILE = 0x0002;

function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

/**
 * A NUL-terminated Windows-1252 string, the way every other argument in this API is encoded.
 *
 * Duplicated from `api.ts` rather than exported from it, because that copy is private and this
 * module has no business widening another module's surface to borrow four lines. If a third caller
 * appears, promote it then.
 */
function string0(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else throw new ApiError(`"${ch}" is not encodable for a device path`);
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}
