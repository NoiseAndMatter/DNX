/**
 * The Digitone's +Drive, as a directory of projects and sound banks.
 *
 * `docs/device-storage.md` has the derivation. The short version: a Digitone *does* implement a
 * path-based file API — it just does not use the codes elk-herd uses for the Digitakt. This is the
 * client for it.
 *
 * ## What is known, and what is a guess
 *
 * **Both halves are now [verified].** The responses were decoded first, from a capture of Elektron's
 * own Transfer application talking to a Digitone 1 over MIDI. The **requests** were read off a
 * **USB capture** on 2026-07-30 — Wireshark and USBPcap, below the MIDI layer, where Transfer's
 * side of the conversation is visible for the first time.
 *
 * That matters more than it sounds. Everything here up to that point had been reconstructed from
 * replies, and the reconstruction was wrong about `0x54` three times — each wrong version froze the
 * instrument — and wrong about `0x55` twice. The capture settled every one of them in a minute.
 *
 * What the requests turned out to be is recorded on each function, with the bytes.
 *
 * ## What is still guessed
 *
 * - **The write checksum's algorithm** (`writeChunkRequest`). The field is identified; the function
 *   that produces it is not.
 * - **`0x54`'s trailing byte** — Transfer sends `01`, and the same read without it returned a very
 *   different file.
 * - **Which bit of the permission mask is which** (`Entry.permissions`).
 *
 * ## Why this matters more than the dump protocol
 *
 * A listing carries each entry's **index** in a 32-bit field. The dump protocol's object number is
 * seven bits, which is why a bank of more than 128 loses its numbering and a bulk dump can only be
 * reassembled by send order (§5c). Nothing here has that problem: positions are stated, they are
 * wide, and they survive holes.
 */

import { ApiError, encodeMessage } from "./api.js";
import { crc32ZeroInit } from "../project/checksum.js";

