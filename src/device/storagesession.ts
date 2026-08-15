/**
 * Reading a file off the +Drive as **one indivisible sequence**: open, read, close.
 *
 * ## Why this is a module and not three calls
 *
 * `storage.ts` can build all three messages. Sending them in order is not the hard part; sending
 * the **third one no matter what happens** is, and that is not something a caller can be trusted to
 * remember at every early return.
 *
 * The precedent is expensive. `0x54` was built open-only, deliberately, justified as caution —
 * *do not guess three messages at once*. It froze the user's Digitone 1 three times, each costing a
 * power cycle and anything unsaved in the active project. The missing close was almost certainly
 * **not** the cause — see `openRequest`, where the evidence points at a missing NUL terminator —
 * but the shape of the mistake stands on its own:
 *
 * > **An allocate with no release is not a safe subset of an allocate/use/release. It is the one
 * > combination that cannot be safe.**
 *
 * So the close lives in a `finally` and runs on every path: a read that threw, a chunk that failed
 * its length check, a caller that gave up, a device that went silent mid-file. It is also the
 * *only* thing this module guarantees — the read can fail in a dozen ways, and every one of them
 * still closes.
 *
 * ## What is verified and what is a guess
 *
 * **The replies are [verified]** — decoded from Elektron Transfer's own traffic, 27 read replies
 * across three files, with the declared length matching the payload every time and the end-of-file
 * flag firing exactly once per file. `docs/device-storage.md` §3a has the layout.
 *
 * **The requests are inferred**, and `0x54`'s argument is the live question. Three bodies have been
 * sent to a Digitone 1: a NUL-terminated path, which it answered, and two raw integer forms, which
 * killed it. This takes a **path**, on the strength of that being the only shape the device has
 * ever tolerated — which is evidence, not proof, and the third hypothesis about this message.
 *
 * ## Stateless, like `api.ts`
 *
 * No module-level device, no ambient counter. Two instruments have to be held at once, and a
 * session that assumed one would make that decision here by accident.
 */

import { type ApiFrame, RESPONSE_BIT } from "./api.js";
import {
  type Chunk,
  DEFAULT_CHUNK_SIZE,
  ListingError,
  STORED_FORM,
  StorageCode,
  closeRequest,
  openRequest,
  parseOpen,
  parseRead,
  readRequest,
  FREEZES,
} from "./storage.js";

/**
 * The transport, reduced to what a session needs.
 *
 * `request` **must match the reply to the message id it sent.** Not optional: Elektron Transfer
 * polls the same port continuously, and a Digitone II volunteers API messages the moment a port
 * opens, so "the next message to arrive" is regularly somebody else's. That mistake has already
 * produced one false finding — `docs/KNOWN-ISSUES.md`.
 */
export interface ApiTransport {
  request(bytes: Uint8Array, msgId: number, timeoutMs: number): Promise<ApiFrame>;
}

