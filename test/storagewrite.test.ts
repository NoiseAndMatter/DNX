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
import { type Entry, StorageCode, driveChecksum } from "../src/device/storage.js";
import { type ApiTransport } from "../src/device/storagesession.js";
import { FORM_FLAG_OFFSET, refuseRawForm, refuseUnlessEmpty, writeStoredFile } from "../src/device/storagewrite.js";
import { TEST_PERMIT } from "./permit.js";

/**
 * Stamp the stored-form flag, so a fixture looks like something the +Drive would accept.
 *
 * `refuseRawForm` reads `+29`, and every fixture below is bytes-with-a-shape rather than a real
 * container. Without this they would all be refused before reaching the code under test — which is
 * the guard working, and would make these tests about the guard instead of about chunking.
 */
function stored(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  if (out.length > 29) out[29] = 0x01;
  return out;
}

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

test("an occupied slot is allowed only when overwriting was asked for by name", () => {
  const target = entry({ occupied: true, name: "MORNING_JAM" });
  assert.throws(() => refuseUnlessEmpty(target, "/projects/2"), /would overwrite it/);
  assert.doesNotThrow(() => refuseUnlessEmpty(target, "/projects/2", true));
});

test('"we could not tell" is still refused, even when overwriting was asked for', () => {
  // The one part of the empty-slot rule that has no override, and the reason is not symmetry.
  // Consenting to replace something means knowing what it is; an unlisted entry means nobody does,
  // and the backup taken in that state would be of a file we could not name either.
  assert.throws(
    () => refuseUnlessEmpty(entry({ occupied: undefined }), "/projects/9", true),
    /cannot tell whether/,
  );
});

test("a write-protected slot stays refused when overwriting was asked for", () => {
  // Permission is the device's answer, not ours to override — `overwrite` says "replace what is
  // there", not "ignore what the instrument said about this slot".
  assert.throws(
    () => refuseUnlessEmpty(entry({ occupied: true, writable: false }), "/projects/1", true),
    /write-protected/,
  );
});

test("an occupied target is refused before anything reaches the wire", async () => {
  const io = accepting();
  await assert.rejects(
    writeStoredFile("/projects/2", Uint8Array.of(1, 2, 3), 0, { transport: io, target: entry({ occupied: true }), permit: TEST_PERMIT }),
    /overwrite/,
  );
  assert.deepEqual(io.sent, [], "nothing was sent");
});

test("an empty file is refused", async () => {
  const io = accepting();
  await assert.rejects(
    writeStoredFile("/projects/9", new Uint8Array(0), 0, { transport: io, target: entry(), permit: TEST_PERMIT }),
    /empty file/,
  );
  assert.deepEqual(io.sent, []);
});

// --- the sequence --------------------------------------------------------------------------------

test("open declares the length, the chunk carries the checksum, the close commits", async () => {
  const io = accepting();
  const bytes = stored(Uint8Array.from({ length: 269 }, (_, i) => i & 0xff));

  const result = await writeStoredFile("/soundbanks/C/29", bytes, 0xcb499219, {
    transport: io,
    target: entry(),
    permit: TEST_PERMIT,
  });

  assert.deepEqual(io.sent.map((s) => s.code), [
    StorageCode.WriteOpen,
    StorageCode.Write,
    StorageCode.WriteClose,
  ]);

  // 0x57: length before the path, which is not where anyone would put it.
  assert.deepEqual([...io.sent[0]!.body.subarray(0, 4)], [0, 0, 0x01, 0x0d]);

  // 0x58: handle from the open, chunk index 0, the device's own checksum, then the chunk size.
  // At one chunk the chunk size equals the file length, which is exactly why this test passed for
  // months while the field meant something else. See `writeChunkRequest`.
  const chunk = io.sent[1]!.body;
  assert.deepEqual([...chunk.subarray(0, 16)], [0, 0, 0, 7, 0, 0, 0, 0, 0xcb, 0x49, 0x92, 0x19, 0, 0, 0x01, 0x0d]);
  assert.deepEqual([...chunk.subarray(16)], [...bytes], "the payload follows unchanged");

  assert.equal(result.written, 269);
  assert.equal(result.chunks, 1, "269 bytes fits in one chunk, which is the point of trying a sound first");
  assert.equal(result.committed, true);
});

