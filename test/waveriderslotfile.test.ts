/**
 * `/waverider/<n>` as a file, against bytes a second implementation produced.
 *
 * **The vectors here are not ours.** The firmware session's `waverider_container.py` built the
 * reference from `waverider-store.md`, and their emulator traced the firmware accepting it: open,
 * eight chunks, commit, then a listing showing the slot and a read returning the same bytes. So
 * these literals are a file the device has actually taken, not a second reading of a document.
 *
 * DNX's `buildSlotFile` reproduces all 16,555 bytes of it exactly. That is checked two ways: the
 * header, the entry and the trailer are pinned row by row, and the whole file is pinned by hash, so
 * a difference anywhere in the table shows up even though the table is not written out here.
 *
 * ## What it does not prove
 *
 * That the device plays it. Sample format 1's byte order is still a hypothesis until a loaded table
 * sounds right, and nothing here has been near an instrument.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTENT_KIND_WAVETABLE,
  FORMAT_VERSION,
  STORE_FORMAT_VERSION,
  buildSlotFile,
  readSlotFile,
} from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { ENTRY_BYTES, SLOT_BYTES, slotSector } from "@noiseandmatter/dnx-core/waverider/layout.js";
import { FORMAT_INT16_BE } from "@noiseandmatter/dnx-core/waverider/entries.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { HEAD, HEADER_BYTES, TRAILER_BYTES } from "@noiseandmatter/dnx-core/project/container.js";

/** Their generator's table for slot 7, seed 7: `(i * seed + slot) & 0xff`. */
function referenceTable(): Uint8Array {
  const table = new Uint8Array(16 * 512 * 2);
  for (let i = 0; i < table.length; i++) table[i] = (i * 7 + 7) & 0xff;
  return table;
}

function referenceFile(): Uint8Array {
  const table = referenceTable();
  return buildSlotFile({
    slot: 7, name: "TBL7", waves: 16, points: 512, interpolate: true,
    table, sourceHash: xxHash32(table), sourceSize: table.length, gain: 1,
  });
}

