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

/** A window into a directory. Both halves are required — see `listRequest`. */
export interface Page {
  start: number;
  count: number;
}

/**
 * Ask for a directory listing, optionally one page of it.
 *
 * ```
 * 0x53   path\0   [u32 start]   [u32 count]
 * ```
 *
 * **Established on hardware, one field at a time.** A bare path returns everything — 128 projects,
 * 256 sounds. Adding a `u32` came back with `first` echoing the value we sent, which proved the
 * argument encoding; but `count` came back **0**, on two different paths. We had asked for zero
 * entries and the device obliged.
 *
 * Transfer's own traffic says the same from the other side: a 43-byte reply reading
 * `first 28, next 29, count 1` is one entry starting at 28 — a page, which this page's earlier
 * reading mistook for a file stat.
 *
 * **`start` and `count` are taken together, never separately.** A start without a count is a
 * request for nothing, and an API that lets you write that by accident is one you will.
 */
export function listRequest(msgId: number, path: string, page?: Page): Uint8Array {
  const name = string0(path);
  if (!page) return encodeMessage(msgId, StorageCode.List, name);

  const body = new Uint8Array(name.length + 8);
  body.set(name, 0);
  body.set(u32Bytes(page.start), name.length);
  body.set(u32Bytes(page.count), name.length + 4);
  return encodeMessage(msgId, StorageCode.List, body);
}

/**
 * Open a project for reading, **by id rather than by path**.
 *
 * The device said so itself. Sent a path, `0x54` answered **`invalid project id`** — not
 * `Invalid path`, which is what `0x53` says. It had parsed the message, recognised the code, and
 * objected to the *kind* of argument. A more useful error than most documentation.
 *
 * So the two halves of this API address differently: `0x53` browses a tree by path, `0x54` opens a
 * project by its slot — the `index` a `/projects` listing gives, 1-based, matching the numbers in
 * the user's own filenames (`002 MORNING_JAM.dnprj` is id 2).
 *
 * The width is inferred from the reply, `01 00 00 00 01 …`, which reads as status plus a u32.
 */
export function openRequest(
  msgId: number,
  projectId: number,
  acknowledge?: typeof FREEZES,
  body: OpenBody = "id+chunk",
): Uint8Array {
  if (acknowledge !== FREEZES) throw new ListingError(FREEZE_WARNING);
  if (!Number.isInteger(projectId) || projectId < 0) {
    throw new ListingError(`project id ${projectId} is not a slot number`);
  }
  if (body === "id") return encodeMessage(msgId, StorageCode.Open, u32Bytes(projectId));

  const out = new Uint8Array(9);
  out.set(u32Bytes(projectId), 0);
  out.set(u32Bytes(DEFAULT_CHUNK_SIZE), 4);
  out[8] = 1;
  return encodeMessage(msgId, StorageCode.Open, out);
}

/**
 * Which guess at `0x54`'s argument list to send.
 *
 * - `id` — four bytes, the projectId alone. **This is the shape that froze a Digitone 1.**
 * - `id+chunk` — `u32 id, u32 chunkSize, u8 1`, mirroring the reply. The default; see below.
 *
 * Selectable rather than hardcoded because these two are an **experiment**, and an experiment whose
 * arms cannot both be run tells you nothing about which arm mattered.
 */
export type OpenBody = "id" | "id+chunk";

/** Every open reply Transfer received answered 2,048, on three different files. */
export const DEFAULT_CHUNK_SIZE = 2048;