/**
 * The field that cost months: chunks are **numbered**, not addressed by byte.
 *
 * `[0, 2048, 4096]` is what this asserted before, and it was wrong. Transfer's own upload of a
 * 114,746-byte project sends `0, 1, 2, 3`, and the device's replies count the bytes for us. The old
 * expectation agreed with the wire only at the first chunk, where the index and the offset are both
 * zero — which is every single-chunk capture we had.
 */
test("a long file is split, and every chunk carries its index", async () => {
  const io = accepting();
  const bytes = stored(new Uint8Array(5000).fill(0xab));

  const result = await writeStoredFile("/projects/9", bytes, 1, { transport: io, target: entry(), chunkSize: 2048, permit: TEST_PERMIT });

  assert.equal(result.chunks, 3);
  const indices = io.sent.filter((s) => s.code === StorageCode.Write).map((s) => u32(s.body, 4));
  assert.deepEqual(indices, [0, 1, 2], "chunk numbers, not byte offsets");

  // And field 4 is each chunk's own length — so the short last one declares 904, not 2,048.
  // Declaring the nominal size there is refused on hardware; see `writeChunkRequest`.
  const declared = io.sent.filter((s) => s.code === StorageCode.Write).map((s) => u32(s.body, 12));
  assert.deepEqual(declared, [2048, 2048, 904], "each chunk's own length, not the file's total");
  assert.equal(io.sent.filter((s) => s.code === StorageCode.Write)[2]!.body.length - 16, 904);
});

/**
 * Each chunk declares **its own** checksum, not the whole file's.
 *
 * Measured on hardware 2026-08-13 from the read side — a read reports one checksum per chunk and
 * `driveChecksum` reproduces each over that chunk's own slice — and confirmed 2026-08-15 by
 * Transfer's own upload, whose three chunks carry three distinct values.
 *
 * This module used to default to the whole file's value. **At one chunk the two are the same
 * number**, so the single 269-byte upload the protocol was copied from could not tell them apart,
 * and the wrong model passed the only test there was. The single-chunk test above is that case, and
 * it is exactly why this one has to exist beside it.
 */
test("by default every chunk declares its own slice's checksum", async () => {
  const io = accepting();
  // Deliberately not uniform bytes: a file of one repeated value gives identical slices, and two
  // chunks agreeing by accident would prove nothing either way.
  const bytes = stored(new Uint8Array(5000).map((_, i) => (i * 7 + (i >> 5)) & 0xff));

  await writeStoredFile("/projects/9", bytes, undefined, {
    transport: io,
    target: entry(),
    permit: TEST_PERMIT,
    chunkSize: 2048,
  });

  const writes = io.sent.filter((s) => s.code === StorageCode.Write);
  assert.equal(writes.length, 3);

  const boundaries = [0, 2048, 4096, 5000];
  assert.deepEqual(
    writes.map((s) => u32(s.body, 8)),
    boundaries.slice(0, 3).map((from, i) => driveChecksum(bytes.subarray(from, boundaries[i + 1]!))),
  );
  // And they really are three different numbers, so the assertion above cannot pass by coincidence.
  assert.equal(new Set(writes.map((s) => u32(s.body, 8))).size, 3);
  assert.notEqual(u32(writes[0]!.body, 8), driveChecksum(bytes), "not the whole file's value");
});

/**
 * The captured upload, reproduced field for field.
 *
 * Transfer sending `MORNING_JA 1640(2)` — 114,746 bytes — to `/projects/12`, recorded with USBPcap
 * on 2026-08-15. This is the only multi-chunk write anyone has ever seen, and every number below
 * came off the wire rather than from a hypothesis.
 *
 * It exists because three separate guesses about these fields all passed a single-chunk test: the
 * checksum's scope, the index-versus-offset question, and the meaning of field 4. **A single chunk
 * cannot distinguish any of them**, so the regression test for all three has to be a multi-chunk
 * one, tied to real captured values.
 */
