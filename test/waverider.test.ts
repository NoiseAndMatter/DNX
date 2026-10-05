/**
 * The Waverider store: layout, codec, plan and conversion.
 *
 * The shared definition is `dn2_firmware/docs/waverider-store.md`. **None of this has run on an
 * instrument**, and the firmware session has not read a store DNX wrote, so what these tests check
 * is that DNX agrees with the document — not that the document is right about the device.
 *
 * Two things they deliberately do not do:
 *
 * - **No fixture is a hash this file computed and then asserted.** Where a hash appears as a
 *   literal it came from the firmware's own routine. Everywhere else the assertion is a property
 *   — that two things differ, that a round trip holds — which is what a self-computed value can
 *   honestly support.
 * - **The write ordering is asserted, not assumed.** Data, then index, then superblock is the rule
 *   that makes a cancelled transfer survivable, and it is one refactor away from being silently
 *   wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import {
  DATA_END,
  DATA_START,
  ENTRY_BYTES,
  EXTENT_ALIGN,
  FAST_END,
  FAST_SECTORS,
  GROUP_A,
  GROUP_B,
  INDEX_BYTES,
  INDEX_ENTRIES,
  INDEX_SECTORS,
  REGION_START,
  SECTOR,
  absolute,
  sectorsFor,
} from "@noiseandmatter/dnx-core/waverider/layout.js";
import {
  type TableEntry,
  FORMAT_INT16_BE,
  SUPERBLOCK_BYTES,
  WaveriderError,
  currentGroup,
  readIndex,
  readSuperblock,
  validateIndex,
  writeIndex,
  writeSuperblock,
} from "@noiseandmatter/dnx-core/waverider/store.js";
import {
  type PendingTable,
  describePlan,
  planWrite,
} from "@noiseandmatter/dnx-core/waverider/plan.js";
import {
  FULL_SCALE,
  convertTable,
  readTableSamples,
  tableName,
} from "@noiseandmatter/dnx-core/waverider/convert.js";

// --- the arithmetic, which is where a transcription slip hides ----------------------------------

test("the layout closes on the document's numbers", () => {
  assert.equal(REGION_START, 0x600000, "3,072 MiB in");
  assert.equal(REGION_START * SECTOR, 3_221_225_472);

  // The index is 256 x 128 = 32 KiB, which is 64 sectors — the document's "sectors 1..64".
  assert.equal(INDEX_ENTRIES * ENTRY_BYTES, INDEX_BYTES);
  assert.equal(INDEX_BYTES, 32_768);
  assert.equal(INDEX_SECTORS, 64);

  // Group A holds its superblock and index in sectors 0..64; B starts a whole erase group later.
  assert.equal(GROUP_A.superblock, 0);
  assert.equal(GROUP_A.index, 1);
  assert.equal(GROUP_B.superblock, 0x400, "512 KiB, one HC_ERASE_GRP_SIZE");
  assert.equal(GROUP_B.superblock * SECTOR, 524_288);
  assert.ok(GROUP_A.index + INDEX_SECTORS <= GROUP_B.superblock, "A's index must not reach B");
  assert.ok(GROUP_B.index + INDEX_SECTORS <= DATA_START, "B's index must not reach the data");

  // The two frames for the pSLC boundary, which is the mix-up this pair of names exists to stop.
  assert.equal(FAST_END, 0x618000, "absolute");
  assert.equal(FAST_SECTORS, 0x18000, "region-relative");
  assert.equal(absolute(FAST_SECTORS), FAST_END);
});

test("an extent's span is rounded up to the alignment, not to the sector", () => {
  // 16,384 bytes is 32 sectors exactly and already aligned.
  assert.equal(sectorsFor(16_384), 32);
  // One byte more takes a whole extent more, not one sector more — which is what keeps every
  // start on the boundary without the allocator having to think about it.
  assert.equal(sectorsFor(16_385), 40);
  assert.equal(sectorsFor(1), EXTENT_ALIGN);
  for (const bytes of [1, 512, 513, 4_096, 16_384, 16_385]) {
    assert.equal(sectorsFor(bytes) % EXTENT_ALIGN, 0, `${bytes} bytes must span whole extents`);
  }
});

// --- the superblock -----------------------------------------------------------------------------

function entryAt(slot: number, startSector: number, payload: Uint8Array): TableEntry {
  return {
    slot,
    name: `TABLE ${slot}`,
    waves: 16,
    points: 512,
    sampleFormat: FORMAT_INT16_BE,
    interpolate: true,
    startSector,
    byteLength: payload.length,
    tableHash: xxHash32(payload),
    sourceHash: 0x1234_5678,
    sourceSize: 65_536,
    gain: 1.5,
  };
}

const table16k = (fill: number): Uint8Array => new Uint8Array(16 * 512 * 2).fill(fill);

test("a superblock round-trips, and is only valid against its own index", () => {
  const index = writeIndex([entryAt(0, DATA_START, table16k(1))]);
  const sector = writeSuperblock(
    { generation: 7, entryCount: 1, dataStart: DATA_START, dataEnd: DATA_END },
    index,
  );

  assert.equal(sector.length, SECTOR, "a superblock occupies its whole sector");
  assert.deepEqual([...sector.subarray(0, 4)], [0x57, 0x52, 0x54, 0x42], '"WRTB"');
  assert.ok(sector.subarray(SUPERBLOCK_BYTES).every((b) => b === 0), "zero past the header");

  const read = readSuperblock(sector, index);
  assert.ok(read);
  assert.equal(read.generation, 7);
  assert.equal(read.entryCount, 1);
  assert.equal(read.dataStart, DATA_START);
  assert.equal(read.dataEnd, DATA_END);

  // **The pairing is the safety property.** A superblock that validated against any index would
  // let a half-finished write be mistaken for a finished one, which is the exact failure the two
  // groups exist to prevent.
  const other = writeIndex([entryAt(0, DATA_START, table16k(2))]);
  assert.equal(readSuperblock(sector, other), undefined, "a stale index must invalidate it");
});

test("every way a superblock can be invalid reads as invalid, not as something", () => {
  const index = writeIndex([entryAt(3, DATA_START, table16k(1))]);
  const good = writeSuperblock(
    { generation: 1, entryCount: 1, dataStart: DATA_START, dataEnd: DATA_END },
    index,
  );
  assert.ok(readSuperblock(good, index), "the control");

  const broken = (mutate: (s: Uint8Array) => void): Uint8Array => {
    const copy = Uint8Array.from(good);
    mutate(copy);
    return copy;
  };

  // A virgin region: all zeros. This is the common case, not an error case — half the groups in a
  // healthy store are invalid at any moment, and the one being written to is one of them.
  assert.equal(readSuperblock(new Uint8Array(SECTOR), index), undefined, "erased");
  assert.equal(readSuperblock(new Uint8Array(8), index), undefined, "truncated");

  assert.equal(readSuperblock(broken((s) => { s[0] = 0x58; }), index), undefined, "magic");
  assert.equal(readSuperblock(broken((s) => { s[5] = 9; }), index), undefined, "version");
  assert.equal(readSuperblock(broken((s) => { s[7] = 48; }), index), undefined, "header size");
  assert.equal(readSuperblock(broken((s) => { s[63] = s[63]! ^ 1; }), index), undefined, "its own hash");
  assert.equal(readSuperblock(broken((s) => { s[11] = s[11]! ^ 1; }), index), undefined, "a field under the hash");

  // A short index is refused rather than hashed as far as it goes, which would make a truncated
  // read of the index look like a valid store with fewer tables.
  assert.equal(readSuperblock(good, index.subarray(0, INDEX_BYTES - 1)), undefined, "short index");
});

test("the current group is the valid one with the higher generation, and A wins a tie", () => {
  const index = writeIndex([]);
  const sb = (generation: number) =>
    readSuperblock(
      writeSuperblock({ generation, entryCount: 0, dataStart: DATA_START, dataEnd: DATA_END }, index),
      index,
    );

  assert.equal(currentGroup({ superblock: undefined, value: "a" }, { superblock: undefined, value: "b" }), undefined,
    "neither valid means the store is empty, which is also a virgin region");

  assert.equal(currentGroup({ superblock: sb(1), value: "a" }, { superblock: undefined, value: "b" })?.value, "a");
  assert.equal(currentGroup({ superblock: undefined, value: "a" }, { superblock: sb(1), value: "b" })?.value, "b");
  assert.equal(currentGroup({ superblock: sb(4), value: "a" }, { superblock: sb(5), value: "b" })?.value, "b");
  assert.equal(currentGroup({ superblock: sb(6), value: "a" }, { superblock: sb(5), value: "b" })?.value, "a");

  // Cannot happen, pinned anyway: "cannot happen" is where non-determinism lives, and both
  // implementations have to agree on the same answer.
  assert.equal(currentGroup({ superblock: sb(3), value: "a" }, { superblock: sb(3), value: "b" })?.value, "a");
});

// --- the index ------------------------------------------------------------------------------------

test("an index round-trips, and a free slot is genuinely absent", () => {
  const entries = [entryAt(0, DATA_START, table16k(1)), entryAt(5, DATA_START + 32, table16k(2))];
  const index = writeIndex(entries);
  assert.equal(index.length, INDEX_BYTES);

  const read = readIndex(index);
  assert.equal(read.length, 2, "only the two in use");
  assert.deepEqual(read.map((e) => e.slot), [0, 5]);
  assert.deepEqual(read[0], entries[0]);
  assert.deepEqual(read[1], entries[1]);

  // A free entry is all zeros, which is also what an erased index is. The two must not be
  // distinguishable, because a store with no tables is exactly a store that was never written.
  const free = index.subarray(1 * ENTRY_BYTES, 2 * ENTRY_BYTES);
  assert.ok(free.every((b) => b === 0), "slot 1 is untouched");
});

test("the no-interpolation flag survives being stored as its own negative", () => {
  // The field on disk is "no interpolation"; the field in the type is "interpolate". A double
  // negative read the wrong way round plays every table with the wrong setting and nothing fails.
  for (const interpolate of [true, false]) {
    const entry = { ...entryAt(0, DATA_START, table16k(1)), interpolate };
    assert.equal(readIndex(writeIndex([entry]))[0]!.interpolate, interpolate);
  }

  const off = writeIndex([{ ...entryAt(0, DATA_START, table16k(1)), interpolate: false }]);
  assert.equal(off[1]! & 0b10, 0b10, "bit 1 set means no interpolation");
  const on = writeIndex([{ ...entryAt(0, DATA_START, table16k(1)), interpolate: true }]);
  assert.equal(on[1]! & 0b10, 0, "and clear means interpolate");
});

test("the gain survives 16.16, and the name is truncated rather than overflowing", () => {
  const entry = { ...entryAt(0, DATA_START, table16k(1)), gain: 2.5 };
  assert.equal(readIndex(writeIndex([entry]))[0]!.gain, 2.5);

  // A 64-byte field and a longer name: the entry after it must be untouched, which a naive
  // `set` of the whole string would not guarantee.
  const long = { ...entryAt(0, DATA_START, table16k(1)), name: "x".repeat(200) };
  const index = writeIndex([long]);
  assert.equal(readIndex(index)[0]!.name.length, 64);
  assert.ok(index.subarray(ENTRY_BYTES, 2 * ENTRY_BYTES).every((b) => b === 0), "slot 1 untouched");
});

test("an index that would describe an unreadable store is refused, naming the entry", () => {
  const payload = table16k(1);
  const ok = entryAt(0, DATA_START, payload);
  assert.doesNotThrow(() => validateIndex([ok]));

  // Overlap, which is the rule that is about a pair rather than an entry.
  assert.throws(
    () => validateIndex([entryAt(0, DATA_START, payload), entryAt(1, DATA_START + 8, payload)]),
    /overlap/,
  );

  // Alignment, bounds at both ends, and a slot claimed twice.
  assert.throws(() => validateIndex([entryAt(0, DATA_START + 1, payload)]), /boundary/);
  assert.throws(() => validateIndex([entryAt(0, DATA_START - EXTENT_ALIGN, payload)]), /inside the superblocks/);
  assert.throws(() => validateIndex([entryAt(0, DATA_END - 8, payload)]), /past the region/);
  assert.throws(() => validateIndex([ok, { ...ok, startSector: DATA_START + 32 }]), /two entries claim/);

  // **Geometry against length.** The geometry is what cuts the payload into waves, so a mismatch
  // is a table that will be read as something else entirely rather than one that fails to load.
  assert.throws(
    () => validateIndex([{ ...ok, points: 256 }]),
    /16 waves x 256 points of int16 is 8192 bytes/,
  );
});

// --- the plan -------------------------------------------------------------------------------------

function pending(slot: number, fill: number): PendingTable {
  return {
    slot,
    name: `T${slot}`,
    waves: 16,
    points: 512,
    interpolate: true,
    payload: table16k(fill),
    sourceHash: 0xabcd_1234,
    sourceSize: 1_000,
    gain: 1,
  };
}

test("a plan writes data, then the index, then the superblock — in that order", () => {
  const plan = planWrite({ tables: [pending(0, 1), pending(1, 2)] });

  assert.deepEqual(plan.writes.map((w) => w.what), ["data", "data", "index", "superblock"]);

  // Not just the order of the kinds: the superblock must be last, full stop. It is the byte that
  // makes everything before it current, and anything after it would be unprotected.
  assert.equal(plan.writes.at(-1)!.what, "superblock");
  assert.equal(plan.writes.filter((w) => w.what === "superblock").length, 1);
});

test("a first write goes to group A at generation 1, and the next goes to B", () => {
  const first = planWrite({ tables: [pending(0, 1)] });
  assert.equal(first.group.name, "A", "a virgin region starts at A");
  assert.equal(first.generation, 1);

  const index = writeIndex(first.entries);
  const superblock = readSuperblock(
    writeSuperblock(
      { generation: first.generation, entryCount: first.entries.length, dataStart: DATA_START, dataEnd: DATA_END },
      index,
    ),
    index,
  )!;

  // **Never the current group.** The whole scheme is that a failed write leaves the other one
  // intact, which it cannot do if the write lands on it.
  const second = planWrite({
    current: { group: first.group, superblock, entries: first.entries },
    tables: [pending(0, 1), pending(1, 2)],
  });
  assert.equal(second.group.name, "B");
  assert.equal(second.generation, 2);
  assert.notEqual(second.writes.at(-1)!.sector, first.writes.at(-1)!.sector);
});

test("a table that has not moved or changed is not rewritten", () => {
  const first = planWrite({ tables: [pending(0, 1), pending(1, 2)] });
  const index = writeIndex(first.entries);
  const superblock = readSuperblock(
    writeSuperblock(
      { generation: 1, entryCount: 2, dataStart: DATA_START, dataEnd: DATA_END },
      index,
    ),
    index,
  )!;
  const current = { group: first.group, superblock, entries: first.entries };

  // Same two tables again: nothing to write but the metadata.
  const same = planWrite({ current, tables: [pending(0, 1), pending(1, 2)] });
  assert.deepEqual(same.reused, [0, 1]);
  assert.deepEqual(same.writes.map((w) => w.what), ["index", "superblock"]);
  assert.equal(same.dataSectorsWritten, 0);

  // Change one: only that one is rewritten, because the layout did not move.
  const changed = planWrite({ current, tables: [pending(0, 1), pending(1, 9)] });
  assert.deepEqual(changed.reused, [0]);
  assert.deepEqual(changed.writes.map((w) => w.what), ["data", "index", "superblock"]);
  assert.equal(changed.writes[0]!.slot, 1);

  // Insert before them and everything after moves, so everything after is rewritten. That is the
  // honest cost of a compacting layout, and the plan reports it rather than hiding it.
  const inserted = planWrite({
    current,
    tables: [pending(0, 1), pending(1, 2), { ...pending(2, 3), slot: 2 }],
  });
  assert.deepEqual(inserted.reused, [0, 1], "slots 0 and 1 still land where they were");
  assert.equal(inserted.writes.filter((w) => w.what === "data").length, 1);
});

test("a plan's writes are whole sectors, correctly addressed, and hash their own bytes", () => {
  const plan = planWrite({ tables: [pending(0, 1)] });
  for (const w of plan.writes) {
    assert.equal(w.length % SECTOR, 0, `${w.what} must be whole sectors`);
    assert.equal(w.bytes.length, w.length);
    assert.equal(w.absoluteSector, REGION_START + w.sector, "absolute is region plus relative");
    assert.equal(w.hash, xxHash32(w.bytes), "the hash is of exactly these bytes");
  }

  const data = plan.writes.find((w) => w.what === "data")!;
  assert.equal(data.sector, DATA_START);
  assert.equal(data.absoluteSector, 0x601000);
  assert.equal(data.length, 16_384, "a v1 table is 32 sectors");

  const index = plan.writes.find((w) => w.what === "index")!;
  assert.equal(index.sector, GROUP_A.index);
  assert.equal(index.length, INDEX_BYTES);
});

test("a plan refuses what it cannot lay out, before building anything", () => {
  assert.throws(() => planWrite({ tables: [pending(0, 1), { ...pending(0, 2) }] }), /two tables claim slot 0/);
  assert.throws(() => planWrite({ tables: [{ ...pending(INDEX_ENTRIES, 1) }] }), /outside 0\.\.255/);
  assert.throws(
    () => planWrite({ tables: [{ ...pending(0, 1), payload: new Uint8Array(0) }] }),
    /empty payload/,
  );
  // The geometry has to agree with the payload, which `writeIndex` enforces for the plan too.
  assert.throws(() => planWrite({ tables: [{ ...pending(0, 1), points: 256 }] }), /of int16 is/);
});

test("the description carries everything needed to replay a plan, and none of the bytes", () => {
  // This is the form the firmware session checks against their own reader, so what matters is
  // that it is complete without the payloads: sector, length and hash per write.
  const plan = planWrite({ tables: [pending(0, 1), pending(4, 2)] });
  const described = describePlan(plan);

  assert.equal(described.group, "A");
  assert.equal(described.generation, 1);
  assert.equal(described.writes.length, plan.writes.length);
  for (const [i, w] of described.writes.entries()) {
    assert.equal(w.sector, plan.writes[i]!.sector);
    assert.equal(w.absoluteSector, plan.writes[i]!.absoluteSector);
    assert.equal(w.length, plan.writes[i]!.length);
    assert.match(w.hash, /^0x[0-9a-f]{8}$/);
  }
  assert.equal(JSON.stringify(described).includes("bytes"), false, "no payloads in the description");
});

// --- the conversion ---------------------------------------------------------------------------------

test("a full-scale sine converts to full scale, with a gain of 1", () => {
  const samples = new Float32Array(16 * 512);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((i / 512) * 2 * Math.PI);

  const table = convertTable(samples, 16, 512);
  assert.equal(table.payload.length, 16 * 512 * 2);
  assert.ok(Math.abs(table.peak - 1) < 1e-6);
  assert.ok(Math.abs(table.gain - 1) < 1e-3, "already at full scale");

  const back = readTableSamples(table.payload);
  let peak = 0;
  for (const v of back) peak = Math.max(peak, Math.abs(v));
  assert.equal(peak, FULL_SCALE, "the loudest sample is exactly full scale");
  for (const v of back) assert.ok(v >= -FULL_SCALE, "and nothing reaches -32768");
});

test("a quiet source is normalised, and the gain says by how much", () => {
  const samples = new Float32Array(16 * 512);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.25 * Math.sin((i / 512) * 2 * Math.PI);

  const table = convertTable(samples, 16, 512);
  assert.ok(Math.abs(table.peak - 0.25) < 1e-6);
  assert.ok(Math.abs(table.gain - 4) < 1e-2, "0.25 to full scale is x4");

  // And the gain is what reverses it, which is the whole reason it is stored.
  const back = readTableSamples(table.payload);
  let peak = 0;
  for (const v of back) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak / table.gain / FULL_SCALE - 0.25) < 1e-3);
});

test("silence converts to silence rather than to a division by zero", () => {
  const table = convertTable(new Float32Array(16 * 512), 16, 512);
  assert.equal(table.peak, 0);
  assert.equal(table.gain, 1, "nothing was scaled, and that is the honest record");
  assert.ok(table.payload.every((b) => b === 0), "a NaN here would be a loud noise, not silence");
});

test("rounding is away from zero, so the negative half is not biased", () => {
  // Math.round(-0.5) is -0, rounding half toward positive infinity. On a signed waveform that
  // pulls every negative half-step one code toward zero, which reads as a small DC offset rather
  // than as an error.
  // Peak 2 makes the gain exactly 0.5, so a sample of 1 scales to 16383.5 — an exact half, and
  // exactly representable in binary. Reaching for 0.5/32767 instead gives 0.49999999999999994 and
  // tests the float library rather than the rounding.
  const samples = Float32Array.from([2, -2, 1, -1, 0, 0, 0, 0]);
  const table = convertTable(samples, 1, 8);
  assert.equal(table.gain, 0.5);

  const back = readTableSamples(table.payload);
  assert.equal(back[0], FULL_SCALE);
  assert.equal(back[1], -FULL_SCALE);
  assert.equal(back[2], 16_384, "+16383.5 rounds away from zero");
  assert.equal(back[3], -16_384, "and -16383.5 rounds away too, not toward it");

  // The property underneath, which is what a listener would notice: a symmetric input gives a
  // symmetric output, so no amount of rounding introduces a DC offset.
  const pairs = new Float32Array(512);
  for (let i = 0; i < 256; i++) {
    pairs[i * 2] = (i + 1) / 256;
    pairs[i * 2 + 1] = -(i + 1) / 256;
  }
  const symmetric = readTableSamples(convertTable(pairs, 1, 512).payload);
  for (let i = 0; i < 256; i++) {
    assert.equal(symmetric[i * 2], -symmetric[i * 2 + 1]!, `pair ${i} is not symmetric`);
  }
});

test("big-endian, which is the byte order the DSP chain needs", () => {
  // One sample of +1 at full scale: 0x7fff. High byte first.
  const payload = convertTable(Float32Array.from([1, 0]), 1, 2).payload;
  assert.deepEqual([...payload.subarray(0, 2)], [0x7f, 0xff]);

  // And a negative one, where a sign error would be loudest: -32767 is 0x8001 two's complement.
  const negative = convertTable(Float32Array.from([-1, 0]), 1, 2).payload;
  assert.deepEqual([...negative.subarray(0, 2)], [0x80, 0x01]);
  assert.equal(readTableSamples(negative)[0], -FULL_SCALE);
});

test("a source that does not divide into equal waves is refused, not padded", () => {
  assert.throws(() => convertTable(new Float32Array(1_000), 16, 512), /needs 8192 samples/);
  assert.throws(() => convertTable(new Float32Array(16), 0, 512), /positive integer/);
  assert.throws(() => convertTable(Float32Array.from([NaN, 0]), 1, 2), /cannot be converted/);
});

test("the display name carries Tonverk's convention and always fits the field", () => {
  assert.equal(tableName("SWEEP", 512, true), "SWEEP_wt512");
  assert.equal(tableName("SWEEP", 512, false), "SWEEP_wt512r", "r means no interpolation");

  // The suffix is the part that carries information, so it survives and the stem is trimmed.
  const long = tableName("x".repeat(200), 2048, false);
  assert.equal(long.length, 64);
  assert.ok(long.endsWith("_wt2048r"));
});

test("the name is a label and the geometry is not read back from it", () => {
  // The whole point of the convention being display-only. A name that disagrees with the index
  // must change nothing about how the table is read.
  const payload = table16k(1);
  const lying = {
    ...entryAt(0, DATA_START, payload),
    name: tableName("LIAR", 2048, false),
    points: 512,
    interpolate: true,
  };
  const read = readIndex(writeIndex([lying]))[0]!;
  assert.equal(read.points, 512, "the index wins");
  assert.equal(read.interpolate, true);
  assert.ok(read.name.includes("_wt2048r"), "and the name is carried verbatim regardless");
});