/** Request codes, each paired with the response `+0x80` that was observed. */
export const StorageCode = {
  /** Directory listing. Answers `Invalid path` when the path is wrong. */
  List: 0x53,
  /** Open a file for reading. */
  Open: 0x54,
  /** Read a chunk by sequence number. */
  Read: 0x55,
  /** Close a reader. Its reply carries the file's total length. */
  Close: 0x56,
  /** Open a file for **writing**, declaring the total length up front. */
  WriteOpen: 0x57,
  /** Write a chunk. */
  Write: 0x58,
  /** Close a writer — this is the commit. */
  WriteClose: 0x59,
  /** **Move.** Source and destination paths, both with a trailing slash. */
  Move: 0x5a,
  /** **Copy.** Same arguments as a move. */
  Copy: 0x5b,
  /** **Delete.** One path, trailing slash. */
  Delete: 0x5c,
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
 * Open a stored file for reading, **by path**.
 *
 * ```
 * 0x54   path\0
 * ```
 *
 * ## The three attempts, which only make sense together
 *
 * | Body | NUL-terminated | Device |
 * |---|---|---|
 * | `path\0` | **yes** | answered `invalid project id` |
 * | `u32 id` | no | **froze** |
 * | `u32 id, u32 2048, u8 1` | no | **froze** |
 *
 * Three attempts, and the freeze tracks **the missing terminator**, not the length or the content.
 * That is what a string parse running off the end of a buffer looks like: the handler reads a
 * NUL-terminated argument the way every other message in this API does, finds no NUL, and walks
 * until something gives.
 *
 * ## And the error message was misread, which is how we got here
 *
 * `invalid project id` was taken as *"the argument should be an id, not a path"* — and it was
 * written down as the device naming its own argument type, *"a more useful error than most
 * documentation"*. **It says nothing of the kind.** It says the path resolved to no valid project,
 * which is exactly right for the path we sent: the probe reused whatever was in the listing box,
 * and that was `/projects` — a **directory**.
 *
 * So a graceful, accurate error was read as an invitation to change the argument type, and changing
 * it cost two power cycles.
 *
 * > **An error names what failed, not what was wanted.** `0x53` says `Invalid path` when it cannot
 * > *parse* a path and `0x54` says `invalid project id` when it cannot *resolve* one — two stages of
 * > the same string argument, not two argument types.
 *
 * Still gated, because two hypotheses have now been wrong and this is the third.
 */
export function openRequest(
  msgId: number,
  path: string,
  acknowledge?: typeof FREEZES,
  chunkSize = DEFAULT_CHUNK_SIZE,
  form?: typeof STORED_FORM,
): Uint8Array {
  if (acknowledge !== FREEZES) throw new ListingError(FREEZE_WARNING);
  // Refused here rather than sent, because "no NUL" is the one property both freezes share and an
  // empty argument is the shortest way to write it.
  if (path.length === 0) throw new ListingError("0x54 needs a path — an empty one is what froze it");

  // **The chunk size is asked for, not announced.** The open reply's second field read 2,048 on all
  // three of Transfer's opens and **16** on ours, which sank it as a constant and then explained
  // itself: Transfer *requests* 2,048 and we requested nothing, so we got a 16-byte default. At 16
  // bytes a chunk a Digitone 1's 4 MiB project slot is 262,144 messages, which is precisely the
  // runaway that followed.
  //
  // Safe to append: the path's NUL is already on the wire, so this cannot recreate the unterminated
  // body that froze the device three times. Inferred, like everything else about this request.
  const name = string0(path);
  // **The trailing byte is omitted, and that is now a measured decision rather than an oversight.**
  //
  // Sending Transfer's `01` was tried and it changes what comes back: `/projects/1` returned 40
  // chunks and ~90 KB — the stored `.dnprj` payload — where omitting the byte returns 1,358 chunks
  // and 2,781,743 bytes, the raw uncompressed image.
  //
  // DNX wants the raw form. It is byte-for-byte identical to the image `decodeProjectImage`
  // produces from the file (`test/drive.test.ts`), so there is no LZ4 step and nothing to get
  // wrong. The compressed form would have to be decompressed to be useful, and `imageFrom` refuses
  // it outright rather than slicing 31 bytes off something that is not an image.
  //
  // `form` exists so the other behaviour is reachable — a caller wanting a `.dnprj` to save to disk
  // wants exactly what Transfer asks for.
  const trailer = form === undefined ? 0 : 1;
  const body = new Uint8Array(name.length + 4 + trailer);
  body.set(name, 0);
  body.set(u32Bytes(chunkSize), name.length);
  if (form !== undefined) body[name.length + 4] = form;
  return encodeMessage(msgId, StorageCode.Open, body);
}

/**
 * The trailing byte of an open-for-read — **[verified]** to select the file's form.
 *
 * | request | `/projects/1` returned |
 * |---|---|
 * | path, chunk size, **`01`** | 40 chunks, ~90 KB — the stored `.dnprj` payload |
 * | path, chunk size, **byte absent** | 1,358 chunks, **2,781,743 bytes** — the raw image |
 *
 * Transfer sends `01`. DNX omits it, because the raw image is byte-for-byte what
 * `decodeProjectImage` produces from the file and needs no decompression.
 *
 * What a literal `00` does is still untested — omitting a byte and sending a zero are not the same
 * thing, and this file has paid for that distinction before.
 */
export const STORED_FORM = 0x01;

/**
 * The two bodies that froze a Digitone 1, kept so nobody rediscovers them.
 *
 * **Not exported as something to send.** They exist to be named in the documentation and in the
 * probe's dropdown as *"this is the one that froze it"*, which is worth more than deleting them —
 * a deleted experiment gets re-run.
 */
export function frozenOpenBodies(projectId: number): { id: Uint8Array; idChunk: Uint8Array } {
  const idChunk = new Uint8Array(9);
  idChunk.set(u32Bytes(projectId), 0);
  idChunk.set(u32Bytes(DEFAULT_CHUNK_SIZE), 4);
  idChunk[8] = 1;
  return { id: u32Bytes(projectId), idChunk };
}

/** Every open reply Transfer received answered 2,048, on three different files. */
export const DEFAULT_CHUNK_SIZE = 2048;

/**
 * **`0x54` froze a Digitone 1 three times, 2026-07-30.**
 *
 * A well-formed open with a valid project id — `2`, `MORNING_JAM`, straight out of a `/projects`
 * listing — and the device stopped responding entirely. The capture is **0 bytes**: not a slow
 * reply, not an error, nothing at all. Only a power cycle recovers it, and anything unsaved in the
 * active project goes with it.
 *
 * ## Three explanations, in the order they were believed
 *
 * **1. A leaked handle.** *"`0x54` allocates and we never sent `0x56`."* True, and worth fixing —
 * `storagesession.ts` now guarantees the close — but it never fit: a leak does not kill a device on
 * the **first** allocation, and it does not swallow the reply. We saw no answer at all, while
 * Transfer's open answers in ten bytes every time.
 *
 * **2. A short body.** The reply carries a chunk size of 2,048, so perhaps the request supplies
 * one. Sent `u32 id, u32 2048, u8 1`. **It froze the device again** — so length is not it either.
 *
 * **3. The missing NUL** — the one the evidence actually supports. See `openRequest`: the only body
 * the device ever answered was the NUL-terminated path, and both bodies that killed it were raw
 * integers with no terminator.
 *
 * Two wrong diagnoses cost two power cycles, and both were wrong the same way: **a hypothesis was
 * recorded as a finding.** Number three is a hypothesis too.
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
  "0x54 (open) froze a Digitone 1 three times — recoverable only by a power cycle, which takes " +
  "anything unsaved in the active project with it. Every body that froze it was a raw integer with " +
  "no NUL terminator; the only body it ever answered was a NUL-terminated path. Send a path, go " +
  "through readStoredFile in storagesession.ts, and pass the FREEZES token to say you have read " +
  "this and accept a reboot.";

/**
 * Close a reader.
 *
 * `0x56  u32 handle` — **[verified]** against Transfer's own request. Its reply carries the file's
 * **total length**, which is how Transfer learns a size without reading the file: `parseClose`.
 */
export function closeRequest(msgId: number, handle: number): Uint8Array {
  return encodeMessage(msgId, StorageCode.Close, u32Bytes(handle));
}

/** What a close reply says. */
export interface CloseResult {
  handle: number;
  /** The file's total length in bytes — 129 for a sound's `.metadata`, 269 for a sound. */
  length: number;
}

export function parseClose(body: Uint8Array): CloseResult {
  refuseFailure(body, "close");
  if (body.length < 9) throw new ListingError(`close reply is ${body.length} bytes, expected 9`);
  return { handle: u32(body, 1), length: u32(body, 5) };
}

// --- writing ------------------------------------------------------------------------------------
//
// **[verified]** from Elektron Transfer's own requests, captured over USB on 2026-07-30. Every
// field below was read off the wire rather than inferred from a reply, which makes this the first
// part of the storage API that was not guessed at.
//
// The write mirrors the read exactly: open, chunk, close. The close is the commit.

/**
 * Open a file for writing, **declaring its total length up front**.
 *
 * ```
 * 0x57   u32 totalLength   path\0
 * ```
 *
 * The length comes first, which is not where anyone would put it, and is the sort of detail that
 * would have cost an afternoon to guess. Transfer's upload of an 18,064-byte project:
 *
 * ```
 * 00 00 46 90  2f 70 72 6f 6a 65 63 74 73 2f 35 36 00
 * 18,064       /projects/56\0
 * ```
 *
 * **No trailing slash**, unlike the mutations. The reply is `01` and a handle.
 *
 * > **This overwrites.** The device refuses when the destination is write-protected — that is what
 * > `Slot 29 already taken` is — but an ordinary occupied slot is fair game, and for most people
 * > the +Drive is the only copy of that work. Check `Entry.writable` *and* `Entry.occupied` first.
 */
export function writeOpenRequest(msgId: number, path: string, totalLength: number): Uint8Array {
  if (path.length === 0) throw new ListingError("0x57 needs a path");
  const name = string0(path);
  const body = new Uint8Array(4 + name.length);
  body.set(u32Bytes(totalLength), 0);
  body.set(name, 4);
  return encodeMessage(msgId, StorageCode.WriteOpen, body);
}

/**
 * Write one chunk.
 *
 * ```
 * 0x58   u32 handle   u32 chunkIndex   u32 checksum   u32 chunkSize   data
 * ```
 *
 * ## Two fields were wrong, and one chunk could never show it
 *
 * **[verified] 2026-08-15** from a USBPcap capture of Transfer uploading a real Digitone II
 * project — `MORNING_JA 1640(2)`, 114,746 bytes, to `/projects/12`:
 *
 * ```
 * 0x57 open   totalLength 114,746   /projects/12
 * 0x58 chunk  handle 14   index 0   checksum 0xcfb63302   chunkSize 32,768
 * 0x58 chunk  handle 14   index 1   checksum 0xc41fcad1   chunkSize 32,768
 * 0x58 chunk  handle 14   index 2   checksum 0x6e276d0e   chunkSize 32,768
 * 0x59 commit handle 14   flag 1
 * ```
 *
 * The replies carry **cumulative bytes written** — 32,768, 65,536, 98,304, 114,746 — so there were
 * four chunks with the last one partial, and the capture simply lost a request.
 *
 * This module used to call field 2 an **offset** and field 4 the **total length**. Both are wrong:
 *
 * | | was | is |
 * |---|---|---|
 * | +4 | byte offset — 0, 2,048, 4,096 | **chunk index** — 0, 1, 2, 3 |
 * | +12 | the whole file's length | **this chunk's own length** — 32,768 for a full one |
 *
 * **At one chunk both mistakes are invisible.** A byte offset and a chunk index are both `0`, and
 * the chunk size equals the file length. Every capture we had was a single chunk — a 269-byte sound
 * and an 18,064-byte file — so the code agreed with the wire in the one case that cannot tell them
 * apart, and every multi-chunk write was refused with `Invalid package checksum; corrupt transfer`.
 * That is the **third** time these fields have hidden behind a single chunk; the checksum's
 * per-chunk meaning was the first.
 *
 * It was predictable from the read side, which has always been numbered: `readRequest` asks for a
 * sequence, and the device rejects a byte range with `Invalid sequence number`. The write side is
 * numbered the same way, and nobody checked.
 *
 * ## The checksum is per chunk
 *
 * Three chunks, three distinct values. It is the same field the *read* reply carries at offset 14 —
 * the sound Transfer uploaded to `/soundbanks/C/29` declared `cb 49 92 19` and reading it back
 * reported `cb 49 92 19` — and `driveChecksum` reproduces each one over that chunk's own slice.
 */
export function writeChunkRequest(
  msgId: number,
  handle: number,
  /** Which chunk this is, counting from zero. **Not a byte offset** — see above. */
  chunkIndex: number,
  /** This chunk's own `driveChecksum`, not the whole file's. */
  checksum: number,
  /**
   * **This chunk's own data length.**
   *
   * Measured 2026-08-15: a short final chunk declaring the transfer's nominal size is refused with
   * `Invalid package checksum; corrupt transfer`, and declaring its real length is accepted. One
   * rule covers every observation — Transfer's full chunks declared 32,768 because that was their
   * length, its single-chunk uploads declared 269 and 18,064, and our own landed write declared
   * 10,795.
   */
  chunkSize: number,
  data: Uint8Array,
): Uint8Array {
  const body = new Uint8Array(16 + data.length);
  body.set(u32Bytes(handle), 0);
  body.set(u32Bytes(chunkIndex), 4);
  body.set(u32Bytes(checksum), 8);
  body.set(u32Bytes(chunkSize), 12);
  body.set(data, 16);
  return encodeMessage(msgId, StorageCode.Write, body);
}

/**
 * The chunk size Transfer uses for an upload, and therefore one the device is known to accept.
 *
 * **Deliberately not `DEFAULT_CHUNK_SIZE`.** That one is the size a *read* asks for in `0x54`, and
 * the two directions do not use the same number: reads run at 2,048 and the captured upload ran at
 * 32,768. Naming them apart stops a later tidy-up from merging them into one constant that is
 * silently wrong for one direction.
 */
export const WRITE_CHUNK_SIZE = 32_768;

/**
 * Close a writer. **This is the commit** — nothing lands until it is sent.
 *
 * ```
 * 0x59   u32 handle   u32 1
 * ```
 *
 * The trailing word was `1` in both captured uploads. Whether it is a commit flag, and whether `0`
 * would abandon the write instead, is unestablished — which would be worth knowing, because an
 * abort is exactly what a failed transfer should send.
 */
export function writeCloseRequest(msgId: number, handle: number, commit = 1): Uint8Array {
  const body = new Uint8Array(8);
  body.set(u32Bytes(handle), 0);
  body.set(u32Bytes(commit), 4);
  return encodeMessage(msgId, StorageCode.WriteClose, body);
}

// --- moving, copying, deleting -------------------------------------------------------------------

/**
 * Move, copy and delete — **[verified]**, and confirmed by the user against what they actually did.
 *
 * ```
 * 0x5a   src\0  dst\0        move
 * 0x5b   src\0  dst\0        copy
 * 0x5c   path\0              delete
 * ```
 *
 * All three answer a single `01`.
 *
 * The attribution is not read off the bytes — a move and a copy look identical on the wire — but
 * off two independent sequences that each only make sense one way. Projects: `0x5b` 55→56 then
 * `0x5c` 56, which is a copy and then cleaning the copy up; then `0x5a` 55→56 and immediately
 * 56→55, which is a move tested there and back. Sounds: the same shape on `/soundbanks/C/29` and
 * `/30`. The user then confirmed the order.
 *
 * **The paths carry a trailing slash** — `/projects/55/`, not `/projects/55` — which the read and
 * write opens do not. Two conventions in one API, and the sort of thing that answers `Could not
 * resolve path` for reasons nobody can see.
 */
export function moveRequest(msgId: number, from: string, to: string): Uint8Array {
  return encodeMessage(msgId, StorageCode.Move, twoPaths(from, to));
}

export function copyRequest(msgId: number, from: string, to: string): Uint8Array {
  return encodeMessage(msgId, StorageCode.Copy, twoPaths(from, to));
}

/**
 * Delete one file.
 *
 * **Nothing here can undo this.** The +Drive is the only copy of most of what is on it, and there
 * is no trash. Read the entry first and check `writable`; the device will refuse a protected file,
 * and will not refuse anything else.
 */
export function deleteRequest(msgId: number, path: string): Uint8Array {
  return encodeMessage(msgId, StorageCode.Delete, string0(slashed(path)));
}

function twoPaths(from: string, to: string): Uint8Array {
  const a = string0(slashed(from));
  const b = string0(slashed(to));
  const body = new Uint8Array(a.length + b.length);
  body.set(a, 0);
  body.set(b, a.length);
  return body;
}

/**
 * Add the trailing slash a mutation wants, if the caller has not.
 *
 * Forgiving on purpose: every other path in this API is written without one, so a caller that gets
 * it right everywhere else will get it wrong here, and the failure — `Could not resolve path` — is
 * indistinguishable from naming a file that is not there.
 */
function slashed(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export interface OpenResult {
  /** The handle a read and a close refer to. Counts up from 1 per open. */
  handle: number;
  /**
   * The five bytes after the handle, **undecoded on purpose**.
   *
   * This was named `chunkSize` and it was wrong. Three of Transfer's opens reported `2048` with a
   * trailing `1`, and every full chunk in those reads carried exactly 2,048 bytes — which looked
   * conclusive. Then our own open of `/projects/1` reported **16**, with a trailing `0`.
   *
   * A field that reads 2,048 on three samples and 16 on the fourth is not a chunk size we
   * understand, and nothing needs it: reads are addressed by **sequence number**, not by length.
   * So it is carried through for whoever solves it rather than given a name that would be believed.
   *
   * > Three samples agreeing is what a wrong reading looks like from the inside.
   */
  rest: Uint8Array;
}

/**
 * Decode an open reply.
 *
 * A failure is `00` followed by the device's own sentence — `Error: Could not resolve …` was the
 * one observed — so the message is handed back rather than replaced with ours. The device explains
 * itself better than a generic error can.
 *
 * It also has to be **read** rather than interpreted. `invalid project id` was taken as the device
 * naming its argument type; it was naming a resolution failure, and acting on the misreading froze
 * the instrument twice. See `openRequest`.
 */
export function parseOpen(body: Uint8Array): OpenResult {
  refuseFailure(body, "open");
  if (body.length < 10) throw new ListingError(`open reply is ${body.length} bytes, expected 10`);
  return { handle: u32(body, 1), rest: body.subarray(5) };
}

/**
 * Ask for the next chunk of an open file, **by sequence number**.
 *
 * ```
 * 0x55   u32 handle   u32 sequence
 * ```
 *
 * ## The device named this field itself
 *
 * Two wrong shapes, each answered informatively rather than fatally:
 *
 * | Sent | Device |
 * |---|---|
 * | `u32 handle` alone | 4,963 consecutive **zero-length chunks**, end flag never set |
 * | `u32 handle, u32 length, u32 start` (elk-herd's order) | **`Invalid sequence number`** |
 *
 * The second is the one that solved it. We sent `handle=2, 16, 0`; the device read our *second*
 * field as a sequence number, found 16 where it wanted 1, and said so in as many words. So this is
 * **not** a byte-range API like elk-herd's `FileRead` — it is a numbered-chunk API, and the number
 * is the `sequence` the reply has been echoing all along as 1, 2, 3 … 22.
 *
 * **Sequence numbers start at 1**, matching the first data-bearing reply in Transfer's capture.
 *
 * ## Why a wrong guess here is cheap
 *
 * The device validates this strictly and answers with a sentence. Three different refusals —
 * `invalid project id`, `project id out of range`, `Invalid sequence number` — have each named
 * their field precisely. **The dangerous part of this API was `0x54`'s framing, not its arguments.**
 */
export function readRequest(msgId: number, handle: number, sequence: number): Uint8Array {
  const body = new Uint8Array(8);
  body.set(u32Bytes(handle), 0);
  body.set(u32Bytes(sequence), 4);
  return encodeMessage(msgId, StorageCode.Read, body);
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
  /**
   * The chunk's checksum, **as the device computed it**.
   *
   * The same field a write request carries at offset 8 — verified by uploading a sound to
   * `/soundbanks/C/29` (`cb 49 92 19`) and reading that sound back (`cb 49 92 19`). The algorithm
   * is unknown and does not match CRC-32 in any of eleven forms, chained or cumulative.
   *
   * Which does not block writing back **what we just read**: the device has already told us the
   * answer for these exact bytes. Carried for that.
   */
  checksum: number;
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
    checksum: u32(body, 14),
  };
}

const READ_HEADER = 22;

/**
 * A `0` status byte, followed by the device saying why in Windows-1252.
 *
 * Shared by open and read because both answer this way, and the device's own wording is more
 * informative than anything this module could substitute.
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
  /**
   * Bytes, for a file — **the slot's allocation, not the length of what is in it.**
   *
   * Every slot in a DN1 sound bank reports 302 whether it holds a sound or not: verified
   * 2026-08-04 by listing an empty `/soundbanks/H`, writing a sound into slot 256, and listing
   * again — the name changed and the size did not, while the file itself read 345 bytes.
   *
   * So this must never be used to decide occupancy. `occupied` reads the name and the permission
   * mask, which is what actually changes.
   */
  size?: number;
  /** Children, for a directory. */
  children?: number;
  /**
   * The permission mask — **identified 2026-07-30**, and it is not what this said before.
   *
   * ```
   * 0x7e = 0111 1110   full
   * 0x12 = 0001 0010   write-protected: bits 2, 3, 5 and 6 gone, 1 and 4 kept
   * ```
   *
   * A capability set rather than a flag, which is why it never looked like a single bit.
   *
   * > **This field was recorded as "probably the sound's tag bitmask" and that was wrong.** It had
   * > two samples — `0x0012` on `DIGIT-ONE` and `0x007e` on `HH TICK_PITX_AR` — and a hypothesis
   * > that fit both. They are a factory sound and a user sound: protection, not tags.
   *
   * Proved on a `/projects` listing: **exactly two of 128 entries** carry `0x12`, and they are
   * exactly the two the device reports as write-protected. An entire factory soundbank reads `0x12`
   * on all 256.
   */
  permissions?: number;
  /**
   * The whole trailer after the name, exactly as it arrived, for entries that have one.
   *
   * **Kept because a field we cannot name is the only place an answer can still be hiding.** On a
   * `/projects` listing these bytes are not constant — `PRESETS` reads `0012 0101` where
   * `MORNING_JAM` and `AMBZ` read `007e 0101` — and *something* distinguishes projects from one
   * another there. One candidate is the question worth the most right now: **which project is
   * currently loaded.**
   *
   * The tag-bitmask reading came from *sound* listings and was never tested on projects. Rather
   * than extend a guess across a boundary it was never checked at, the bytes are handed over whole
   * so an experiment can settle it: list, change the project on the device, list again, diff.
   */
  trailer?: Uint8Array;
  /**
   * False when the slot holds nothing.
   *
   * The last two trailer bytes are `01 01` on a slot with something in it and `00 00` on an empty
   * one — 53 occupied, 73 empty and 2 protected across one 128-slot listing, which adds up.
   *
   * An empty slot still has a name field; it is blank. Reading occupancy from the name would work
   * until somebody saved a project with no name.
   */
  occupied?: boolean;
  /**
   * False when the device will refuse to write here.
   *
   * Worth surfacing rather than discovering: Elektron Transfer reports `Slot 29 already taken` only
   * *after* a failed transfer, and the listing knew all along.
   */
  writable?: boolean;
}