test("Transfer's own upload is reproduced field for field", async () => {
  const io = accepting();
  const total = 114_746;
  const bytes = stored(new Uint8Array(total).map((_, i) => (i * 31 + (i >> 9)) & 0xff));

  const result = await writeStoredFile("/projects/12", bytes, undefined, {
    transport: io,
    target: entry(),
    permit: TEST_PERMIT,
  });

  // Four chunks of 32,768, the last partial — which is what the device's cumulative replies said:
  // 32,768 / 65,536 / 98,304 / 114,746.
  assert.equal(result.chunks, 4);
  assert.equal(result.written, total);

  const writes = io.sent.filter((s) => s.code === StorageCode.Write);
  assert.deepEqual(writes.map((s) => u32(s.body, 4)), [0, 1, 2, 3], "chunk index");
  assert.deepEqual(
    writes.map((s) => u32(s.body, 12)),
    [32_768, 32_768, 32_768, total - 3 * 32_768],
    "each chunk's own length — the last one is short and says so",
  );
  assert.deepEqual(
    writes.map((s) => s.body.length - 16),
    writes.map((s) => u32(s.body, 12)),
    "the declared length always equals the data actually carried",
  );

  // The open declares the file's total; only the open does.
  assert.equal(u32(io.sent[0]!.body, 0), total);

  // Four distinct per-chunk checksums, none of them the whole file's.
  const sums = writes.map((s) => u32(s.body, 8));
  assert.equal(new Set(sums).size, 4);
  assert.ok(!sums.includes(driveChecksum(bytes)));
});


/**
 * The raw form is refused before a byte is sent.
 *
 * On hardware the raw form gets **every chunk accepted** and then fails at the commit with
 * `Footer was not processed` — after the whole file has crossed the wire, with an error nobody could
 * guess from. One byte at `+29` says which form a container is in, so the shape is checked here.
 */
test("the raw uncompressed form is refused, and the message says how to fix it", async () => {
  const io = accepting();
  const raw = new Uint8Array(500).fill(7);
  raw[FORM_FLAG_OFFSET] = 0x00;

  await assert.rejects(
    writeStoredFile("/kits/A/15", raw, undefined, { transport: io, target: entry(), permit: TEST_PERMIT }),
    /raw uncompressed form/,
  );
  assert.deepEqual(io.sent, [], "nothing was sent — the point is to fail before the transfer");

  // And the stored form passes the same check.
  const ok = Uint8Array.from(raw);
  ok[FORM_FLAG_OFFSET] = 0x01;
  assert.doesNotThrow(() => refuseRawForm(ok, "/kits/A/15"));

  // Something too short to hold a container header is not this guard's business to judge.
  assert.doesNotThrow(() => refuseRawForm(new Uint8Array(4), "/kits/A/15"));
});

test("a per-chunk function reaches the wire, because that hypothesis had to be tried", async () => {
  // The device refused this on hardware: `Invalid package checksum; corrupt transfer`. The test
  // asserts the *mechanism*, not that the device likes it — the next hypothesis about this field
  // should be a call rather than an edit to `storagewrite.ts`, and this is what keeps that true.
  const io = accepting();
  const bytes = stored(new Uint8Array(5000).map((_, i) => (i * 7 + (i >> 5)) & 0xff));

  await writeStoredFile("/projects/9", bytes, (slice) => driveChecksum(slice), {
    transport: io,
    target: entry(),
    permit: TEST_PERMIT,
    chunkSize: 2048,
  });

  const writes = io.sent.filter((s) => s.code === StorageCode.Write);
  const boundaries = [0, 2048, 4096, 5000];
  for (const [i, sent] of writes.entries()) {
    const slice = bytes.subarray(boundaries[i]!, boundaries[i + 1]!);
    assert.equal(u32(sent.body, 8), driveChecksum(slice), `chunk ${i} carried its own slice's value`);
  }
});

test("a declared checksum overrides every chunk, for the corruption experiment", async () => {
  // The one caller that wants this: deliberately sending a wrong value to find out whether the
  // field is enforced. It must reach *every* chunk, or a multi-chunk corruption test would send
  // one bad chunk and two good ones and prove nothing.
  const io = accepting();
  const bytes = stored(new Uint8Array(3000).fill(0x5a));

  await writeStoredFile("/projects/9", bytes, 0xdeadbeef, {
    transport: io,
    target: entry(),
    permit: TEST_PERMIT,
    chunkSize: 2048,
  });

  const sums = io.sent.filter((s) => s.code === StorageCode.Write).map((s) => u32(s.body, 8));
  assert.deepEqual(sums, [0xdeadbeef, 0xdeadbeef]);
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
    writeStoredFile("/soundbanks/C/29", Uint8Array.of(1), 0, { transport: io, target: entry(), permit: TEST_PERMIT }),
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
    writeStoredFile("/projects/9", Uint8Array.of(1, 2, 3), 0, { transport: io, target: entry(), permit: TEST_PERMIT }),
    /device went silent/,
  );
  assert.ok(!io.sent.includes(StorageCode.WriteClose), "nothing was committed");
});

function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}