/**
 * **`0x54` froze a Digitone 1 twice, 2026-07-30.**
 *
 * A well-formed open with a valid project id — `2`, `MORNING_JAM`, straight out of a `/projects`
 * listing — and the device stopped responding entirely. The capture is **0 bytes**: not a slow
 * reply, not an error, nothing at all. Only a power cycle recovers it, and anything unsaved in the
 * active project goes with it.
 *
 * ## The first explanation, which was probably wrong
 *
 * *"`0x54` allocates a handle and we never sent `0x56` to release it."* That is true, and it was
 * worth fixing — `storagesession.ts` now guarantees the close — but as an account of the freeze it
 * **does not fit the evidence**. A leaked handle does not kill a device on the first allocation,
 * and it certainly does not swallow the reply: we saw *no answer at all*, and Transfer's own open
 * answers in ten bytes every time.
 *
 * ## The better one, from Transfer's replies — 2026-07-30
 *
 * The reply is `u8 ok, u32 handle, u32 2048, u8 1`. That middle field is a **chunk size**: 2,048 on
 * all three opens in the capture, across a manifest, a sound and a project. An API that reports a
 * chunk size back is very likely one you *asked* for a chunk size.
 *
 * Which makes the shape of the failure fit: the device answered our **path** with `invalid project
 * id` — parsed, understood, argument rejected — and then answered our **four-byte** body with
 * silence and death. That is what reading past the end of a short message looks like. Our body was
 * probably five bytes short, not merely unaccompanied by a close.
 *
 * So `id+chunk` is the default, `id` is kept so the experiment can be run both ways, and this stays
 * gated either way, because both explanations are still hypotheses.
 *
 * ## Why a hard gate rather than a warning
 *
 * `docs/device-probing.md` classified messages as read, write, delete or state-change. **Hanging
 * the instrument was not a category**, and a control that reliably requires a power cycle should
 * not be one press away from a page that also does harmless things.
 *
 * The token exists so that sending this is a deliberate act by someone who has read the above.
 * `storagesession.ts` is the intended holder: it is the only caller that can promise the close.
 */
export const FREEZES = Symbol("0x54 froze a Digitone 1 — see openRequest");

const FREEZE_WARNING =
  "0x54 (open) froze a Digitone 1 twice — recoverable only by a power cycle, which takes anything " +
  "unsaved in the active project with it. Two explanations are live: a leaked handle (we never " +
  "sent 0x56) and a short request body (the reply's chunk-size field suggests the request carries " +
  "one). Go through readStoredFile in storagesession.ts, which guarantees the close, or pass the " +
  "FREEZES token to say you have read this and accept a reboot.";

/** Close a handle. The reply was 9 bytes; the request shape is inferred from the handle's width. */
export function closeRequest(msgId: number, handle: number): Uint8Array {
  return encodeMessage(msgId, StorageCode.Close, u32Bytes(handle));
}

export interface OpenResult {
  /** The handle a read and a close refer to. Counts up from 1 per open. */
  handle: number;
  /**
   * Bytes the device will send per chunk. **2,048 in every sample.**
   *
   * Read as a chunk size because the read replies confirm it from the other side: every full chunk
   * carries exactly this many bytes and the last carries fewer. Three opens, three files of very
   * different sizes, same value — so it is a transfer parameter, not a property of the file.
   */
  chunkSize: number;
  /** The trailing byte, `1` in every sample. Unidentified. */
  flag: number;
}

/**
 * Decode an open reply.
 *
 * A failure is `00` followed by the device's own sentence — `Error: Could not resolve …` was the
 * one observed — so the message is handed back rather than replaced with ours. The device explains
 * itself better than a generic error does, which is how `invalid project id` taught us the argument
 * type in the first place.
 */
export function parseOpen(body: Uint8Array): OpenResult {
  refuseFailure(body, "open");
  if (body.length < 10) throw new ListingError(`open reply is ${body.length} bytes, expected 10`);
  return { handle: u32(body, 1), chunkSize: u32(body, 5), flag: body[9]! };
}

/**
 * Ask for the next chunk of an open file.
 *
 * ```
 * 0x55   u32 handle
 * ```
 *
 * **The request is inferred; the reply is not.** Reads are sequential and the device numbers the
 * chunks itself — 1, 2, 3 … in `parseRead`'s `index`, verified across a 22-chunk project — so a
 * handle is the only argument the sequence demonstrably needs. If the device wants the index too,
 * this is where it goes, and the symptom will be an error rather than a wrong range: the reply
 * states its own index and `readStoredFile` checks it.
 */
