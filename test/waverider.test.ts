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
  FAST_SLOTS,
  ENTRY_BYTES,
  SLOT_BYTES,
  SLOT_SECTORS,
  slotSector,
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
import { type TableEntry, FORMAT_INT16_BE, readIndex, writeIndex } from "@noiseandmatter/dnx-core/waverider/entries.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import {
  SUPERBLOCK_BYTES,
  currentGroup,
  readSuperblock,
  writeSuperblock,
} from "@noiseandmatter/dnx-core/waverider/superblock.js";
import { validateIndex } from "@noiseandmatter/dnx-core/waverider/validate.js";
import { tableName } from "@noiseandmatter/dnx-core/waverider/naming.js";
import {
  type PendingTable,
  describePlan,
  planWrite,
} from "@noiseandmatter/dnx-core/waverider/plan.js";
import {
  FULL_SCALE,
  convertTable,
  readTableSamples,
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

test("every slot has its own fixed extent, sized for the largest table anyone can import", () => {
  // **The property the whole design rests on.** Slot n's sectors are arithmetic, so no two slots
  // can overlap and there is nothing to allocate or compact.
  assert.equal(SLOT_SECTORS, 0x400, "512 KiB");
  assert.equal(SLOT_BYTES, 524_288);
  assert.equal(slotSector(0), DATA_START);
  assert.equal(slotSector(INDEX_ENTRIES - 1), 0x40c00, "the document's slot 255");
  assert.equal(slotSector(INDEX_ENTRIES - 1) + SLOT_SECTORS, DATA_END, "the last slot ends the region");
  assert.equal(DATA_END, 0x41000);
  for (let n = 1; n < INDEX_ENTRIES; n++) {
    assert.equal(slotSector(n), slotSector(n - 1) + SLOT_SECTORS);
  }

  /*
   * **The reason for the size, as arithmetic.** A slot holds one table at Tonverk's largest native
   * geometry and not a byte more: 64 waves of 4,096 points of int16. That exactness is why 512 KiB
   * rather than a round number near it, so it is worth an assertion. If `SLOT_BYTES` is ever
   * raised, this line says what it was the size of.
   */
  assert.equal(64 * 4_096 * 2, SLOT_BYTES, "a maximal Tonverk table is a slot");
  assert.equal(64 * 2_048 * 2, SLOT_BYTES / 2, "its default geometry is half a slot");
  assert.equal(16 * 512 * 2, SLOT_BYTES / 32, "today's DSP geometry is a thirty-second of one");

  /*
   * **And the cost, which is that most of the store is not in the pSLC.** 130 MiB of slots against
   * a 48 MiB fast region, so slots 0..91 are fast and the other 164 are on TLC. The earlier
   * 128 KiB stride fitted entirely inside the pSLC, and that was the thing given up for a stride
   * that holds a full-resolution import. Only load speed differs.
   */
  assert.equal(DATA_END * SECTOR, 136_314_880, "130 MiB");
  assert.equal(FAST_SLOTS, 92, "the shared document's count");
  assert.equal(slotSector(FAST_SLOTS), FAST_SECTORS, "slot 92 starts exactly on the boundary");
  assert.ok(slotSector(FAST_SLOTS - 1) + SLOT_SECTORS <= FAST_SECTORS, "slot 91 is wholly inside");

  // A payload's span is just sectors; there is no alignment to round to.
  assert.equal(sectorsFor(16_384), 32);
  assert.equal(sectorsFor(16_385), 33);
  assert.equal(sectorsFor(1), 1);
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
  const index = writeIndex([entryAt(0, slotSector(0), table16k(1))]);
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
  const other = writeIndex([entryAt(0, slotSector(0), table16k(2))]);
  assert.equal(readSuperblock(sector, other), undefined, "a stale index must invalidate it");
});

test("every way a superblock can be invalid reads as invalid, not as something", () => {
  const index = writeIndex([entryAt(3, slotSector(3), table16k(1))]);
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
  const entries = [entryAt(0, slotSector(0), table16k(1)), entryAt(5, slotSector(5), table16k(2))];
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
    const entry = { ...entryAt(0, slotSector(0), table16k(1)), interpolate };
    assert.equal(readIndex(writeIndex([entry]))[0]!.interpolate, interpolate);
  }

  const off = writeIndex([{ ...entryAt(0, slotSector(0), table16k(1)), interpolate: false }]);
  assert.equal(off[1]! & 0b10, 0b10, "bit 1 set means no interpolation");
  const on = writeIndex([{ ...entryAt(0, slotSector(0), table16k(1)), interpolate: true }]);
  assert.equal(on[1]! & 0b10, 0, "and clear means interpolate");
});

