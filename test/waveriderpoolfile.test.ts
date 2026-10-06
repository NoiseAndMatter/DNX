/**
 * `/wavepool/<project slot>` as a file: the record, the container, and every refusal.
 *
 * ## The firmware agrees, byte for byte
 *
 * Three files this codec built were written to the instrument's `/wavepool` route on the
 * `waverider-pool2` build in digikit's emulator and read straight back. **All 555 bytes of each
 * read-back equal what `buildPoolFile` produces for the same record at generation 1**, container,
 * record, hash and trailer CRC alike, and their reader accepted all three. The negative control
 * matters as much: the same file with one hash byte flipped was refused by the firmware, the slot
 * read back as having no record, and the comparison failed at byte 44. So the comparison can fail.
 *
 * The literals below are from those read-backs (`dn2_firmware/out/wavepool_vectors/`), so they are
 * bytes a second implementation produced rather than a second reading of the same document. The
 * field positions are still written out rather than taken from `RECORD`, so that a mistake in the
 * module is not also the mistake in the test.
 *
 * **One limit on the automatic vector.** The card had an empty store, so `automatic-slot0` reads
 * back with no entries filled and compares as sent. With tables stored, an automatic read fills
 * the entries from the store, and that case is not pinned here.
 *
 * ## The one that matters
 *
 * `an automatic record cannot carry entries` is not a tidiness check. A read of a project with no
 * pool of its own comes back with the automatic flag set and its entries filled with what that
 * project plays, so read-change-write is a write the firmware ignores, and both sides refuse it
 * rather than let it report success. It is the slot 9 shape: a commit that answers ok and writes
 * nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTENT_KIND_POOL,
  FLAG_AUTOMATIC,
  FORMAT_VERSION,
  NO_TABLE,
  POOL_FORMAT_VERSION,
  POOL_RECORD_BYTES,
  PROJECT_SLOTS,
  type PoolRecord,
  automaticPoolFile,
  buildPoolFile,
  hasStoredPool,
  readPoolFile,
} from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import {
  DATA_START,
  ERASE_GROUP_SECTORS,
  GROUP_B,
  INDEX_SECTORS,
  POOL_A_BASE,
  POOL_B_BASE,
  poolRecordSector,
} from "@noiseandmatter/dnx-core/waverider/layout.js";
import { POOL_ENTRIES, automaticEntries } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { FORMAT_VERSION as STORE_ASCII } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { HEAD, HEADER_BYTES, TRAILER_BYTES } from "@noiseandmatter/dnx-core/project/container.js";

/** Hand-written offsets, from the document and not from the module. */
const AT = {
  magic: 0,
  version: 4,
  projectSlot: 6,
  generation: 8,
  entriesInUse: 12,
  flags: 14,
  entries: 16,
  reservedFrom: 270,
  hash: 508,
} as const;

const FILE_BYTES = HEADER_BYTES + POOL_RECORD_BYTES + TRAILER_BYTES;

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** The record inside a file, as a view. */
function body(file: Uint8Array): Uint8Array {
  return file.subarray(HEADER_BYTES, file.length - TRAILER_BYTES);
}

/**
 * Change a record's bytes and re-stamp its hash, so a refusal test reaches the check it is about.
 *
 * Without the re-stamp every tamper test would stop at the hash and prove only that the hash check
 * works, which is one test, not nine.
 */
function tamper(file: Uint8Array, mutate: (record: Uint8Array) => void): Uint8Array {
  const copy = Uint8Array.from(file);
  const record = body(copy);
  mutate(record);
  const hash = xxHash32(record.subarray(0, AT.hash));
  record[AT.hash] = (hash >>> 24) & 0xff;
  record[AT.hash + 1] = (hash >>> 16) & 0xff;
  record[AT.hash + 2] = (hash >>> 8) & 0xff;
  record[AT.hash + 3] = hash & 0xff;
  return copy;
}

/** A pool with three tables in it, at pool indices 0, 1 and 5. */
function sample(): PoolRecord {
  const entries: (number | undefined)[] = new Array<number | undefined>(POOL_ENTRIES).fill(undefined);
  entries[0] = 0;
  entries[1] = 7;
  entries[5] = 255;
  return { projectSlot: 4, automatic: false, entries, generation: 0 };
}

test("a pool record round-trips, and the entries come back 127 long", () => {
  const file = buildPoolFile(sample());
  assert.equal(file.length, FILE_BYTES);

  const read = readPoolFile(file);
  assert.equal(read.projectSlot, 4);
  assert.equal(read.automatic, false);
  assert.equal(read.entries.length, POOL_ENTRIES);
  assert.equal(read.entries[0], 0);
  assert.equal(read.entries[1], 7);
  assert.equal(read.entries[5], 255);
  assert.equal(read.entries[2], undefined);
  assert.equal(read.entries[POOL_ENTRIES - 1], undefined);
});

