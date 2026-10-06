/**
 * `/wavepool/<project slot>` as a file: the record, the container, and every refusal.
 *
 * ## What this does not prove
 *
 * **There is no second implementation yet.** `waveriderslotfile.test.ts` can check DNX against
 * bytes the firmware session's generator produced and their emulator accepted; the pool route is a
 * proposal (`dn2_firmware/docs/for-dnx-waverider-pool.md`, revision 3) and nothing on the
 * instrument answers it. So this pins the layout against the document, by hand, and pins the
 * behaviour against itself. It cannot say the firmware agrees.
 *
 * The field positions below are therefore written out as literals rather than taken from `RECORD`,
 * so that a mistake in the module is not also the mistake in the test. When the firmware has a
 * build, a reference record from it replaces the hand-written half of this file.
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
  emptyPoolFile,
  hasStoredPool,
  poolState,
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

test("an empty list is a different thing from an automatic one", () => {
  // The owner's call for CREATE NEW, 2026-10-06: a new project's sound pool starts empty, so its
  // wavetable pool does. The difference is audible — an empty list gives a sound the two built-ins
  // and nothing else, where automatic gives it every playable table on the card.
  const empty = readPoolFile(emptyPoolFile(7));
  assert.equal(empty.automatic, false);
  assert.equal(empty.entries.filter((e) => e !== undefined).length, 0);

  const automatic = readPoolFile(automaticPoolFile(7));
  assert.equal(automatic.automatic, true);

  // They differ in the flags word and nowhere else, which is exactly why the flag is load-bearing.
  const a = body(emptyPoolFile(7));
  const b = body(automaticPoolFile(7));
  const differing: number[] = [];
  for (let i = 0; i < AT.hash; i++) if (a[i] !== b[i]) differing.push(i);
  assert.deepEqual(differing, [AT.flags + 1]);
});

test("poolState names the three a read can describe", () => {
  // A project saved before the lists: the firmware made this record up to answer the read.
  assert.equal(poolState({ ...sample(), automatic: true, entries: [], generation: 0 }), "untouched");
  // The same thing on purpose, and a stored fact.
  assert.equal(poolState({ ...sample(), automatic: true, entries: [], generation: 2 }), "automatic");
  // A list, which may hold nothing: what CREATE NEW writes.
  assert.equal(poolState({ ...sample(), automatic: false, entries: [], generation: 2 }), "list");
  assert.equal(poolState({ ...sample(), generation: 9 }), "list");
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