test("the gain survives 16.16, and the name is truncated rather than overflowing", () => {
  const entry = { ...entryAt(0, slotSector(0), table16k(1)), gain: 2.5 };
  assert.equal(readIndex(writeIndex([entry]))[0]!.gain, 2.5);

  // A 64-byte field and a longer name: the entry after it must be untouched, which a naive
  // `set` of the whole string would not guarantee.
  const long = { ...entryAt(0, slotSector(0), table16k(1)), name: "x".repeat(200) };
  const index = writeIndex([long]);
  assert.equal(readIndex(index)[0]!.name.length, 64);
  assert.ok(index.subarray(ENTRY_BYTES, 2 * ENTRY_BYTES).every((b) => b === 0), "slot 1 untouched");
});

test("an index that would describe an unreadable store is refused, naming the entry", () => {
  const payload = table16k(1);
  const ok = entryAt(0, slotSector(0), payload);
  assert.doesNotThrow(() => validateIndex([ok]));

  // Two slots at their own extents is now the *valid* case: they cannot overlap.
  assert.doesNotThrow(() => validateIndex([ok, entryAt(1, slotSector(1), payload)]));

  /*
   * **The one placement rule left.** Alignment, region bounds and overlap between entries were
   * three separate rules while extents were allocated, and a fixed stride made all three
   * impossible. A rule you can delete by changing the design beats a rule you enforce well.
   *
   * The message is phrased the way the device phrases it, so somebody who hits it from either
   * side meets one vocabulary rather than two.
   */
  assert.throws(
    () => validateIndex([entryAt(3, slotSector(2), payload)]),
    new RegExp(
      `slot 3 \\(TABLE 3\\): starts at 0x${slotSector(2).toString(16)}, ` +
        `not its own 0x${slotSector(3).toString(16)}`,
    ),
  );
  assert.throws(() => validateIndex([entryAt(0, slotSector(0) + 1, payload)]), /not its own/);

  // Too big for its slot, and a slot claimed twice.
  assert.throws(
    () => validateIndex([{ ...ok, byteLength: SLOT_BYTES + 2, points: (SLOT_BYTES + 2) / 32 }]),
    /does not fit a slot/,
  );
  assert.throws(() => validateIndex([ok, { ...ok }]), /two entries claim/);

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

  /*
   * **And adding one before the others costs one write.** Under the allocator this was the
   * expensive case: inserting at a lower slot shifted every extent after it, so everything was
   * rewritten. With a fixed stride nothing moves, which is most of why the stride is worth its
   * space.
   */
  const inserted = planWrite({ current, tables: [pending(0, 1), pending(1, 2), pending(2, 3)] });
  assert.deepEqual(inserted.reused, [0, 1], "the two that were already there");
  assert.equal(inserted.writes.filter((w) => w.what === "data").length, 1);
  assert.equal(inserted.writes.find((w) => w.what === "data")!.sector, slotSector(2));
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
  assert.equal(data.sector, slotSector(0));
  assert.equal(data.absoluteSector, 0x601000);
  assert.equal(data.length, 16_384, "a v1 table fills 32 of a slot's 256 sectors");

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
  // The geometry has to agree with the payload, which the plan validates before encoding.
  assert.throws(() => planWrite({ tables: [{ ...pending(0, 1), points: 256 }] }), /of int16 is/);

  // Too big for a slot — the only size rule a fixed stride leaves.
  assert.throws(
    () => planWrite({
      tables: [{ ...pending(0, 1), waves: 1, points: SLOT_BYTES, payload: new Uint8Array(SLOT_BYTES + 2) }],
    }),
    /a slot holds/,
  );

  // And the table the size was chosen for goes through, which is the other half of that rule. A
  // bound is only right if it admits the case it was measured from.
  assert.doesNotThrow(() =>
    planWrite({
      tables: [{
        ...pending(0, 1), waves: 64, points: 4_096, payload: new Uint8Array(SLOT_BYTES),
      }],
    }),
  );
});

