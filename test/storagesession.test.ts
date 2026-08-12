/**
 * The open/read/close sequence.
 *
 * **The fixtures are real device replies**, lifted byte for byte out of the capture of Elektron
 * Transfer reading three files off a Digitone 1. That matters more than usual here: this module's
 * whole job is to be right about a wire format we inferred, and a test built from our own encoder
 * would agree with our own misunderstanding. `test/storage.test.ts` covers the codec; this covers
 * the sequence, and above all the promise that the handle is always released.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "../src/device/api.js";
import { StorageCode } from "../src/device/storage.js";
import { type ApiTransport, readStoredFile } from "../src/device/storagesession.js";

// --- real replies, transcribed ------------------------------------------------------------------

/** `01` ok, handle 1, chunk size 2,048, flag 1. Exactly what the device sent Transfer. */
const OPEN_OK = bytes("01 00 00 00 01 00 00 08 00 01");

/** The zero-length reply that leads every read sequence. Its middle words are unidentified. */
const METADATA = bytes("01 00 00 00 01 40 12 c3 44 41 bc ff 90 00 ff ff ff ff 00 00 00 00");

/** `Error: Could not resolve` — the device's own words, status 0. */
const OPEN_FAILED = bytes("00 45 72 72 6f 72 3a 20 43 6f 75 6c 64 20 6e 6f 74 20 72 65 73 6f 6c 76 65");

const CLOSE_OK = bytes("01 00 00 00 01 00 00 00 81");

/** A data chunk, built around real content so the header is the only synthetic part. */
function chunk(index: number, data: number[], last: boolean): Uint8Array {
  const out = new Uint8Array(22 + data.length);
  out.set(bytes("01 00 00 00 01"), 0);
  out.set(u32(index), 5);
  out.set(u32(1000), 9);
  out[13] = last ? 1 : 0;
  out.set(u32(0xdeadbeef), 14);
  out.set(u32(data.length), 18);
  out.set(data, 22);
  return out;
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.split(" ").map((h) => parseInt(h, 16)));
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/**
 * A transport that answers from a script and records what it was asked.
 *
 * Records the **codes sent**, because the assertion this module exists for is about a message that
 * must be sent on every path — and "was it sent" is not observable from the return value.
 */
function scripted(replies: (Uint8Array | Error)[]): ApiTransport & { sent: number[] } {
  let at = 0;
  const sent: number[] = [];
  return {
    sent,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const code = decodeMessage(request).code;
      sent.push(code);
      const reply = replies[at++];
      if (reply === undefined) return Promise.reject(new Error(`no scripted reply for 0x${code.toString(16)}`));
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        msgId,
        respId: msgId,
        code: code | RESPONSE_BIT,
        body: reply,
        isResponse: true,
      });
    },
  };
}

// --- the happy path ------------------------------------------------------------------------------

test("a file arrives whole, in order, and the handle is released", async () => {
  const io = scripted([
    OPEN_OK,
    METADATA,
    chunk(1, [0x7b, 0x22], false),
    chunk(2, [0x61, 0x7d], true),
    CLOSE_OK,
  ]);

  const file = await readStoredFile("/projects/PRESETS", { transport: io });

  assert.deepEqual([...file.bytes], [0x7b, 0x22, 0x61, 0x7d]);
  assert.equal(file.chunks, 3, "the metadata reply is a chunk that arrived, even carrying no data");
  assert.equal(file.closed, true);
  assert.deepEqual(io.sent, [StorageCode.Open, StorageCode.Read, StorageCode.Read, StorageCode.Read, StorageCode.Close]);
  assert.ok(file.metadata, "the unidentified header is carried through rather than dropped");
});

test("the end of a file is the device's flag, never a short chunk", async () => {
  // The manifest came back as one 129-byte chunk with the flag set, while a project ran 21 full
  // chunks and a short one. Stopping on a short read would have truncated the first file and
  // worked on the second - which is the worst possible way to be wrong.
  const io = scripted([OPEN_OK, chunk(1, [1, 2, 3], true), CLOSE_OK]);
  const file = await readStoredFile("/projects/PRESETS", { transport: io });

  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.closed, true);
});