test("a short entry list is padded rather than refused", () => {
  const read = readPoolFile(
    buildPoolFile({ projectSlot: 1, automatic: false, entries: [3, undefined, 9], generation: 0 }),
  );
  assert.equal(read.entries.length, POOL_ENTRIES);
  assert.deepEqual(read.entries.slice(0, 3), [3, undefined, 9]);
});

test("the record's fields sit where the document says", () => {
  const record = body(buildPoolFile(sample()));

  assert.deepEqual([...record.subarray(AT.magic, AT.magic + 4)], [0x57, 0x52, 0x50, 0x4c]);
  assert.equal(be16(record, AT.version), POOL_FORMAT_VERSION);
  assert.equal(be16(record, AT.projectSlot), 4);
  assert.equal(be16(record, AT.entriesInUse), 3, "the count is computed, not passed");
  assert.equal(be16(record, AT.flags), 0);

  assert.equal(be16(record, AT.entries + 0 * 2), 0, "store slot 0 is a store slot, not an absence");
  assert.equal(be16(record, AT.entries + 1 * 2), 7);
  assert.equal(be16(record, AT.entries + 2 * 2), NO_TABLE);
  assert.equal(be16(record, AT.entries + 5 * 2), 255);

  assert.equal(AT.entries + POOL_ENTRIES * 2, AT.reservedFrom, "127 entries end at 270");
  for (let at = AT.reservedFrom; at < AT.hash; at++) {
    assert.equal(record[at], 0, `byte ${at} is reserved and zero`);
  }
  assert.equal(be32(record, AT.hash), xxHash32(record.subarray(0, AT.hash)));
});

test("the container is a raw 0x50 of 512 bytes, stamped with the project slot", () => {
  const file = buildPoolFile({ ...sample(), projectSlot: 128 });

  assert.equal(be32(file, HEAD.contentKind), CONTENT_KIND_POOL);
  assert.equal(be32(file, HEAD.objectVersion), POOL_FORMAT_VERSION);
  assert.equal(be32(file, HEAD.index), 128);
  assert.equal(file[HEAD.index + 3], 128, "the low byte is the project slot");
  assert.equal(be32(file, HEAD.bodyLength), POOL_RECORD_BYTES);
  assert.equal(file[HEAD.compressed], 0, "raw, as /waverider is");
  assert.equal(
    String.fromCharCode(...file.subarray(HEAD.formatVersion, HEAD.formatVersion + 4)),
    FORMAT_VERSION,
  );
});

test("the pool's format-version ASCII has not drifted from the store's", () => {
  // The same firmware writer emits both. Two spellings of one fact is how they come apart.
  assert.equal(FORMAT_VERSION, STORE_ASCII);
});

test("an automatic record carries no entries, and says so when asked to", () => {
  const file = automaticPoolFile(9);
  const record = body(file);
  assert.equal(be16(record, AT.flags), FLAG_AUTOMATIC);
  assert.equal(be16(record, AT.entriesInUse), 0);
  for (let j = 0; j < POOL_ENTRIES; j++) {
    assert.equal(be16(record, AT.entries + j * 2), NO_TABLE);
  }

  const read = readPoolFile(file);
  assert.equal(read.automatic, true);
  assert.equal(read.projectSlot, 9);
});

test("an automatic record cannot carry entries: the read-then-write trap", () => {
  // What a read of a project with no pool of its own hands back: the flag set, and the entries
  // filled with what it plays. Writing that back unchanged is the write that does nothing.
  const asRead: PoolRecord = {
    projectSlot: 12,
    automatic: true,
    entries: automaticEntries([0, 3, 4]),
    generation: 0,
  };
  assert.throws(
    () => buildPoolFile(asRead),
    (error: unknown) =>
      error instanceof WaveriderError && /automatic pool cannot carry entries/.test(error.message),
  );

  // And the two ways out of it, both of which are a real intention.
  assert.equal(readPoolFile(buildPoolFile({ ...asRead, automatic: false })).automatic, false);
  assert.equal(readPoolFile(buildPoolFile({ ...asRead, entries: [] })).automatic, true);
});

test("the automatic entries are the playable slots in store-slot order", () => {
  const entries = automaticEntries([9, 2, 2, 40]);
  assert.deepEqual(entries.slice(0, 4), [2, 9, 40, undefined]);
  assert.equal(entries.length, POOL_ENTRIES);

  // The 128th playable table onward has no pool index at all, as it has none today.
  const many = automaticEntries(Array.from({ length: 200 }, (_, i) => i));
  assert.equal(many[POOL_ENTRIES - 1], POOL_ENTRIES - 1);
  assert.equal(many.length, POOL_ENTRIES);
});