test("changing the slot stride is a full rewrite, and needs no migration code", () => {
  /*
   * **The stride already changed once**, from 128 KiB to 512 KiB on the day it was agreed, so this
   * is a property that was exercised rather than imagined. It costs one constant because the index
   * a plan writes is built from `tables` alone: it describes exactly the tables given, at exactly
   * this build's geometry, and never amends the one on the card.
   *
   * Here the current store is at the old stride. Every reuse check fails, every table is written at
   * its new place, and the resulting index is wholly at the new geometry, with no code that knows
   * anything about the old one. The old data sectors are left unreferenced, which they are the
   * moment the new superblock lands.
   */
  const OLD_SLOT_SECTORS = 0x100;
  const atOldStride = [0, 1, 5].map((slot) =>
    entryAt(slot, DATA_START + slot * OLD_SLOT_SECTORS, table16k(slot + 1)),
  );
  const index = writeIndex(atOldStride);
  const superblock = readSuperblock(
    // The old store's own `dataEnd`, which is where a reader could have derived its stride from.
    writeSuperblock(
      { generation: 4, entryCount: 3, dataStart: DATA_START, dataEnd: DATA_START + INDEX_ENTRIES * OLD_SLOT_SECTORS },
      index,
    ),
    index,
  )!;
  assert.equal(superblock.dataEnd, 0x11000, "the store this build would have written yesterday");

  const plan = planWrite({
    current: { group: GROUP_A, superblock, entries: atOldStride },
    // The same payloads, so only the geometry differs. `pending` fills a table with its slot + 1,
    // matching `atOldStride` above, so a reuse is detected wherever the places still agree.
    tables: [pending(0, 1), pending(1, 2), pending(5, 6)],
  });

  // The new index is wholly at the new geometry, with nothing carried over from the old one.
  assert.deepEqual(
    plan.entries.map((e) => e.startSector),
    [slotSector(0), slotSector(1), slotSector(5)],
  );

  /*
   * **And slot 0 is not rewritten**, which is the part worth pinning. Slot 0 starts at `DATA_START`
   * under any stride, so its bytes are already in the right place and the reuse check says so.
   *
   * This assertion was `[]` when the test was written, on the reasoning that a stride change
   * invalidates everything. It does not: the check compares a table's own extent and hash, so what
   * gets rewritten is exactly what moved or changed, and a slot the two strides agree on is left
   * alone. The cheaper plan is the correct one here, and it falls out of asking per entry rather
   * than per store.
   */
  assert.equal(slotSector(0), DATA_START + 0 * OLD_SLOT_SECTORS, "the one place the strides agree");
  assert.deepEqual(plan.reused, [0]);
  assert.deepEqual(
    plan.writes.filter((w) => w.what === "data").map((w) => [w.slot, w.sector]),
    [[1, slotSector(1)], [5, slotSector(5)]],
  );
  assert.equal(plan.generation, 5, "a stride change is an ordinary generation, not a special one");
  assert.equal(plan.group.name, "B", "and an ordinary swap to the other group");
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

test("the guard moved from the encoder to the planner, and did not get lost", () => {
  // `writeIndex` used to validate. Splitting the codec from the policy put the import the other
  // way round, and **a guard moving from a callee to a caller is exactly the kind of change that
  // quietly loses one** — so both halves are pinned.
  // An entry whose extent is not its own slot's — the one placement rule left now that a fixed
  // stride has made alignment, region bounds and overlap impossible.
  const bad: TableEntry[] = [
    entryAt(0, slotSector(0), table16k(1)),
    entryAt(1, slotSector(4), table16k(2)),
  ];

  // The judge still refuses it.
  assert.throws(() => validateIndex(bad), /not its own/);

  // The encoder does not, and that is now deliberate rather than an oversight.
  assert.doesNotThrow(() => writeIndex(bad), "the codec encodes what it is given");

  // And the only route to a write asks the judge first.
  assert.throws(
    () => planWrite({ tables: [pending(0, 1), { ...pending(1, 2), points: 256 }] }),
    /of int16 is/,
  );
});

test("the plan's bytes are what a second implementation produced from the document alone", () => {
  /*
   * **These literals are not ours.** The firmware session implemented the store in Python from
   * `waverider-store.md`, without reading this code, and replayed the plan below: the three write
   * hashes, the superblock's 64 bytes and index entry 0's 128 bytes came out identical.
   *
   * So this is a cross-implementation vector rather than a round trip, which is the same upgrade
   * the firmware's own xxHash32 values gave `xxhash32.test.ts`. If a field order or a padding rule
   * moves on either side, one of the two builds breaks.
   *
   * **Two fields have now moved twice**, both times `dataEnd` and the superblock's own hash, and
   * both times for a change to the slot stride: 0x21000 under the allocator, 0x11000 at 128 KiB
   * fixed slots, 0x41000 at 512 KiB. The three self-hashes are `0xa636f27e`, `0x22136de2` and the
   * `0x80c77e1c` below. **The index is byte-identical through all of it**, because slot 0 starts at
   * `DATA_START` whatever the stride is. So `0x8e82b3df` and entry 0's 128 bytes have never been
   * in question, and the firmware session re-pins exactly two fields each time.
   *
   * Their encoder reproduced the 128 KiB superblock and keeps it as a vector at that `dataEnd`.
   * **The 512 KiB one below is ours alone until they pin it**, which is a fact about today and not
   * a doubt about the format: the two altered fields are a u32 from the document and a hash over
   * the record, and a third reading would have to disagree with the first two to break it.
   *
   * The payload is chosen so one hash was already independently known: 16,384 bytes of
   * `(i * 7) & 0xff` hashes to 0x831953bc, which the firmware's routine at 0x4014be0e produced
   * under Unicorn. A disagreement there would mean the payload; one on the other two would mean
   * the layout.
   *
   * **It still proves only that two readings of the document agree** — not that the document is
   * right about the device. That waits for a table that sounds right.
   */
  const payload = new Uint8Array(16 * 512 * 2);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
  assert.equal(xxHash32(payload), 0x831953bc, "the hash both sides already knew");

  const plan = planWrite({
    tables: [{
      slot: 0, name: "RAMP7_wt512", waves: 16, points: 512, interpolate: true,
      payload, sourceHash: 0x831953bc, sourceSize: 16_384, gain: 1,
    }],
  });

  assert.deepEqual(
    plan.writes.map((w) => [w.what, w.sector, w.length, w.hash]),
    [
      ["data", 4096, 16_384, 0x831953bc],
      ["index", 1, 32_768, 0x8e82b3df],
      ["superblock", 0, 512, 0x80c77e1c],
    ],
  );

  // The two records, as the rows in the message that was replayed — sixteen bytes a line, so a
  // transcription slip shows up as a short line rather than hiding in a 256-character string.
  const rows = (bytes: Uint8Array, length: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < length; i += 16) {
      out.push([...bytes.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "));
    }
    return out;
  };

  const superblock = plan.writes.find((w) => w.what === "superblock")!.bytes;
  assert.deepEqual(rows(superblock, SUPERBLOCK_BYTES), [
    "57 52 54 42 00 01 00 40 00 00 00 01 00 00 00 01",
    "00 00 01 00 00 00 00 80 8E 82 B3 DF 00 00 10 00",
    "00 04 10 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 A3 07 CB C7",
  ]);
  assert.ok(superblock.subarray(SUPERBLOCK_BYTES).every((b) => b === 0), "zero to the sector");

  const index = plan.writes.find((w) => w.what === "index")!.bytes;
  assert.deepEqual(rows(index, 128), [
    "00 01 00 01 00 10 02 00 00 01 00 00 00 00 10 00",
    "00 00 40 00 83 19 53 BC 83 19 53 BC 00 00 40 00",
    "52 41 4D 50 37 5F 77 74 35 31 32 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
  ]);
  assert.ok(index.subarray(128, 256).every((b) => b === 0), "entry 1 is free");
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