export interface ReadStoredFileOptions {
  transport: ApiTransport;
  /**
   * Ask for the **compressed** file rather than the expanded image.
   *
   * Two genuinely different answers to the same path, and the difference is not a detail: a DN2
   * project is 12,889,647 bytes raw and about 79,000 stored — 6,294 chunks against 3.
   *
   * Raw is the default because it is what most of DNX wants: an image is the thing every edit,
   * diff and decode operates on. Ask for stored when the bytes are going to be **written back**,
   * because that is the only form a `0x58` accepts — `refuseRawForm` rejects the other one at the
   * door, so a backup taken raw is a backup that cannot be restored.
   *
   * That is not hypothetical. The first overwrite run on hardware, 2026-08-15, backed up slot 13
   * without this: 12.9 MB, no container header, saved under a `.dn2prj` name it had no right to,
   * and unwritable by the very function that produced it.
   */
  form?: typeof STORED_FORM;
  /** First message id; each request takes the next. Never 0 — see `api.ts`. */
  msgId?: number;
  timeoutMs?: number;
  /**
   * Refuse to keep reading past this many chunks.
   *
   * A device that never sets the end-of-file flag would otherwise loop forever, and the failure
   * would look like a hang rather than a protocol misunderstanding.
   *
   * **This was 8,192, on the reasoning that 16 MB is "past any project either machine holds".**
   * Real projects: a DN2's is **12,889,647 bytes, 6,294 chunks**; a DN1's is at least 2,504,704.
   * Both are megabytes, and a larger one would have failed with *"the device never set the
   * end-of-file flag"* — sending the next person after a protocol bug that does not exist.
   *
   * **8,192 was not a ceiling nobody would reach — it had already been reached.** The 131,072-byte
   * figure that used to be quoted here as a DN1 project size is `8,192 × 16`: this guard, times the
   * 16-byte default chunk size, from a read `docs/device-storage.md` §3 records as having *"no end
   * in sight"*. A cut-off read still reports a number, and the number outlived the sentence saying
   * it was cut off. Anything sized by eye against a stopped read is sized against this guard.
   */
  maxChunks?: number;
  /**
   * How many times to ask again for a chunk the device did not answer.
   *
   * **This did not fix anything, and the honest story is worth more than the feature.** On
   * 2026-08-12 a DN2 read stalled after 199, 700, 899 and 1,263 chunks on four attempts — a
   * *varying* stall point, which reads exactly like a lost reply. It was a failing power supply.
   * Swapping it made every read complete, and the control run with `maxRetriesPerChunk: 0` read the
   * same 12,889,647 bytes. The clincher was moving the suspect supply to the Digitone 1, which had
   * been flawless all evening and immediately started dropping replies too. **The fault followed
   * the supply, not the device and not this loop.**
   *
   * It stays because **a 6,294-round-trip operation with no recovery is fragile whatever tonight's
   * cause turned out to be** — a cable, a hub, a busy USB controller — and because losing 12.9 MB
   * to one dropped message is a bad way to find that out. It is insurance, not a fix, and anyone
   * reading a stall as "so the retry is not working" should suspect the power first.
   *
   * Retrying is sound because **this is a numbered-chunk API, not a stream**: `readRequest` asks
   * for a specific sequence, `check()` verifies the index that comes back, and nothing on the
   * device has moved on. `docs/device-storage.md` established that numbering precisely because the
   * device rejected a byte-range request with `Invalid sequence number`.
   *
   * Bounded, and small. Unbounded retrying on this API has already cost 4,963 round trips once —
   * see `MAX_EMPTY_CHUNKS`.
   */
  maxRetriesPerChunk?: number;
  /**
   * A pause before asking again, rather than instantly.
   *
   * Under the failing supply the device dropped requests that crowded each other — a listing
   * answered in 201 ms cold, timed out repeated immediately, and answered again after a gap. That
   * turned out to be the supply rather than the protocol, and on a healthy instrument three
   * back-to-back listings all return in ~200 ms. The pause stays because a retry is by definition
   * happening while something is already wrong, and asking again instantly is the one cadence
   * observed to fail. Tests pass `0`.
   */
  retryPauseMs?: number;
  /**
   * Progress, with the file's expected total once it is known.
   *
   * `total` is `undefined` until enough of the file has arrived for `totalFromHead` to answer, and
   * for every read that does not supply one. A caller drawing a bar switches from *working* to a
   * percentage the moment it appears.
   */
  onProgress?: (chunks: number, bytes: number, total?: number) => void;
  /**
   * Given the first bytes, how long the whole file will be.
   *
   * **Supplied by the caller, not known here.** This module reads chunks off a handle and has no
   * business knowing what a +Drive file looks like inside; the caller does, and passes a function
   * that answers from a head. For an Elektron container that is `fileLengthFromHead`.
   *
   * Used only for reporting. Nothing about the read depends on it, so a wrong answer costs a wrong
   * bar rather than a truncated file.
   */
  totalFromHead?: (head: Uint8Array) => number | undefined;
}