test("only a stored record has a generation", () => {
  assert.equal(hasStoredPool({ ...sample(), generation: 0 }), false);
  assert.equal(hasStoredPool({ ...sample(), generation: 1 }), true);
});

test("a build refuses what the firmware refuses", () => {
  const ok = sample();
  assert.throws(() => buildPoolFile({ ...ok, projectSlot: PROJECT_SLOTS }), WaveriderError);
  assert.throws(() => buildPoolFile({ ...ok, projectSlot: -1 }), WaveriderError);
  assert.throws(
    () => buildPoolFile({ ...ok, entries: new Array<undefined>(POOL_ENTRIES + 1).fill(undefined) }),
    WaveriderError,
  );
  assert.throws(() => buildPoolFile({ ...ok, entries: [256] }), WaveriderError);
  assert.throws(() => buildPoolFile({ ...ok, entries: [-1] }), WaveriderError);
  assert.throws(() => buildPoolFile({ ...ok, entries: [NO_TABLE] }), WaveriderError);
});

test("a read refuses a file that is not a pool record", () => {
  const good = buildPoolFile(sample());

  assert.throws(() => readPoolFile(good.subarray(0, good.length - 1)), WaveriderError);

  const wrongKind = Uint8Array.from(good);
  wrongKind[HEAD.contentKind + 3] = 0x57;
  assert.throws(
    () => readPoolFile(wrongKind),
    (error: unknown) => error instanceof WaveriderError && /not a pool record/.test(error.message),
  );

  const wrongVersion = Uint8Array.from(good);
  wrongVersion[HEAD.objectVersion + 3] = 2;
  assert.throws(() => readPoolFile(wrongVersion), WaveriderError);

  const compressed = Uint8Array.from(good);
  compressed[HEAD.compressed] = 1;
  assert.throws(() => readPoolFile(compressed), WaveriderError);

  const restamped = Uint8Array.from(good);
  restamped[HEAD.index + 3] = 5;
  assert.throws(
    () => readPoolFile(restamped),
    (error: unknown) => error instanceof WaveriderError && /stamped 5/.test(error.message),
  );

  const broken = Uint8Array.from(good);
  const brokenRecord = body(broken);
  brokenRecord[AT.hash] = brokenRecord[AT.hash]! ^ 0xff;
  assert.throws(
    () => readPoolFile(broken),
    (error: unknown) => error instanceof WaveriderError && /hash does not match/.test(error.message),
  );
});

test("a read refuses a record whose own fields disagree", () => {
  const good = buildPoolFile(sample());

  assert.throws(
    () => readPoolFile(tamper(good, (r) => void (r[AT.magic] = 0x58))),
    (error: unknown) => error instanceof WaveriderError && /WRPL/.test(error.message),
  );
  assert.throws(() => readPoolFile(tamper(good, (r) => void (r[AT.version + 1] = 2))), WaveriderError);
  assert.throws(
    () => readPoolFile(tamper(good, (r) => void (r[AT.entriesInUse + 1] = 2))),
    (error: unknown) => error instanceof WaveriderError && /counts 2 entries/.test(error.message),
  );
  assert.throws(
    () => readPoolFile(tamper(good, (r) => void (r[AT.flags + 1] = 0x02))),
    (error: unknown) => error instanceof WaveriderError && /does not define/.test(error.message),
  );
  assert.throws(
    () => readPoolFile(tamper(good, (r) => void (r[AT.reservedFrom] = 1))),
    (error: unknown) => error instanceof WaveriderError && /reserved and zero/.test(error.message),
  );
  assert.throws(
    () => readPoolFile(tamper(good, (r) => void (r[AT.entries + 2 * 2] = 0x01))),
    (error: unknown) => error instanceof WaveriderError && /pool index 2/.test(error.message),
  );
  assert.throws(
    () => readPoolFile(tamper(good, (r) => void (r[AT.projectSlot + 1] = 99))),
    (error: unknown) => error instanceof WaveriderError && /stamped 4/.test(error.message),
  );
});

test("the two copies of a pool record are in different erase groups", () => {
  // The point of writing A and B alternately. 256 sectors apart, which was DNX's first suggestion,
  // put both inside one 0x400-sector erase group and bought nothing.
  assert.equal(POOL_A_BASE % ERASE_GROUP_SECTORS, 0);
  assert.equal(POOL_B_BASE % ERASE_GROUP_SECTORS, 0);
  assert.notEqual(
    Math.floor(POOL_A_BASE / ERASE_GROUP_SECTORS),
    Math.floor(POOL_B_BASE / ERASE_GROUP_SECTORS),
  );

  const lastA = poolRecordSector("A", PROJECT_SLOTS - 1);
  const lastB = poolRecordSector("B", PROJECT_SLOTS - 1);
  assert.equal(poolRecordSector("A", 0), POOL_A_BASE);
  assert.equal(poolRecordSector("B", 0), POOL_B_BASE);

  // Clear of group B's index below, and of the first slot's data above.
  assert.ok(POOL_A_BASE > GROUP_B.index + INDEX_SECTORS);
  assert.ok(lastA < POOL_B_BASE);
  assert.ok(lastB < DATA_START);
  assert.equal(
    Math.floor(lastA / ERASE_GROUP_SECTORS),
    Math.floor(POOL_A_BASE / ERASE_GROUP_SECTORS),
    "a band does not spill into the next erase group",
  );
});

