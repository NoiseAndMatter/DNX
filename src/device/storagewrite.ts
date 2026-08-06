/**
 * Writing a file to the +Drive — open, write, commit, and **only into an empty slot**.
 *
 * ## The first write in this project's history
 *
 * Nothing has ever been written to a Digitone's +Drive by this code. The protocol came off a USB
 * capture of Elektron Transfer hours ago (`docs/device-storage.md` §7), and the one field we cannot
 * produce was the checksum — **solved 2026-08-06**. It is `crc32ZeroInit`, the same function the
 * project payload's check field uses: ordinary CRC-32 seeded with zero instead of all-ones. The
 * eleven forms tried against it were tried as whole algorithms, and the one that fits differs from
 * `zlib.crc32` in a single parameter.
 *
 * That does not have to be solved to make the first write. **Write back exactly what was read**, and
 * the device has already told us the answer for those bytes — `Chunk.checksum` is the same field a
 * write request carries at offset 8, verified from both sides on the same sound.
 *
 * So the experiment this module exists for is two presses:
 *
 * 1. Read a file, write those bytes to an **empty** slot with the device's own checksum.
 *    Landing proves `0x57`/`0x58`/`0x59`.
 * 2. The same with the checksum corrupted. **Refused** means it is validated and we need the
 *    algorithm; **accepted** means the field is decorative and writing is unblocked entirely.
 *
 * Test 2 is the one worth having, and it is only cheap because test 1 tells us what a success looks
 * like first.
 *
 * ## Empty slots only, refused rather than warned
 *
 * The listing says which slots are empty and which are protected (`Entry.occupied`,
 * `Entry.writable`), and there are 73 empty project slots on the author's instrument. There is no
 * reason for the first write ever attempted to be *able* to overwrite anything, so it cannot: this
 * refuses an occupied target outright rather than asking.
 *
 * For most people the +Drive is the only copy of that work, and an undo they have to discover
 * afterwards is not consent. The restriction can be relaxed once writing is proven; relaxing it is
 * a decision somebody makes on purpose.
 */

import { type ApiTransport } from "./storagesession.js";
import { RESPONSE_BIT } from "./api.js";
import {
  type Entry,
  driveChecksum,
  ListingError,
  StorageCode,
  u32,
  writeChunkRequest,
  writeCloseRequest,
  writeOpenRequest,
} from "./storage.js";

export interface WriteStoredFileOptions {
  transport: ApiTransport;
  /** The listing entry for the destination. **Required** — see `refuseUnlessEmpty`. */
  target: Entry;
  msgId?: number;
  timeoutMs?: number;
  /**
   * Bytes per chunk. The whole payload goes in one message when it fits, which it does for a
   * 269-byte sound — the smallest useful thing to write first.
   */
  chunkSize?: number;
  onProgress?: (written: number, total: number) => void;
}

export interface WriteResult {
  /** Bytes the device acknowledged, summed across chunks. */
  written: number;
  chunks: number;
  /** True when the commit was acknowledged. **A write is not done until this is true.** */
  committed: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CHUNK_SIZE = 2048;

/**
 * Refuse any destination that is not demonstrably empty.
 *
 * Three ways a target can be wrong, and all three are refusals rather than warnings:
 *
 * - **Occupied.** Something is there and this would overwrite it.
 * - **Protected.** The device would refuse anyway — `Slot 29 already taken` — but finding out from
 *   a failed transfer is worse than being told before it starts.
 * - **Unknown.** An entry with no `occupied` field came from something other than a listing, and
 *   "we could not tell" must not read the same as "it is empty".
 *
 * That last one is the important one. The other two are checks; this one is the refusal to guess.
 */
export function refuseUnlessEmpty(target: Entry, path: string): void {
  if (target.occupied === undefined) {
    throw new ListingError(
      `cannot tell whether ${path} is empty — this entry did not come from a directory listing, ` +
        `and "unknown" must not be treated as "empty" when the +Drive is the only copy`,
    );
  }
  if (target.occupied) {
    throw new ListingError(
      `${path} holds "${target.name}" — writing there would overwrite it. Pick an empty slot; ` +
        `a listing marks them, and there is no undo on the instrument.`,
    );
  }
  if (target.writable === false) {
    throw new ListingError(`${path} is write-protected — the device would refuse this anyway`);
  }
}

/**
 * Write one file, and commit it.
 *
 * The commit is `0x59`, and nothing lands without it — so unlike the read session there is no
 * `finally` that closes on failure. **A write that fails should not be committed**, and a close in
 * a `finally` would commit a half-written file, which is the opposite of the guarantee the read path
 * needs. The handle leaks instead, which the device recovers from and a truncated project does not.
 */
export async function writeStoredFile(
  path: string,
  bytes: Uint8Array,
  /**
   * The checksum to declare. **Omit it and it is computed**, which is what a caller writing edited
   * content wants; pass one to write a value deliberately, which is how the field was proved to be
   * enforced in the first place.
   */
  checksum: number | undefined,
  options: WriteStoredFileOptions,
): Promise<WriteResult> {
  const declared = checksum ?? driveChecksum(bytes);
  const {
    transport,
    target,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress,
  } = options;

  refuseUnlessEmpty(target, path);
  if (bytes.length === 0) throw new ListingError("refusing to write an empty file");

  let nextId = options.msgId ?? 1;
  const id = (): number => nextId++;

  const openId = id();
  const opened = await transport.request(
    writeOpenRequest(openId, path, bytes.length), openId, timeoutMs,
  );
  expect(opened, StorageCode.WriteOpen);
  const handle = u32(opened.body, 1);

  let written = 0;
  let chunks = 0;
  while (written < bytes.length) {
    const slice = bytes.subarray(written, Math.min(written + chunkSize, bytes.length));
    const chunkId = id();
    // **The checksum is the whole file's, not this chunk's**, on the one upload we have to copy:
    // Transfer sent a 269-byte sound in a single chunk with one value. Whether a multi-chunk write
    // repeats it, or checksums each chunk, is unknown — which is a reason to write things that fit
    // in one chunk until somebody captures a large upload.
    const reply = await transport.request(
      writeChunkRequest(chunkId, handle, written, declared, bytes.length, slice),
      chunkId,
      timeoutMs,
    );
    expect(reply, StorageCode.Write);
    written += slice.length;
    chunks++;
    onProgress?.(written, bytes.length);
  }

  const closeId = id();
  const closed = await transport.request(writeCloseRequest(closeId, handle), closeId, timeoutMs);
  expect(closed, StorageCode.WriteClose);

  return { written, chunks, committed: closed.body[0] === 1 };
}

function expect(frame: { code: number; body: Uint8Array }, code: number): void {
  if (frame.code !== (code | RESPONSE_BIT)) {
    throw new ListingError(
      `expected 0x${(code | RESPONSE_BIT).toString(16)} in reply to 0x${code.toString(16)}, ` +
        `got 0x${frame.code.toString(16)}`,
    );
  }
  // The device answers a refusal with `00` and its own sentence — `Slot 29 already taken` is one.
  // Reported verbatim, because its wording has been the best documentation this protocol has.
  if (frame.body[0] !== 1) {
    const text = new TextDecoder("windows-1252").decode(frame.body.subarray(1)).replace(/\0+$/, "").trim();
    throw new ListingError(text.length > 0 ? text : `write step failed with status ${frame.body[0]}`);
  }
}
