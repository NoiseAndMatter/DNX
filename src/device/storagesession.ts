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
 * *do not guess three messages at once*. It froze the user's Digitone 1 twice, each time costing a
 * power cycle and anything unsaved in the active project. Whether the missing close was the *cause*
 * is now doubtful (see `openRequest`), but the shape of the mistake is not:
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
 * **The requests are inferred**, and `0x54`'s argument list is the live question: the reply carries
 * a chunk size, which suggests the request does too, and the four-byte body we sent is what the
 * device died on. Both shapes are reachable through `openBody` so the experiment has two arms.
 *
 * ## Stateless, like `api.ts`
 *
 * No module-level device, no ambient counter. Two instruments have to be held at once, and a
 * session that assumed one would make that decision here by accident.
 */

import { type ApiFrame, RESPONSE_BIT } from "./api.js";
import {
  type Chunk,
  type OpenBody,
  ListingError,
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
  /** First message id; each request takes the next. Never 0 — see `api.ts`. */
  msgId?: number;
  /** Which guess at `0x54`'s argument list to send. Defaults to the fuller one. */
  openBody?: OpenBody;
  timeoutMs?: number;
  /**
   * Refuse to keep reading past this many chunks.
   *
   * A device that never sets the end-of-file flag would otherwise loop forever, and the failure
   * would look like a hang rather than a protocol misunderstanding. 8,192 chunks is 16 MB, past any
   * project either machine holds.
   */
  maxChunks?: number;
  onProgress?: (chunks: number, bytes: number) => void;
}

export interface StoredFile {
  bytes: Uint8Array;
  chunks: number;
  /** The leading zero-length reply's header, unidentified and carried through. */
  metadata?: Uint8Array;
  /** Whether the close was acknowledged. **False is a warning, not a failure of the read.** */
  closed: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CHUNKS = 8_192;

/**
 * Read one stored file end to end, and close the handle whatever happens.
 *
 * The `FREEZES` token is passed from here because this is the only place that can honestly pass
 * it: the promise the token stands for is *"paired with a close"*, and the `finally` below is that
 * pairing. Anywhere else it would be an assertion; here it is enforced by control flow.
 */
export async function readStoredFile(
  projectId: number,
  options: ReadStoredFileOptions,
): Promise<StoredFile> {
  const {
    transport,
    openBody = "id+chunk",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxChunks = DEFAULT_MAX_CHUNKS,
    onProgress,
  } = options;
  let nextId = options.msgId ?? 1;
  const id = (): number => nextId++;

  const openId = id();
  let opened;
  try {
    opened = parseOpen(expect(await transport.request(
      openRequest(openId, projectId, FREEZES, openBody), openId, timeoutMs,
    ), StorageCode.Open).body);
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
  let total = 0;
  let chunks = 0;
  let metadata: Uint8Array | undefined;
  let closed = false;

  try {
    for (;;) {
      if (chunks >= maxChunks) {
        throw new ListingError(
          `read did not end after ${maxChunks} chunks (${total} bytes) — the device never set the ` +
            `end-of-file flag, so either the flag is not what we think it is or this is not a file`,
        );
      }

      const readId = id();
      const chunk = parseRead(expect(await transport.request(
        readRequest(readId, opened.handle), readId, timeoutMs,
      ), StorageCode.Read).body);

      check(chunk, opened.handle, parts.length + 1);
      chunks++;

      if (chunk.metadata) metadata ??= chunk.header;
      else {
        parts.push(chunk.data);
        total += chunk.data.length;
      }
      onProgress?.(chunks, total);

      if (chunk.last) break;
    }
  } finally {
    // The whole reason this module exists. Every path above — a throw, a break, a caller's
    // rejection — arrives here.
    closed = await closeQuietly(transport, id(), opened.handle, timeoutMs);
  }

  return { bytes: join(parts, total), chunks, metadata, closed };
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