// --- the promise this module exists to keep ------------------------------------------------------

test("a read that fails every attempt still closes the handle", async () => {
  // 0x54 froze the user's Digitone 1 three times. The cause is now thought to be something else
  // entirely, and this still holds: an allocate that can skip its release is the one shape that
  // cannot be safe, whatever else turns out to be true.
  //
  // **Four silences, not one.** A single unanswered chunk is now retried — see the tests below —
  // so exhausting the retries is what it takes to fail the read, and the release has to survive
  // that longer path too. The device's own words still reach the caller through the wrapper.
  const io = scripted([OPEN_OK, ...Array(4).fill(new Error("device went silent"))]);

  await assert.rejects(
    readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 }),
    /device went silent/,
  );
  assert.deepEqual(io.sent, [
    StorageCode.Open,
    StorageCode.Read, StorageCode.Read, StorageCode.Read, StorageCode.Read,
    StorageCode.Close,
  ]);
});

test("a chunk that fails its own checks still closes the handle", async () => {
  const io = scripted([OPEN_OK, chunk(7, [1, 2], false)]);

  await assert.rejects(readStoredFile("/projects/PRESETS", { transport: io }), /expected chunk 1, the device sent 7/);
  assert.equal(io.sent.at(-1), StorageCode.Close, "the last thing on the wire is the release");
});

test("a close that fails does not turn a good read into a bad one", async () => {
  const io = scripted([OPEN_OK, chunk(1, [9], true), new Error("close timed out")]);
  const file = await readStoredFile("/projects/PRESETS", { transport: io });

  assert.deepEqual([...file.bytes], [9], "the bytes arrived and the read succeeded");
  assert.equal(file.closed, false, "and the caller is told the release was not acknowledged");
});

test("an open that fails still attempts a release", async () => {
  // A reply that timed out is not a reply that never happened. The handle may exist on a device
  // that simply did not answer us, and that is exactly the leak this module exists to prevent.
  const io = scripted([new Error("no answer")]);

  await assert.rejects(readStoredFile("/projects/PRESETS", { transport: io }), /no answer/);
  assert.deepEqual(io.sent, [StorageCode.Open, StorageCode.Close]);
});

test("the device's own refusal is what the caller is told", async () => {
  // The device's wording is the best documentation this protocol has, and substituting ours would
  // throw it away. It is also the thing most worth reading carefully: `invalid project id` was
  // taken as "the argument should be an id rather than a path", when it meant "this path resolved
  // to no project" - and acting on the misreading cost two power cycles.
  const io = scripted([OPEN_FAILED, CLOSE_OK]);

  await assert.rejects(readStoredFile("/projects/NOPE", { transport: io }), /Could not resolve/);
});

test("an empty path is refused before it reaches the wire", async () => {
  // Every body that froze a Digitone 1 was one with no NUL-terminated string in it, and an empty
  // argument is the shortest way to write that by accident.
  const io = scripted([]);

  await assert.rejects(readStoredFile("", { transport: io }), /needs a path/);
  assert.deepEqual(io.sent, [], "nothing was sent, so there is nothing to close");
});

// --- refusing to guess ---------------------------------------------------------------------------

test("a chunk belonging to another handle is refused, not spliced in", async () => {
  const foreign = chunk(1, [1, 2], true);
  foreign.set(u32(9), 1);
  const io = scripted([OPEN_OK, foreign]);

  await assert.rejects(readStoredFile("/projects/PRESETS", { transport: io }), /handle 9, this read holds 1/);
  assert.equal(io.sent.at(-1), StorageCode.Close);
});

test("a device that answers but sends nothing is refused after three empty chunks", async () => {
  // On hardware this drew **4,963 consecutive zero-length chunks** before the far guard tripped.
  // The device had opened the file and was waiting to be told what to read, and the read request
  // was not telling it. A guard set at "impossible" instead of "implausible" turned a request we
  // had wrong into five thousand round trips.
  const io = scripted([OPEN_OK, METADATA, METADATA, METADATA, CLOSE_OK]);

  await assert.rejects(
    readStoredFile("/projects/1", { transport: io }),
    /3 chunks in a row carried no data/,
  );
  assert.equal(io.sent.at(-1), StorageCode.Close, "and the handle is still released");
});