const rows = (bytes: Uint8Array, from: number, to: number): string[] => {
  const out: string[] = [];
  for (let i = from; i < to; i += 16) {
    out.push([...bytes.subarray(i, Math.min(i + 16, to))]
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "));
  }
  return out;
};

test("a slot file is the bytes the firmware session's own generator produced", () => {
  const file = referenceFile();

  // 31 + 128 + 16,384 + 12. The length is worth stating because the header's length field is
  // 128 + table rather than the table alone, which is the detail easiest to get wrong.
  assert.equal(file.length, 16_555);
  assert.equal(file.length, HEADER_BYTES + ENTRY_BYTES + 16_384 + TRAILER_BYTES);

  assert.deepEqual(rows(file, 0, HEADER_BYTES), [
    "AC 11 D3 03 02 00 05 00 0F 30 30 35 39 00 00 00",
    "57 00 00 00 01 00 00 00 07 00 00 40 80 00 0C",
  ]);

  // The entry, which is the part a reader of `entries.ts` can check field by field: flags 1,
  // kind 1, 16 waves of 512 points, format 1, slot 7's own 0x2C00, 16,384 bytes, the table hash
  // twice because the source was the table, the name, and a gain of 1.0 as 16.16 at +96.
  assert.deepEqual(rows(file, HEADER_BYTES, HEADER_BYTES + ENTRY_BYTES), [
    "00 01 00 01 00 10 02 00 00 01 00 00 00 00 2C 00",
    "00 00 40 00 FD 7A 1B 10 FD 7A 1B 10 00 00 40 00",
    "54 42 4C 37 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
  ]);

  // CRC-32 seeded zero over the body, the body's length, the footer magic. Not the usual
  // pre-inverted CRC-32: `zlib.crc32` on the same bytes gives 0x5CC313DA.
  assert.deepEqual(rows(file, file.length - TRAILER_BYTES, file.length), [
    "AE CD 92 27 00 00 40 80 AA A1 DA AA",
  ]);

  // And every byte between, which the rows above step over.
  assert.equal(xxHash32(file), 0x24304c60, "the whole 16,555 bytes");

  // The table's own hash was already known independently: it is the one in the entry above.
  assert.equal(xxHash32(referenceTable()), 0xfd7a1b10);
});

test("the header's fields are the ones the firmware checks at the first chunk", () => {
  const file = referenceFile();
  const be32 = (at: number) =>
    ((file[at]! << 24) | (file[at + 1]! << 16) | (file[at + 2]! << 8) | file[at + 3]!) >>> 0;

  assert.equal(be32(HEAD.contentKind), CONTENT_KIND_WAVETABLE, "'W', not a project's 1");
  assert.equal(be32(HEAD.objectVersion), STORE_FORMAT_VERSION, "the store's format, not a project's");
  assert.equal(be32(HEAD.index), 7, "the slot, which the device stamps anyway");
  assert.equal(be32(HEAD.bodyLength), ENTRY_BYTES + 16_384, "**128 + table**, not the table");
  assert.equal(file[HEAD.compressed], 0, "raw: the device refuses an LZ4 body here");
  assert.equal(file[HEAD.trailerLength], TRAILER_BYTES);
  assert.equal(String.fromCharCode(...file.subarray(HEAD.formatVersion, HEAD.formatVersion + 4)), FORMAT_VERSION);

  // `0x57` is clear of Elektron's small odd integers, which is the reason for that value: a fourth
  // Elektron kind would plausibly be 7 or 9.
  assert.equal(CONTENT_KIND_WAVETABLE, 0x57);
  assert.equal(CONTENT_KIND_WAVETABLE % 2, 1, "odd, like theirs, but nowhere near the sequence");
});

test("the table hash is computed from the table, so a stale one cannot be sent", () => {
  /*
   * **The device cannot reject a bad write.** The stock session decides the `0x59` commit reply
   * before it calls the store's commit callback and ignores what the callback returns, so an entry
   * whose hash does not match its table gets `commit ok` and writes nothing. Measured on slot 9:
   * the commit succeeded and the slot never appeared in a listing.
   *
   * So the hash is not an input. `buildSlotFile` takes the table and computes it, which makes the
   * failure unrepresentable rather than merely checked.
   */
  const table = referenceTable();
  const file = referenceFile();
  const entryHash = ((file[HEADER_BYTES + 20]! << 24) | (file[HEADER_BYTES + 21]! << 16) |
    (file[HEADER_BYTES + 22]! << 8) | file[HEADER_BYTES + 23]!) >>> 0;
  assert.equal(entryHash, xxHash32(table));

  // Change one sample and the recorded hash follows, with no caller involved.
  const altered = Uint8Array.from(table);
  altered[99] = altered[99]! ^ 1;
  const second = buildSlotFile({
    slot: 7, name: "TBL7", waves: 16, points: 512, interpolate: true,
    table: altered, sourceHash: 0, sourceSize: altered.length, gain: 1,
  });
  const secondHash = ((second[HEADER_BYTES + 20]! << 24) | (second[HEADER_BYTES + 21]! << 16) |
    (second[HEADER_BYTES + 22]! << 8) | second[HEADER_BYTES + 23]!) >>> 0;
  assert.equal(secondHash, xxHash32(altered));
  assert.notEqual(secondHash, entryHash);
});

test("a file the firmware would refuse is refused here instead", () => {
  const table = referenceTable();
  const ok = {
    slot: 7, name: "TBL7", waves: 16, points: 512, interpolate: true,
    table, sourceHash: 0, sourceSize: table.length, gain: 1,
  };
  assert.doesNotThrow(() => buildSlotFile(ok));

  // Each of these is a refusal the firmware makes at the first chunk or the commit. Making them
  // here costs nothing and spares a full transfer that ends in "Header was not processed".
  assert.throws(() => buildSlotFile({ ...ok, slot: 256 }), /outside 0\.\.255/);
  assert.throws(() => buildSlotFile({ ...ok, slot: -1 }), /outside 0\.\.255/);
  assert.throws(() => buildSlotFile({ ...ok, table: new Uint8Array(0) }), /empty table/);
  assert.throws(
    () => buildSlotFile({ ...ok, waves: 1, points: SLOT_BYTES, table: new Uint8Array(SLOT_BYTES + 2) }),
    /a slot holds/,
  );
  assert.throws(() => buildSlotFile({ ...ok, points: 256 }), /of int16 is/);
  assert.throws(() => buildSlotFile({ ...ok, waves: 0 }), /geometry is/);

  // The table the slot size was chosen for goes through, which is the other half of a bound.
  const biggest = new Uint8Array(SLOT_BYTES);
  assert.doesNotThrow(() => buildSlotFile({
    ...ok, waves: 64, points: 4_096, table: biggest, sourceSize: biggest.length,
  }));
});

test("a slot file reads back as its entry and its table, and checks itself", () => {
  const file = referenceFile();
  const { entry, table } = readSlotFile(file);

  assert.equal(entry.slot, 7, "from the container's stamped index, not from a position");
  assert.equal(entry.name, "TBL7");
  assert.equal(entry.waves, 16);
  assert.equal(entry.points, 512);
  assert.equal(entry.sampleFormat, FORMAT_INT16_BE);
  assert.equal(entry.interpolate, true);
  assert.equal(entry.startSector, slotSector(7));
  assert.equal(entry.byteLength, 16_384);
  assert.equal(entry.gain, 1);
  assert.deepEqual([...table], [...referenceTable()]);

  // **The entry is checked against the table it arrived with.** A read that trusted the entry
  // would agree with a corrupt file about what it contains, which is the one thing a verify must
  // not do.
  const badHash = Uint8Array.from(file);
  badHash[HEADER_BYTES + 20] = badHash[HEADER_BYTES + 20]! ^ 1;
  assert.throws(() => readSlotFile(badHash), /table hash does not match/);

  const shortBody = Uint8Array.from(file);
  shortBody[HEADER_BYTES + 18] = 0x41;
  assert.throws(() => readSlotFile(shortBody), /the file carries/);

  // And the three header fields, each with the firmware's own objection.
  const wrongKind = Uint8Array.from(file);
  wrongKind[HEAD.contentKind + 3] = 1;
  assert.throws(() => readSlotFile(wrongKind), /not a Waverider table's 0x57/);

  const wrongVersion = Uint8Array.from(file);
  wrongVersion[HEAD.objectVersion + 3] = 2;
  assert.throws(() => readSlotFile(wrongVersion), /store format version 2/);

  const lz4 = Uint8Array.from(file);
  lz4[HEAD.compressed] = 1;
  assert.throws(() => readSlotFile(lz4), /must be raw/);

  assert.throws(() => readSlotFile(new Uint8Array(8)), /a slot file is at least/);
  assert.throws(() => readSlotFile(new Uint8Array(200)), /not an Elektron container/);
  assert.ok(new WaveriderError("x") instanceof Error);
});

test("what DNX builds is what DNX reads, for every slot and a ragged size", () => {
  // The round trip across the stride, since the entry's extent is a function of the slot and slot 0
  // is the one place every stride agrees. 255 is the last, where an off-by-one would live.
  for (const slot of [0, 1, 7, 92, 255]) {
    const table = new Uint8Array(16 * 512 * 2);
    for (let i = 0; i < table.length; i++) table[i] = (i * 3 + slot) & 0xff;
    const file = buildSlotFile({
      slot, name: `T${slot}`, waves: 16, points: 512, interpolate: slot % 2 === 0,
      table, sourceHash: 0xabcd_1234, sourceSize: 999, gain: 0.5,
    });
    const back = readSlotFile(file);
    assert.equal(back.entry.slot, slot);
    assert.equal(back.entry.startSector, slotSector(slot));
    assert.equal(back.entry.interpolate, slot % 2 === 0);
    assert.equal(back.entry.gain, 0.5);
    assert.equal(back.entry.sourceHash, 0xabcd_1234);
    assert.equal(back.entry.sourceSize, 999);
    assert.deepEqual([...back.table], [...table]);
  }
});