export interface Listing {
  entries: Entry[];
  /** Index of the first entry in this page. */
  first: number;
  /**
   * Where a following request resumes, as the device reports it.
   *
   * **Not `first + entries.length` when the reply is capped.** `/projects` on a Digitone II answers
   * `first=0, next=129, count=128` in 885 bytes — room for 45 entries, not 128. So `next` is the
   * end of the *directory*, not the end of this page, and a caller resuming must use
   * `first + entries.length` instead.
   */
  next: number;
  /** Entries the device says the directory holds. May exceed `entries.length`; see `next`. */
  declared: number;
  /** True when this page carried everything the device declared. */
  complete: boolean;
}

/**
 * A page that did not carry everything the device declared.
 *
 * **Named rather than tolerated.** A short page has two very different causes and the same shape: a
 * directory genuinely bigger than one reply, or a reply that is not the answer to our request at
 * all. The second is not hypothetical — two message-id allocators once collided and a directory
 * request got a file-open reply, and another application on the same port (Overbridge, Transfer)
 * puts traffic there constantly.
 *
 * So the parser reports the shortfall and the caller decides. What no caller may do is show 45 of
 * 128 projects as though that were the +Drive.
 */
export class ShortListingError extends ListingError {}

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
  /*
   * **Every failure below names what was already read.** `entry "" is truncated` was the whole of
   * one report from hardware, and it says almost nothing: not how many entries arrived, not how
   * many the device declared, not how many bytes were left over. Those three numbers separate the
   * two causes — a reply cut short in transit, versus `count` meaning something other than "entries
   * in this page" — and without them the next step is a guess.
   *
   * An empty name is the specific shape of running off the end into padding: `indexOf(0, at)` finds
   * a NUL immediately, so the name is "" and the fields after it are missing.
   */
  const so_far = () =>
    `read ${entries.length} of the ${count} entries the device declared, ` +
    `${body.length - at} of ${body.length} bytes left, first=${first} next=${next}`;
  /*
   * **Bounded by the body, not by `count`.** The device declares how many entries the directory
   * holds and then sends as many as fit in one reply — 45 of a declared 128 for `/projects`, in 885
   * bytes. Looping to `count` walked off the end into padding and threw `entry "" is truncated`,
   * which reported a corrupt listing when the listing was fine and merely partial.
   *
   * A short page is now a fact the caller is handed, not an error. Anything *malformed* still
   * throws: an unterminated name mid-entry, or a layout byte that is neither shape.
   */
  for (let i = 0; i < count && at < body.length; i++) {
    const end = body.indexOf(0, at);
    if (end === -1) throw new ListingError(`entry ${i} has no terminated name — ${so_far()}`);
    const name = new TextDecoder("windows-1252").decode(body.subarray(at, end));
    at = end + 1;

    // Two bytes after the name, and **they are two independent fields** — which the first version
    // of this parser missed, because the only two samples it had happened to make them look like
    // one 16-bit tag.
    //
    // `/soundbanks` is what showed it: its entries are directories carrying `01 02`, so a parser
    // that knew only `0101` and `0002` refused a perfectly good listing. It refused *loudly* and
    // handed over the bytes, which is the one part of this that went right.
    if (at + 2 > body.length) {
      if (entries.length > 0) break;
      throw new ListingError(
        `entry "${name}" is truncated before its kind and layout bytes — ${so_far()}`);
    }
    const isDirectory = body[at] === 1;
    const layout = body[at + 1]!;
    at += 2;

    if (layout === SHORT) {
      // Only a child count. Seen on the two roots, `projects` and `soundbanks`.
      if (at + 4 > body.length) {
        if (entries.length > 0) break;
      throw new ListingError(`entry "${name}" is truncated in its child count — ${so_far()}`);
      }
      entries.push({ name, kind: "directory", index: i + first, children: u32(body, at) });
      at += 4;
    } else if (layout === LONG) {
      // Index, size and two unidentified bytes. Used by files **and** by bank directories, whose
      // "size" is a fixed 262,144 — an allocation, the way each project's is a fixed 4 MiB on a
      // Digitone 1 and 16 MiB on a Digitone II.
      if (at + 12 > body.length) {
        if (entries.length > 0) break;
      throw new ListingError(`entry "${name}" is truncated in its index/size — ${so_far()}`);
      }
      const permissions = (body[at + 8]! << 8) | body[at + 9]!;
      entries.push({
        name,
        kind: isDirectory ? "directory" : "file",
        index: u32(body, at),
        size: u32(body, at + 4),
        permissions,
        // `01 01` occupied, `00 00` empty. Compared as a pair rather than a byte, because two
        // samples of one byte is how the permission field got read as a tag mask.
        occupied: body[at + 10] === 1 && body[at + 11] === 1,
        writable: (permissions & WRITABLE_BITS) === WRITABLE_BITS,
        // Kept whole as well as decoded — the mask's individual bits are still unassigned.
        trailer: body.slice(at + 8, at + 12),
      });
      at += 12;
    } else {
      throw new ListingError(
        `entry "${name}" declares layout 0x${layout.toString(16).padStart(2, "0")}, which is ` +
          `neither short (0x${SHORT.toString(16)}) nor long (0x${LONG.toString(16)})`,
      );
    }
  }

  return {
    entries,
    first,
    next,
    declared: count,
    // What the caller actually needs to know: is there more to ask for? A page that carried
    // everything declared is done; a short one is not, whatever `next` says.
    complete: entries.length >= count,
  };
}

