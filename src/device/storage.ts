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

/**
 * Open a file for reading.
 *
 * **A guess, but the best-evidenced one available.** `0x53` takes a bare NUL-terminated path and
 * that is now proven on hardware, so the same encoding is the obvious shape for `0x54`. Nothing
 * else about this message is known: Transfer's request was never visible, only its 10-byte reply.
 *
 * `0x53` refuses a file path — `/soundbanks/A/DIGIT-ONE` answers `Invalid path` — which is correct
 * behaviour for a *directory* listing and is why files need their own message.
 */
export function openRequest(msgId: number, path: string): Uint8Array {
  return encodeMessage(msgId, StorageCode.Open, string0(path));
}

/** Close a handle. The reply was 9 bytes; the request shape is inferred from the handle's width. */
export function closeRequest(msgId: number, handle: number): Uint8Array {
  return encodeMessage(msgId, StorageCode.Close, u32Bytes(handle));
}

export interface OpenResult {
  /** The handle a read and a close would refer to. */
  handle: number;
  /**
   * The remaining eight bytes, undecoded.
   *
   * The only sample is `01 00 00 00 01 00 00 08 00 01` — status, a handle of 1, then five bytes
   * whose meaning is unestablished. `0x00000800` reads as 2,048 and could be a chunk size, but one
   * sample cannot distinguish that from a coincidence, and a plausible wrong reading of a length
   * field is how a file gets truncated.
   */
  rest: Uint8Array;
}

/**
 * Decode an open reply.
 *
 * Deliberately shallow: it extracts the handle, which is the one field the sequence cannot proceed
 * without, and hands the rest back unread. Everything else here is one observation deep.
 */
export function parseOpen(body: Uint8Array): OpenResult {
  const text = new TextDecoder("windows-1252").decode(body).replace(/\0+$/, "");
  if (text.includes("Invalid path")) throw new ListingError("Invalid path");
  if (body.length < 5) throw new ListingError(`open reply is ${body.length} bytes, expected at least 5`);
  if (body[0] !== 1) throw new ListingError(`open status byte is ${body[0]}, expected 1`);
  return { handle: u32(body, 1), rest: body.subarray(5) };
}

function u32Bytes(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
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

    // Two bytes after the name, and **they are two independent fields** — which the first version
    // of this parser missed, because the only two samples it had happened to make them look like
    // one 16-bit tag.
    //
    // `/soundbanks` is what showed it: its entries are directories carrying `01 02`, so a parser
    // that knew only `0101` and `0002` refused a perfectly good listing. It refused *loudly* and
    // handed over the bytes, which is the one part of this that went right.
    if (at + 2 > body.length) throw new ListingError(`entry "${name}" is truncated`);
    const isDirectory = body[at] === 1;
    const layout = body[at + 1]!;
    at += 2;

    if (layout === SHORT) {
      // Only a child count. Seen on the two roots, `projects` and `soundbanks`.
      if (at + 4 > body.length) throw new ListingError(`entry "${name}" is truncated`);
      entries.push({ name, kind: "directory", index: i + first, children: u32(body, at) });
      at += 4;
    } else if (layout === LONG) {
      // Index, size and two unidentified bytes. Used by files **and** by bank directories, whose
      // "size" is a fixed 262,144 — an allocation, the way each project's is a fixed 4 MiB.
      if (at + 12 > body.length) throw new ListingError(`entry "${name}" is truncated`);
      entries.push({
        name,
        kind: isDirectory ? "directory" : "file",
        index: u32(body, at),
        size: u32(body, at + 4),
        unknown: (body[at + 8]! << 8) | body[at + 9]!,
      });
      at += 12;
    } else {
      throw new ListingError(
        `entry "${name}" declares layout 0x${layout.toString(16).padStart(2, "0")}, which is ` +
          `neither short (0x${SHORT.toString(16)}) nor long (0x${LONG.toString(16)})`,
      );
    }
  }

  return { entries, first, next, complete: next <= first + entries.length && entries.length < 256 };
}

/** `01` + first + next + count. */
const HEADER = 13;

/**
 * The second byte after a name selects the trailer's **layout**, independently of the first, which
 * says whether the entry is a directory.
 *
 * | | first | second | seen on |
 * |---|---|---|---|
 * | root directory | `01` | `01` short | `projects`, `soundbanks` |
 * | bank directory | `01` | `02` long | `/soundbanks/A`…`H` |
 * | file | `00` | `02` long | sounds, projects |
 *
 * Reading them as one 16-bit tag worked for exactly as long as only two of those three had been
 * seen — which is a good argument for decoding fields as fields.
 */
const SHORT = 0x01;
const LONG = 0x02;

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
