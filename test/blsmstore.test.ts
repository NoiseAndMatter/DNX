/**
 * The Bloom prototype store's records and files, against layouts worked from the firmware
 * session's proposal of 2026-10-25. The expected offsets and values are written out from that
 * text, not taken from `blsm.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INDEX_BYTES,
  MAX_PAYLOAD_BYTES,
  readStoreEntry,
  readStoreSuperblock,
  type StoreEntry,
  writeStoreEntry,
  writeStoreSuperblock,
} from "@noiseandmatter/dnx-core/sample/blsm.js";
import {
  buildSampleFile,
  readIndexFile,
  readSampleFile,
  payloadOf,
} from "@noiseandmatter/dnx-core/sample/storefile.js";
import { firstFreeEntry, stampedFor } from "@noiseandmatter/dnx-core/device/samplestore.js";
import { buildContainer, HEADER_BYTES } from "@noiseandmatter/dnx-core/project/container.js";
import { storedSample } from "@noiseandmatter/dnx-core/sample/format.js";
import { identify } from "@noiseandmatter/dnx-core/sample/identity.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { SampleError } from "@noiseandmatter/dnx-core/sample/errors.js";

const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;

const ENTRY: StoreEntry = {
  n: 0,
  channels: 2,
  frames: 3,
  startSector: 0x1400,
  extentSectors: 1024,
  payloadHash: 0xdeadbeef,
  identityHash: "0123456789abcdef",
  name: "drums/Kick é",
  gain: 1,
};

test("an entry sits at the proposal's offsets", () => {
  const b = writeStoreEntry(ENTRY);
  assert.equal(b.length, 128);
  assert.equal(be16(b, 0), 1, "flags: used");
  assert.equal(be16(b, 2), 2, "kind: sample");
  assert.equal(be16(b, 4), 2, "channels");
  assert.equal(be16(b, 6), 1, "format: int16 big-endian");
  assert.equal(be32(b, 8), 48_000);
  assert.equal(be32(b, 12), 3);
  assert.equal(be32(b, 16), 0x1400);
  assert.equal(be32(b, 20), 0xdeadbeef);
  assert.deepEqual([...b.subarray(24, 32)], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef], "identity big-endian");
  assert.equal(b[32 + 11], 0xe9, "é in Windows-1252");
  assert.equal(b[32 + 12], 0, "NUL-padded");
  assert.equal(be32(b, 96), 0x00010000, "gain 1.0 in 16.16");
  assert.equal(be32(b, 100), 1024);
  assert.ok(b.subarray(104).every((v) => v === 0));
  assert.deepEqual(readStoreEntry(b, 0), ENTRY);
  assert.equal(readStoreEntry(new Uint8Array(128), 0), undefined, "an all-zero entry is free");
});

function indexWith(entries: StoreEntry[]): Uint8Array {
  const index = new Uint8Array(INDEX_BYTES);
  for (const e of entries) index.set(writeStoreEntry(e), e.n * 128);
  return index;
}

function indexFile(body: Uint8Array): Uint8Array {
  return buildContainer({ body, contentKind: 0x53, objectVersion: 1, index: 0xffff, formatVersion: "0059" });
}

test("a superblock is valid only against its own index", () => {
  const index = indexWith([ENTRY]);
  const meta = { generation: 4, entryCount: 1, dataStart: 0x1000, dataEnd: 0x20000 };
  const sector = writeStoreSuperblock(meta, index);
  assert.deepEqual([...sector.subarray(0, 4)], [0x42, 0x4c, 0x53, 0x4d], "BLSM");
  assert.equal(be32(sector, 60), xxHash32(sector.subarray(0, 60)));
  assert.deepEqual(readStoreSuperblock(sector, index), meta);
  assert.equal(readStoreSuperblock(sector, indexWith([{ ...ENTRY, frames: 4 }])), undefined);
});

test("/samples/index: zeros are an empty store, a valid group lists its entries, anything else is refused", () => {
  assert.deepEqual(readIndexFile(indexFile(new Uint8Array(64 + INDEX_BYTES))), { superblock: undefined, entries: [] });

  const entries = [ENTRY, { ...ENTRY, n: 5, identityHash: "fedcba9876543210" }];
  const index = indexWith(entries);
  const meta = { generation: 1, entryCount: 2, dataStart: 0x1000, dataEnd: 0x20000 };
  const good = new Uint8Array(64 + INDEX_BYTES);
  good.set(writeStoreSuperblock(meta, index).subarray(0, 64), 0);
  good.set(index, 64);
  const read = readIndexFile(indexFile(good));
  assert.deepEqual(read.superblock, meta);
  assert.deepEqual(read.entries.map((e) => e.n), [0, 5]);
  assert.equal(firstFreeEntry(read), 1);

  const torn = good.slice();
  const at = 64 + 5 * 128 + 12;
  torn[at] = torn[at]! ^ 1;
  assert.throws(() => readIndexFile(indexFile(torn)), /not valid/);
  assert.throws(() => readIndexFile(indexFile(good.subarray(0, 64 + 128))), /body is/);
});

test("a sample file carries the entry with start and extent zero, then the big-endian payload", () => {
  const sample = storedSample(2, Int16Array.from([1, -2, 0x1234, -32_768]));
  const id = identify(sample);
  const file = buildSampleFile({ n: 300, id, sample, name: "pad" });
  const body = file.subarray(HEADER_BYTES, HEADER_BYTES + 128 + 8);
  assert.equal(be32(body, 16), 0, "start: the firmware allocates");
  assert.equal(be32(body, 100), 0, "extent: the firmware allocates");
  assert.deepEqual([...body.subarray(128)], [0x00, 0x01, 0xff, 0xfe, 0x12, 0x34, 0x80, 0x00]);
  assert.equal(be32(body, 20), xxHash32(payloadOf(sample)));

  const back = readSampleFile(file);
  assert.equal(back.entry.identityHash, id.hash);
  assert.equal(back.entry.frames, 2);

  // The read-back excuses the 8 allocated bytes and the CRC, and nothing else.
  const stamped = stampedFor(file);
  assert.equal(stamped.size, 12);
  assert.ok(stamped.has(HEADER_BYTES + 16) && stamped.has(HEADER_BYTES + 103) && stamped.has(file.length - 12));
  assert.ok(!stamped.has(HEADER_BYTES + 20), "the payload hash is compared");
});

test("a file the firmware would refuse is refused before the wire", () => {
  const sample = storedSample(1, new Int16Array(4));
  const id = identify(sample);
  assert.throws(() => buildSampleFile({ n: 1024, id, sample, name: "x" }), /outside/);
  assert.throws(() => buildSampleFile({ n: 0, id: { ...id, size: 6 }, sample, name: "x" }), /identity says/);
  const big = storedSample(1, new Int16Array(MAX_PAYLOAD_BYTES / 2 + 1));
  assert.throws(() => buildSampleFile({ n: 0, id: identify(big), sample: big, name: "big" }), /at most/);
  const limit = storedSample(1, new Int16Array(MAX_PAYLOAD_BYTES / 2));
  assert.equal(buildSampleFile({ n: 0, id: identify(limit), sample: limit, name: "limit" }).length > MAX_PAYLOAD_BYTES, true);
});