/**
 * A listing, refused unless it is whole.
 *
 * **A partial +Drive listing must never be presented as the +Drive.** Slot numbers come from these
 * entries, and a project opened from the wrong slot is the mistake this whole subsystem is arranged
 * to prevent. So a page that carried 45 of a declared 128 is an error here, not a shorter list.
 *
 * Moved here from `driveproject.ts`, where it guarded the manager and nothing else. The library,
 * `listProjects` and the backup each listed a directory and took whatever arrived: on 2026-09-14 a
 * preset bank showed **35 of 256** as though it were the bank, with Elektron Transfer open on the
 * same port. A backup doing that saves a partial drive and says it saved the drive.
 *
 * **The cause is named in the order it has been true.** On 2026-09-06 two unrelated requests came
 * back at exactly 885 bytes with Overbridge Engine holding the port, and closing it fixed both: 128
 * projects in one reply. A directory too large for one reply would look the same and has not been
 * seen once the port was DNX's own. Reaching for paging first was one of three wrong turns that day,
 * which is why this refuses rather than asking for the rest.
 */
export function wholeListing(
  reply: { body: Uint8Array; terminated?: boolean },
  path: string,
): Listing {
  const hint =
    "The usual cause is another application on the same USB port: close Elektron Transfer and " +
    "Overbridge, then try again.";

  // A reply with no end marker was cut on the way here. It may still parse, because 7-bit
  // unpacking cannot tell a fragment from a short message, so it is judged before the entries are.
  if (reply.terminated === false) {
    let counts = "";
    try {
      const partial = parseListing(reply.body);
      counts = ` after ${partial.entries.length} of the ${partial.declared} entries it declared`;
    } catch {
      // Cut part-way through an entry. The refusal below is the finding either way.
    }
    throw new ShortListingError(
      `${path}: the reply was cut in transit${counts}, ${reply.body.length} bytes with no end ` +
        `marker. ${hint}`,
    );
  }

  const listing = parseListing(reply.body);
  if (!listing.complete) {
    throw new ShortListingError(
      `${path} answered with ${listing.entries.length} of the ${listing.declared} entries it ` +
        `declared, so this is not the whole directory. ${hint}`,
    );
  }
  return listing;
}