export interface StoredFile {
  bytes: Uint8Array;
  chunks: number;
  /** The leading zero-length reply's header, unidentified and carried through. */
  metadata?: Uint8Array;
  /** Whether the close was acknowledged. **False is a warning, not a failure of the read.** */
  closed: boolean;
  /**
   * How many chunk requests had to be repeated before the device answered.
   *
   * Reported rather than swallowed. A read that needed forty retries succeeded, but it is not the
   * same event as one that needed none, and a caller writing "read 1.8 MB" over the top of that
   * would be hiding the most interesting thing about the run.
   */
  retries: number;
  /**
   * The checksum the device reported for this file's content, when it arrived in one chunk.
   *
   * `undefined` for a multi-chunk read, because a per-chunk checksum is not a whole-file one and
   * pretending otherwise would hand a write the wrong number. This is the safe thing to hand a
   * writer: **let the device supply the value for its own bytes.**
   */
  checksum?: number;
  /**
   * Every chunk's checksum, in order — the same values `checksum` collapses to one of.
   *
   * Kept because **the device checksums per chunk, and that is the strongest evidence we have
   * about what a write should carry.** `writeStoredFile` sends the whole file's value on every
   * `0x58`, which was a guess made when the only upload ever captured was a single chunk; the read
   * path has been saying otherwise the whole time and nothing was looking.
   *
   * Two things this makes checkable, both without writing anything:
   *
   * 1. **Whether `driveChecksum` is right at chunk granularity.** Compute it over each slice and
   *    compare. The algorithm was solved against whole small files; that it also holds for an
   *    arbitrary 2,048-byte window is an assumption until this says so.
   * 2. **What the boundaries are.** A checksum per chunk is only useful for writing if a written
   *    chunk means the same thing as a read one.
   */
  chunkChecksums: number[];
  /**
   * How many bytes each chunk actually carried, in order.
   *
   * **Recorded rather than derived.** The first attempt to check `driveChecksum` against the
   * device's per-chunk values re-sliced the file by `ceil(total / chunkCount)` and got 0 of 6 —
   * not because the algorithm is wrong, but because 10,795 bytes in 6 chunks is five of 2,048 and
   * a remainder, never six of 1,800. A checksum comparison is only evidence when it runs over the
   * bytes the device actually checksummed, and this is the only thing that knows them.
   */
  chunkLengths: number[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * 64 MB at 2,048 bytes a chunk — five times the largest project ever read, rather than 1.3 times.
 *
 * The number is a backstop and nothing else. `MAX_EMPTY_CHUNKS` is what actually catches a
 * conversation going nowhere, in three round trips; this only has to stop an unbounded loop, so it
 * should sit far above anything real. Sizing it *close* to a real file is what made the old value
 * dangerous — it turned "a bigger project than we have seen" into "a protocol error".
 */
const DEFAULT_MAX_CHUNKS = 32_768;

/**
 * Consecutive empty chunks before this gives up.
 *
 * Transfer's sequences open with exactly one, so one is normal and three is a conversation going
 * nowhere. The far guard at 8,192 stays as a backstop, but it is the wrong instrument for this:
 * a mistaken request should cost an error, not five thousand round trips.
 */
const MAX_EMPTY_CHUNKS = 3;

/**
 * Three tries for a chunk the device did not answer, then give up on the file.
 *
 * Two would leave a single unlucky repeat fatal; ten would spend a minute per lost chunk at a
 * 5-second timeout and turn a broken read into a hang. Three is enough to ride out the isolated
 * drops observed on hardware without hiding a device that has genuinely stopped talking.
 */
const DEFAULT_RETRIES_PER_CHUNK = 3;

/** Long enough to break the cadence the device dislikes, short enough not to dominate a long read. */
const DEFAULT_RETRY_PAUSE_MS = 120;

/**
 * Read one stored file end to end, and close the handle whatever happens.
 *
 * The `FREEZES` token is passed from here because this is the only place that can honestly pass
 * it: the promise the token stands for is *"paired with a close"*, and the `finally` below is that
 * pairing. Anywhere else it would be an assertion; here it is enforced by control flow.
 */
export async function readStoredFile(
  path: string,
  options: ReadStoredFileOptions,
): Promise<StoredFile> {
  const {
    transport,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxChunks = DEFAULT_MAX_CHUNKS,
    maxRetriesPerChunk = DEFAULT_RETRIES_PER_CHUNK,
    retryPauseMs = DEFAULT_RETRY_PAUSE_MS,
    onProgress,
    totalFromHead,
  } = options;
  let nextId = options.msgId ?? 1;
  const id = (): number => nextId++;

  const openId = id();
  // Built **before** the try, so a request this module refuses to construct cannot trigger the
  // release of a handle that was never allocated. A close on nothing is harmless, but a cleanup
  // that runs when no resource was taken is a lie the logs would repeat.
  const open = openRequest(openId, path, FREEZES, DEFAULT_CHUNK_SIZE, options.form);

  let opened;
  try {
    opened = parseOpen(expect(await transport.request(open, openId, timeoutMs), StorageCode.Open).body);
  } catch (error) {
    // **The open is the dangerous half, so it gets a release attempt even when it appears to have
    // failed.** A reply that timed out is not a reply that never happened: the handle may exist on
    // a device that simply did not answer us, and a leaked one is exactly what we are here to stop.
    //
    // Handles count up from 1 per open, so 1 is the informed guess on a device nobody else is
    // using. Wrong, it is a close on a handle that is not there — which the device answers with an
    // error, not a freeze. Right, it releases the handle that would otherwise leak.
    await closeQuietly(transport, id(), SPECULATIVE_HANDLE, timeoutMs);
    throw error;
  }

  const parts: Uint8Array[] = [];
  const checksums: number[] = [];
  let total = 0;
  let chunks = 0;
  let empties = 0;
  let metadata: Uint8Array | undefined;
  let closed = false;
  let retries = 0;
  /** The file's declared length, once the first chunk has been seen. See `totalFromHead`. */
  let expectedTotal: number | undefined;

  /**
   * Ask for one chunk, and ask again if the device does not answer.
   *
   * **Only the transport call is retried.** A rejection from `transport.request` is a timeout or a
   * failure to send — the kinds of nothing that asking again can fix. Everything after it —
   * `expect`, `parseRead`, `check` — throws on a reply that *arrived and was wrong*, which is a
   * protocol disagreement and must stay fatal. Retrying those would turn a decoding bug into a
   * silent loop, which is the failure mode this file's guards exist to prevent.
   *
   * A **fresh message id per attempt**, because the abandoned request may still be in flight and
   * the transport matches replies by id. Reusing the id would make a late answer to the request we
   * gave up on indistinguishable from an answer to this one — the exact mistake recorded in
   * `docs/KNOWN-ISSUES.md`, where Transfer's traffic was read as our result.
   */
  const requestChunk = async (handle: number, sequence: number): Promise<ApiFrame> => {
    let last: unknown;
    for (let attempt = 0; attempt <= maxRetriesPerChunk; attempt++) {
      if (attempt > 0) {
        retries++;
        if (retryPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
      }
      const attemptId = id();
      try {
        return await transport.request(
          readRequest(attemptId, handle, sequence), attemptId, timeoutMs,
        );
      } catch (error) {
        last = error;
      }
    }
    throw new ListingError(
      `no answer for chunk ${sequence} after ${maxRetriesPerChunk + 1} attempts ` +
        `(handle ${handle}, ${total} bytes so far): ${last instanceof Error ? last.message : last}`,
    );
  };

  try {
    for (;;) {
      if (chunks >= maxChunks) {
        throw new ListingError(
          `read did not end after ${maxChunks} chunks (${total} bytes) — the device never set the ` +
            `end-of-file flag, so either the flag is not what we think it is or this is not a file`,
        );
      }

      // **Sequence numbers start at 0**, which Transfer's own requests settled: it asks for 0, gets
      // the 22-byte empty reply, then asks for 1 and gets data. That empty reply was recorded here
      // as an unidentified "metadata" message for half a day; it is simply the answer to sequence
      // zero, and asking for zero is how you get it.
      const sequence = chunks === 0 ? 0 : parts.length + 1;
      const chunk = parseRead(expect(
        await requestChunk(opened.handle, sequence),
        StorageCode.Read,
      ).body);

      check(chunk, opened.handle, parts.length + 1);
      chunks++;

      if (chunk.metadata) {
        metadata ??= chunk.header;
        // **Stop asking when the answers stop containing anything.** Sending only a handle drew
        // 4,963 consecutive zero-length chunks on hardware and the end flag never came — the device
        // had opened the file and was waiting to be told what to read. The old guard was 8,192,
        // which is a number chosen for "impossible" rather than "implausible", so a request we had
        // wrong became five thousand round trips instead of an error.
        //
        // Three, because Transfer's own sequences begin with exactly one empty reply. One is
        // normal, two is odd, three is a conversation that is not going anywhere.
        if (++empties >= MAX_EMPTY_CHUNKS) {
          throw new ListingError(
            `${empties} chunks in a row carried no data — the device is answering but sending ` +
              `nothing, which is what an incomplete read request looks like. Handle ` +
              `${opened.handle}, ${total} bytes so far.`,
          );
        }
      } else {
        empties = 0;
        parts.push(chunk.data);
        checksums.push(chunk.checksum);
        total += chunk.data.length;
      }

      // Asked once, as soon as there is enough to answer with. Re-deriving it every chunk would
      // join thousands of buffers over a 12.9 MB read to re-learn a number that cannot change.
      if (expectedTotal === undefined && totalFromHead && parts.length > 0) {
        expectedTotal = totalFromHead(parts[0]!);
      }
      onProgress?.(chunks, total, expectedTotal);

      if (chunk.last) break;
    }
  } finally {
    // The whole reason this module exists. Every path above — a throw, a break, a caller's
    // rejection — arrives here.
    closed = await closeQuietly(transport, id(), opened.handle, timeoutMs);
  }

  // Only when the whole file came in one chunk. Two chunks means two checksums and no statement
  // about the whole, and a caller writing that back would send a number for a third of the file.
  const single = parts.length === 1 ? checksums[0] : undefined;
  return {
    bytes: join(parts, total),
    chunks,
    metadata,
    closed,
    checksum: single,
    chunkChecksums: checksums,
    chunkLengths: parts.map((p) => p.length),
    retries,
  };
}

/** A device with nobody else attached hands out handle 1 first. */
const SPECULATIVE_HANDLE = 1;

/**
 * Close, and refuse to let its failure mask the read's outcome.
 *
 * A read that succeeded and a close that timed out is **a successful read**, reported with a
 * warning. Rethrowing here would turn the one operation we care about into a failure on account of
 * its cleanup, and — worse — would hide the original error when the `finally` runs after a throw.
 */
async function closeQuietly(
  transport: ApiTransport,
  msgId: number,
  handle: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await transport.request(closeRequest(msgId, handle), msgId, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse a reply that is not the one this request asked for.
 *
 * A response's code is the request's `+0x80`. Checked because the transport matches on message id
 * and nothing else, and a device that answers the right id with the wrong message is telling us our
 * model is wrong — which is worth an error rather than a misparse.
 */
function expect(frame: ApiFrame, code: number): ApiFrame {
  if (frame.code !== (code | RESPONSE_BIT)) {
    throw new ListingError(
      `expected 0x${(code | RESPONSE_BIT).toString(16)} in reply to 0x${code.toString(16)}, ` +
        `got 0x${frame.code.toString(16)}`,
    );
  }
  return frame;
}

/**
 * Refuse a chunk that does not belong to this read.
 *
 * Both checks exist because the alternative is silent corruption. A chunk from another handle
 * would be another file's bytes spliced into this one, and an out-of-order index would be this
 * file's bytes in the wrong order — neither shows up until something downstream refuses the
 * result, by which time nothing points back here.
 *
 * The index is 1-based and only meaningful on a data-bearing chunk; the leading metadata reply
 * puts an unidentified constant in that field, so it is exempt rather than special-cased later.
 *
 * `expected` counts **data** chunks, not replies, so the metadata reply cannot shift the numbering
 * — the two would have agreed by coincidence while there was exactly one such reply, which is the
 * kind of agreement that survives until the day it does not.
 */
function check(chunk: Chunk, handle: number, expected: number): void {
  if (chunk.handle !== handle) {
    throw new ListingError(`chunk is for handle ${chunk.handle}, this read holds ${handle}`);
  }
  if (chunk.metadata) return;
  if (chunk.index !== expected) {
    throw new ListingError(`expected chunk ${expected}, the device sent ${chunk.index}`);
  }
}

function join(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