test("one empty chunk is normal and does not end the read", async () => {
  // Transfer's own sequences open with exactly one. Refusing on the first would break every read.
  const io = scripted([OPEN_OK, METADATA, chunk(1, [1, 2], true), CLOSE_OK]);
  const file = await readStoredFile("/projects/1", { transport: io });

  assert.deepEqual([...file.bytes], [1, 2]);
});

test("the read request carries a sequence number, starting at zero", async () => {
  // Handle alone is what produced the 4,963 empty chunks. The arguments are handle, length, start
  // - elk-herd's FileRead order, which puts length before the thing everyone says first.
  const io = scripted([OPEN_OK, chunk(1, [1, 2, 3], true), CLOSE_OK]);
  const requests: Uint8Array[] = [];
  const spy: ApiTransport = {
    request(request, msgId, timeoutMs) {
      requests.push(decodeMessage(request).body);
      return io.request(request, msgId, timeoutMs);
    },
  };

  await readStoredFile("/projects/1", { transport: spy });

  const read = requests[1]!;
  assert.equal(read.length, 8, "handle and sequence number, nothing else");
  assert.deepEqual([...read.subarray(0, 4)], [0, 0, 0, 1], "the handle the open returned");
  assert.deepEqual([...read.subarray(4, 8)], [0, 0, 0, 0], "the first read asks for sequence 0");
});

test("a device that never says stop is refused rather than read forever", async () => {
  // Without this the failure is a hang, which reads as a broken port rather than as a protocol
  // misunderstanding - and the flag being wrong is a live possibility, not a hypothetical.
  const io = {
    sent: [] as number[],
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const code = decodeMessage(request).code;
      io.sent.push(code);
      const body = code === StorageCode.Open ? OPEN_OK
        : code === StorageCode.Close ? CLOSE_OK
        : chunk(io.sent.filter((c) => c === StorageCode.Read).length, [0], false);
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body, isResponse: true });
    },
  };

  await assert.rejects(
    readStoredFile("/projects/PRESETS", { transport: io, maxChunks: 4 }),
    /did not end after 4 chunks/,
  );
  assert.equal(io.sent.at(-1), StorageCode.Close);
});

test("a reply with the wrong code is refused rather than misparsed", async () => {
  const io: ApiTransport & { sent: number[] } = {
    sent: [],
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      io.sent.push(decodeMessage(request).code);
      // A listing reply to an open request: right message id, wrong message.
      return Promise.resolve({ msgId, respId: msgId, code: 0xd3, body: OPEN_OK, isResponse: true });
    },
  };

  await assert.rejects(readStoredFile("/projects/PRESETS", { transport: io }), /expected 0xd4 in reply to 0x54, got 0xd3/);
});

// --- one lost reply must not lose the file -------------------------------------------------------
//
// **Measured on a Digitone II, 2026-08-12.** A DN2 project is at least 1.8 MB and arrives 2,048
// bytes at a time, so a single read is 900+ round trips. Three consecutive attempts stalled after
// 199, 899 and 700 chunks — a *varying* stall point, which is a lost reply and not an end of file.
// The device was proven alive after every one. Without a retry, one dropped message in nine hundred
// throws the whole file away, and on that instrument it happened every time.
//
// Retrying is sound because this is a **numbered-chunk** API: the request names its sequence and
// `check()` verifies the index that comes back, so asking again asks for the same thing.

/** Like `scripted`, but records the sequence and message id of every read, not just the code. */
function watched(replies: (Uint8Array | Error)[]): ApiTransport & { reads: { seq: number; id: number }[] } {
  let at = 0;
  const reads: { seq: number; id: number }[] = [];
  return {
    reads,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const frame = decodeMessage(request);
      // `0x55  u32 handle  u32 sequence` — the sequence is the second word of the body.
      if (frame.code === StorageCode.Read) {
        const b = frame.body;
        reads.push({ seq: (b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!, id: msgId });
      }
      const reply = replies[at++];
      if (reply === undefined) return Promise.reject(new Error("script exhausted"));
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ msgId, respId: msgId, code: frame.code | RESPONSE_BIT, body: reply, isResponse: true });
    },
  };
}

