/**
 * Writing to the +Drive.
 *
 * Most of these are about **refusing**. Nothing has ever been written to a Digitone's +Drive by
 * this code, the protocol is hours old, and for most people the instrument holds the only copy of
 * what is on it — so the tests that matter are the ones proving a write cannot reach anything that
 * already exists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "../src/device/api.js";
import { type Entry, StorageCode } from "../src/device/storage.js";
import { type ApiTransport } from "../src/device/storagesession.js";
import { refuseUnlessEmpty, writeStoredFile } from "../src/device/storagewrite.js";

/** A listing entry, defaulting to the empty-and-writable case the write path requires. */
function entry(over: Partial<Entry> = {}): Entry {
  return { name: "", kind: "file", index: 42, occupied: false, writable: true, ...over };
}

/** Answers every request with `01` and the fields a real device sends. */
function accepting(): ApiTransport & { sent: { code: number; body: Uint8Array }[] } {
  const sent: { code: number; body: Uint8Array }[] = [];
  return {
    sent,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body: requestBody } = decodeMessage(request);
      sent.push({ code, body: requestBody });
      const body =
        code === StorageCode.WriteOpen ? Uint8Array.of(1, 0, 0, 0, 7)
        : code === StorageCode.Write ? Uint8Array.of(1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 1, 0)
        : Uint8Array.of(1, 0, 0, 0, 7, 0, 0, 1, 0);
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body, isResponse: true });
    },
  };
}

// --- refusing ------------------------------------------------------------------------------------

test("an occupied slot is refused, not warned about", () => {
  // The user asked for refuse rather than warn, and they were right: there are 73 empty project
  // slots on that instrument, so nothing is gained by letting the first write ever attempted be
  // able to destroy something.
  assert.throws(
    () => refuseUnlessEmpty(entry({ occupied: true, name: "MORNING_JAM" }), "/projects/2"),
    /holds "MORNING_JAM" — writing there would overwrite it/,
  );
});

test("a write-protected slot is refused before the device has to refuse it", () => {
  assert.throws(
    () => refuseUnlessEmpty(entry({ writable: false }), "/projects/1"),
    /write-protected/,
  );
});

test('"we could not tell" does not read as "it is empty"', () => {
  // The important one. An entry with no occupancy came from somewhere other than a listing, and
  // treating unknown as empty is how a tool overwrites something while believing it did not.
  assert.throws(
    () => refuseUnlessEmpty(entry({ occupied: undefined }), "/projects/9"),
    /cannot tell whether/,
  );
});

test("an occupied target is refused before anything reaches the wire", async () => {
  const io = accepting();
  await assert.rejects(
    writeStoredFile("/projects/2", Uint8Array.of(1, 2, 3), 0, { transport: io, target: entry({ occupied: true }) }),
    /overwrite/,
  );
  assert.deepEqual(io.sent, [], "nothing was sent");
});

test("an empty file is refused", async () => {
  const io = accepting();
  await assert.rejects(
    writeStoredFile("/projects/9", new Uint8Array(0), 0, { transport: io, target: entry() }),
    /empty file/,
  );
  assert.deepEqual(io.sent, []);
});

// --- the sequence --------------------------------------------------------------------------------

test("open declares the length, the chunk carries the checksum, the close commits", async () => {
  const io = accepting();
  const bytes = Uint8Array.from({ length: 269 }, (_, i) => i & 0xff);

  const result = await writeStoredFile("/soundbanks/C/29", bytes, 0xcb499219, {
    transport: io,
    target: entry(),
  });

  assert.deepEqual(io.sent.map((s) => s.code), [
    StorageCode.WriteOpen,
    StorageCode.Write,
    StorageCode.WriteClose,
  ]);

  // 0x57: length before the path, which is not where anyone would put it.
  assert.deepEqual([...io.sent[0]!.body.subarray(0, 4)], [0, 0, 0x01, 0x0d]);

  // 0x58: handle from the open, offset 0, the device's own checksum, then the total length.
  const chunk = io.sent[1]!.body;
  assert.deepEqual([...chunk.subarray(0, 16)], [0, 0, 0, 7, 0, 0, 0, 0, 0xcb, 0x49, 0x92, 0x19, 0, 0, 0x01, 0x0d]);
  assert.deepEqual([...chunk.subarray(16)], [...bytes], "the payload follows unchanged");

  assert.equal(result.written, 269);
  assert.equal(result.chunks, 1, "269 bytes fits in one chunk, which is the point of trying a sound first");
  assert.equal(result.committed, true);
});

test("a long file is split, and every chunk states its offset", async () => {
  const io = accepting();
  const bytes = new Uint8Array(5000).fill(0xab);

  const result = await writeStoredFile("/projects/9", bytes, 1, { transport: io, target: entry(), chunkSize: 2048 });

  assert.equal(result.chunks, 3);
  const offsets = io.sent.filter((s) => s.code === StorageCode.Write).map((s) => u32(s.body, 4));
  assert.deepEqual(offsets, [0, 2048, 4096]);
});

test("the device's own refusal is what the caller is told", async () => {
  // `Slot 29 already taken` is the device's wording, and its wording has been the best
  // documentation this protocol has.
  const io: ApiTransport = {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code } = decodeMessage(request);
      const text = new TextEncoder().encode("Slot 29 already taken\0");
      const body = new Uint8Array(1 + text.length);
      body.set(text, 1);
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body, isResponse: true });
    },
  };

  await assert.rejects(
    writeStoredFile("/soundbanks/C/29", Uint8Array.of(1), 0, { transport: io, target: entry() }),
    /Slot 29 already taken/,
  );
});

test("a failed chunk never reaches the commit", async () => {
  // No `finally` here, deliberately, unlike the read session: a close in a finally would commit a
  // half-written file. A leaked handle is recoverable; a truncated project on the +Drive is not.
  let calls = 0;
  const io: ApiTransport & { sent: number[] } = {
    sent: [],
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code } = decodeMessage(request);
      io.sent.push(code);
      if (++calls === 2) return Promise.reject(new Error("device went silent"));
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body: Uint8Array.of(1, 0, 0, 0, 7), isResponse: true });
    },
  };

  await assert.rejects(
    writeStoredFile("/projects/9", Uint8Array.of(1, 2, 3), 0, { transport: io, target: entry() }),
    /device went silent/,
  );
  assert.ok(!io.sent.includes(StorageCode.WriteClose), "nothing was committed");
});

function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}
