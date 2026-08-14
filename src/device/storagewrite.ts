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
 * ## One chunk works at any size. More than one is refused. — 2026-08-13
 *
 * Measured on a Digitone II, three runs over the same 10,795-byte kit into the same empty slot:
 *
 * | chunks | chunk size | checksum declared | result |
 * |---|---|---|---|
 * | 6 | 2,048 | each chunk's own | `Invalid package checksum; corrupt transfer` |
 * | 6 | 2,048 | the whole file's | `Invalid package checksum; corrupt transfer` |
 * | 2 | 8,192 | the whole file's | `Invalid package checksum; corrupt transfer` |
 * | **1** | 16,384 | the whole file's | **COMMITTED, and it read back** |
 *
 * Same bytes, same target, same checksum value in the last three. **The only variable that changes
 * the outcome is the chunk count** — not the size of a chunk, and not which value the field
 * carries. Something else about a continuation `0x58` is wrong, and the device's wording points at
 * the checksum only because that is the check it fails first.
 *
 * 8,192 was worth trying rather than guessed at: digi-roll's protocol notes record elk-herd's
 * +Drive `FileWrite` (`0x40`–`0x42`, a different opcode set from this one) as *"chunked at 8192
 * bytes"*. It is refused here exactly as 2,048 is, which is what rules chunk *size* out.
 *
 * Two things this does settle:
 *
 * - **The field is validated**, not decorative. That was the experiment this module was built for,
 *   and it got answered by a write that was trying to be correct rather than by the corruption run.
 * - **Anything that fits in one message is writable today**, and 10,795 bytes does. Presets and
 *   kits are unblocked; a ~12.9 MB project is not.
 *
 * The read side is separately settled, and was settled without writing anything. `readStoredFile`
 * collects one checksum per chunk and `driveChecksum` reproduces every one over that chunk's own
 * slice — all six verified once the slices were taken at the lengths the device actually sent.
 * **Reads and writes do not use this field the same way**, which is worth stating plainly because
 * assuming they did is what produced the first refusal above.
 *
 * **Why nothing caught this earlier:** at one chunk, "this chunk's checksum" and "the whole file's"
 * are the same number, and the single 269-byte upload the protocol was copied from is the one case
 * that cannot distinguish them.
 *
 * `checksum` takes a function so the next hypothesis is a call rather than an edit here.
 *
 * ## The device stamps the slot index — kit container +24
 *
 * `/kits/A/1` written verbatim into `/kits/A/38` reads back differing in **one byte of 10,795**:
 * `+24`, `0x00` → `0x25`. That is 37, and the target is slot 38 — so `+24` is the container's own
 * zero-based slot index, the same idea as `slotIndexOffset` in a pattern record. **The instrument
 * writes it itself**, so a caller does not have to fix it up, but a byte-for-byte round-trip check
 * has to expect it or it will read as corruption.
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
import { type WritePermit } from "./writepermit.js";
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

/**
 * Compute the checksum one chunk declares.
 *
 * Takes the whole file as well as the slice, so a cumulative or offset-dependent hypothesis is
 * expressible without changing this signature — which is the point, given that the right answer is
 * not known and the last two guesses were both wrong.
 */
export type ChunkChecksum = (slice: Uint8Array, offset: number, whole: Uint8Array) => number;

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
  /**
   * Proof this write came through `safewrite.ts`. See `writepermit.ts`.
   *
   * The empty-slot rule below is a strong guard and it is not the whole job: it says nothing about
   * whether the person was told what is about to happen, or whether anyone checked that the bytes
   * landed. Those belong to the sequence, and the sequence lives in `safeWriteFile`.
   */
  permit: WritePermit;
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
 * **Reachable only through `safeWriteFile`.** This is the raw sequence; the confirmation and the
 * read-back that make it safe are one layer up, and `WritePermit` is what stops a new caller from
 * arriving here directly.
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
   * What each chunk declares in its checksum field.
   *
   * - **omitted** — the whole file's `driveChecksum`, sent on every chunk. The only form a device
   *   has ever accepted, and what the field appears to mean: it sits beside the *total* length in
   *   the request, not beside this chunk's.
   * - **a number** — force that value onto every chunk. The corruption experiment.
   * - **a function** — compute per chunk. This is how the per-chunk hypothesis was tested, and it
   *   was **refused**: `Invalid package checksum; corrupt transfer`. Kept because the refusal is
   *   the useful part — the field is demonstrably validated, and any further hypothesis about what
   *   it covers is one call away rather than an edit to this file.
   */
  checksum: number | ChunkChecksum | undefined,
  options: WriteStoredFileOptions,
): Promise<WriteResult> {
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
    // **The checksum covers this chunk, not the whole file** — measured 2026-08-13, and it is the
    // reason a project could not be written.
    //
    // This used to send the whole file's value on every chunk, copied from the one upload ever
    // captured: Transfer sending a 269-byte sound in a *single* chunk. **At one chunk the two
    // models are identical**, so the only case ever tested was the only case that could not tell
    // them apart, and the guess sat here looking verified.
    //
    // Settled without writing anything. A read reports a checksum per chunk, and `driveChecksum`
    // reproduces all of them over their own slices — `/kits/A/1`, 10,795 bytes in six chunks, four
    // of four checked byte-exact against the device's own numbers. A cumulative reading matches
    // only the first chunk, which is again the case where every model agrees.
    //
    // `declared` overrides it for the corruption experiment, where sending a knowingly wrong value
    // is the whole point.
    const sum =
      typeof checksum === "function"
        ? checksum(slice, written, bytes)
        : (checksum ?? driveChecksum(bytes));
    const reply = await transport.request(
      writeChunkRequest(chunkId, handle, written, sum, bytes.length, slice),
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