export function readRequest(msgId: number, handle: number): Uint8Array {
  return encodeMessage(msgId, StorageCode.Read, u32Bytes(handle));
}

/** One chunk of a file coming off the +Drive. */
export interface Chunk {
  handle: number;
  /**
   * The device's own chunk number, **1-based**.
   *
   * Meaningful only when `data` is non-empty. The first reply to every read sequence carries no
   * data and puts something else entirely in this field — see `metadata`.
   */
  index: number;
  /**
   * **The end of the file, stated by the device.** The only reliable one.
   *
   * A short chunk is *not* a terminator: the manifest read came back in one chunk of 129 bytes with
   * this set, and a 22-chunk project ran 21 full chunks and a short one. Stopping on a short read
   * would have worked on the second and truncated the first.
   */
  last: boolean;
  data: Uint8Array;
  /**
   * True for the leading zero-length reply that starts every read sequence.
   *
   * Three samples, and its `index` and checksum fields carry values that fit no pattern the data
   * chunks follow — `0x4012c344` in both, constant across a manifest, a sound and a project, with
   * a second word that varies per file. **Unidentified.** Reading it as a chunk index would produce
   * confident nonsense, so it is flagged and skipped instead. `header` has the raw bytes for
   * whoever solves it.
   */
  metadata: boolean;
  /** Bytes 5–17 exactly as they arrived: index, an unidentified word, the flag, and a checksum. */
  header: Uint8Array;
}

/**
 * Decode a read reply.
 *
 * ```
 *  0  u8   ok
 *  1  u32  handle
 *  5  u32  chunk index, 1-based
 *  9  u32  unidentified — climbs to exactly 1000 on the last chunk
 * 13  u8   1 on the final chunk
 * 14  u32  unidentified — plausibly a checksum; 0xffffffff on the metadata reply
 * 18  u32  data length
 * 22  …    the data
 * ```
 *
 * **[verified]** on all 27 read replies in Elektron Transfer's own capture: the declared length
 * matches the payload every time, and the flag at 13 fires exactly once per file, on its last
 * chunk. The two unidentified words are carried through rather than named.
 */
export function parseRead(body: Uint8Array): Chunk {
  refuseFailure(body, "read");
  if (body.length < READ_HEADER) {
    throw new ListingError(`read reply is ${body.length} bytes, too short for a ${READ_HEADER}-byte header`);
  }

  const declared = u32(body, 18);
  const data = body.subarray(READ_HEADER);
  // Checked, because the length and the payload are two independent statements of the same fact,
  // and a chunk that is quietly short is how a truncated project gets assembled with nobody the
  // wiser until the device refuses it weeks later. `api.ts` checks the same thing for the same
  // reason.
  if (declared !== data.length) {
    throw new ListingError(`chunk claims ${declared} bytes and carries ${data.length}`);
  }

  return {
    handle: u32(body, 1),
    index: u32(body, 5),
    last: body[13] === 1,
    data,
    metadata: declared === 0,
    header: body.subarray(5, READ_HEADER),
  };
}

const READ_HEADER = 22;

/**
 * A `0` status byte, followed by the device saying why in Windows-1252.
 *
 * Shared by open and read because both answer this way, and the device's own wording is more
 * informative than anything this module could substitute — `invalid project id` is what told us
 * `0x54` takes a slot rather than a path.
 */
function refuseFailure(body: Uint8Array, what: string): void {
  if (body.length === 0) throw new ListingError(`${what} reply is empty`);
  if (body[0] === 1) return;
  const text = new TextDecoder("windows-1252").decode(body.subarray(1)).replace(/\0+$/, "").trim();
  throw new ListingError(text.length > 0 ? text : `${what} failed with status ${body[0]}`);
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