/**
 * The bits a writable entry has and a protected one does not.
 *
 * `0x7e` full, `0x12` protected — so `0x6c` is what protection removes. Compared as a whole rather
 * than by a single bit, because which bit means what is still unassigned and picking one would be
 * the tag-mask mistake again.
 */
const WRITABLE_BITS = 0x7e & ~0x12;

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

/** A big-endian u32. Exported because `storagewrite.ts` had an identical private copy. */
/**
 * The checksum a +Drive write must carry — **solved 2026-08-06**.
 *
 * It is `crc32ZeroInit`: CRC-32 with the ordinary polynomial and final inversion, but seeded with
 * **zero** rather than all-ones. The same function this codebase already used for the project
 * payload's check field, which is why the answer was in the repository the whole time and not
 * recognised — the eleven forms tried against it were tried as *whole* algorithms, and the one that
 * fits differs from `zlib.crc32` in a single parameter.
 *
 * **Derived from a matched pair off the instrument.** `/soundbanks/A/1` read 345 bytes and the
 * device reported `e48ff54e`; `crc32ZeroInit` over exactly those bytes is `e48ff54e`. A 32-bit
 * agreement on 345 bytes is not a coincidence worth entertaining.
 *
 * **Still one sample, and the decisive test is different in kind.** Matching a checksum the device
 * gave us proves we can reproduce its arithmetic. What it does not yet prove is that the device
 * *accepts* a checksum we computed for bytes it has never seen — and that is the whole point of
 * having it. That experiment writes edited content to an empty slot and reads the verdict off the
 * instrument; until it passes, this is verified against a capture and not against a write.
 */
export function driveChecksum(bytes: Uint8Array): number {
  return crc32ZeroInit(bytes);
}

export function u32(b: Uint8Array, at: number): number {
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