/**
 * What the firmware read back, for the three files this codec built.
 *
 * From `dn2_firmware/out/wavepool_vectors/`, written to the instrument's `/wavepool` route on the
 * `waverider-pool2` build and read straight back. The generation is the firmware's: it ignores
 * what a writer sends and stamps `current + 1`, which is 1 for a first write.
 */
const FIRMWARE_VECTORS = [
  {
    file: "explicit-slot3.bin",
    record: { projectSlot: 3, automatic: false, entries: [3, undefined, 0], generation: 1 },
    header: [
      0xac, 0x11, 0xd3, 0x03, 0x02, 0x00, 0x05, 0x00, 0x0f, 0x30, 0x30, 0x35, 0x39, 0x00, 0x00,
      0x00, 0x50, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x02, 0x00, 0x00,
      0x0c,
    ],
    recordHead: [
      0x57, 0x52, 0x50, 0x4c, 0x00, 0x01, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00,
      0x00, 0x00, 0x03, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff,
    ],
    recordHash: [0x0e, 0xe9, 0x09, 0xd2],
    trailer: [0xc3, 0x4b, 0x8c, 0x1e, 0x00, 0x00, 0x02, 0x00, 0xaa, 0xa1, 0xda, 0xaa],
    whole: 0xde3946fd,
  },
  {
    file: "automatic-slot0.bin",
    record: { projectSlot: 0, automatic: true, entries: [], generation: 1 },
    header: [
      0xac, 0x11, 0xd3, 0x03, 0x02, 0x00, 0x05, 0x00, 0x0f, 0x30, 0x30, 0x35, 0x39, 0x00, 0x00,
      0x00, 0x50, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
      0x0c,
    ],
    recordHead: [
      0x57, 0x52, 0x50, 0x4c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ],
    recordHash: [0xcb, 0xed, 0xfd, 0x26],
    trailer: [0x29, 0xb5, 0x1e, 0x85, 0x00, 0x00, 0x02, 0x00, 0xaa, 0xa1, 0xda, 0xaa],
    whole: 0xe59a75e7,
  },
  {
    file: "full-slot128.bin",
    record: {
      projectSlot: 128,
      automatic: false,
      entries: Array.from({ length: POOL_ENTRIES }, (_, j) => (j * 2) % 256),
      generation: 1,
    },
    header: [
      0xac, 0x11, 0xd3, 0x03, 0x02, 0x00, 0x05, 0x00, 0x0f, 0x30, 0x30, 0x35, 0x39, 0x00, 0x00,
      0x00, 0x50, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x02, 0x00, 0x00,
      0x0c,
    ],
    recordHead: [
      0x57, 0x52, 0x50, 0x4c, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x01, 0x00, 0x7f, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x04, 0x00, 0x06,
    ],
    recordHash: [0x59, 0xe2, 0xc3, 0xda],
    trailer: [0xb8, 0x25, 0x29, 0x64, 0x00, 0x00, 0x02, 0x00, 0xaa, 0xa1, 0xda, 0xaa],
    whole: 0x1cc3b647,
  },
] as const;

for (const vector of FIRMWARE_VECTORS) {
  test(`${vector.file}: the firmware's read-back is what this codec builds`, () => {
    const built = buildPoolFile(vector.record);
    assert.equal(built.length, FILE_BYTES);

    // Row by row first, so a failure says which part moved rather than only that something did.
    assert.deepEqual([...built.subarray(0, 31)], [...vector.header], "container header");
    assert.deepEqual([...body(built).subarray(0, 24)], [...vector.recordHead], "record head");
    assert.deepEqual([...body(built).subarray(AT.hash, AT.hash + 4)], [...vector.recordHash], "record hash");
    assert.deepEqual([...built.subarray(FILE_BYTES - 12)], [...vector.trailer], "container trailer");

    // Then the whole file, which is the part the rows above cannot cover: 512 bytes of entries.
    assert.equal(xxHash32(built) >>> 0, vector.whole, "the whole 555 bytes");

    // And it reads back as the record it was built from.
    const read = readPoolFile(built);
    assert.equal(read.projectSlot, vector.record.projectSlot);
    assert.equal(read.automatic, vector.record.automatic);
    assert.equal(read.generation, 1, "the firmware stamps current + 1, and a first write is 1");
  });
}