test("a chunk the device does not answer is asked for again, and the file still arrives whole", async () => {
  const io = watched([
    OPEN_OK,
    chunk(1, [0xaa], false),
    new Error("no reply to 0x4591 within 5000ms"),   // the drop, mid-file
    chunk(2, [0xbb], false),
    chunk(3, [0xcc], true),
    CLOSE_OK,
  ]);

  const file = await readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 });

  assert.deepEqual([...file.bytes], [0xaa, 0xbb, 0xcc], "no byte is missing and none is duplicated");
  assert.equal(file.closed, true);
  assert.equal(file.retries, 1, "the recovery is reported, not swallowed");
});

test("the retry asks for the same sequence, which is the whole reason it is safe", async () => {
  const io = watched([OPEN_OK, chunk(1, [1], false), new Error("silence"), chunk(2, [2], true), CLOSE_OK]);
  await readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 });

  // `[0, 2, 2]`, and the gap is real rather than a bug: **the sequence asked for and the chunk
  // index returned are offset by one.** Asking for sequence 0 is answered by chunk index 1, so the
  // next request is for 2. The retry repeats 2 — never skipping it, never re-reading 1.
  assert.deepEqual(io.reads.map((r) => r.seq), [0, 2, 2]);
});

test("a retry uses a fresh message id, so a late answer to the abandoned request cannot pass for it", async () => {
  // The transport matches replies by id. Reusing the id would make the reply we gave up waiting for
  // indistinguishable from this one's — the exact mistake that let Transfer's traffic be read as our
  // result once already.
  const io = watched([OPEN_OK, new Error("silence"), chunk(1, [7], true), CLOSE_OK]);
  await readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 });

  const retried = io.reads.filter((r) => r.seq === 0);
  assert.equal(retried.length, 2, "sequence 0 was asked twice");
  assert.notEqual(retried[0]!.id, retried[1]!.id, "and with different message ids");
});

test("retrying is bounded, and the caller is told which chunk was never answered", async () => {
  // Unbounded retrying on this API has already cost 4,963 round trips once.
  const io = watched([OPEN_OK, chunk(1, [1], false), ...Array(9).fill(new Error("silence"))]);

  await assert.rejects(
    readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 }),
    /no answer for chunk 2 after 4 attempts/,
  );
  assert.equal(io.reads.filter((r) => r.seq === 2).length, 4, "four attempts, not nine");
});

test("maxRetriesPerChunk of 0 restores the old one-shot behaviour", async () => {
  const io = watched([OPEN_OK, new Error("silence")]);

  await assert.rejects(
    readStoredFile("/projects/PRESETS", { transport: io, maxRetriesPerChunk: 0, retryPauseMs: 0 }),
    /after 1 attempts/,
  );
  assert.equal(io.reads.length, 1);
});

test("a reply that arrived and was wrong is never retried", async () => {
  // The retry is for silence. A chunk with the wrong index is a protocol disagreement: the device
  // answered, and it said something we do not understand. Asking again would turn a decoding bug
  // into a loop, and would hide the one thing worth reporting.
  const io = watched([OPEN_OK, chunk(9, [1], false), CLOSE_OK]);

  await assert.rejects(
    readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 }),
    /expected chunk 1, the device sent 9/,
  );
  assert.equal(io.reads.length, 1, "asked once, refused, and did not ask again");
});

test("a clean read reports no retries", async () => {
  const io = watched([OPEN_OK, chunk(1, [1], true), CLOSE_OK]);
  const file = await readStoredFile("/projects/PRESETS", { transport: io, retryPauseMs: 0 });

  assert.equal(file.retries, 0, "so a run that needed help is distinguishable from one that did not");
});
