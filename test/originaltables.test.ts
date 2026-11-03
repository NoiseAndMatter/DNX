/**
 * The original tables DNX installs, and the pool shift for an older project.
 *
 * The expected table bytes come from the WAV's own `data` chunk, swapped here, not from the
 * converter. The hashes are the firmware session's, so a changed file fails rather than agrees
 * with itself.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  emptyEntryPlays,
  freeStoreSlots,
  keepOldTblValues,
  missingOriginalTables,
  originalTablePending,
  originalTableSlot,
} from "@noiseandmatter/dnx-core/waverider/originaltables.js";
import { buildSlotFile, readSlotFile } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { CAPABILITY } from "@noiseandmatter/dnx-core/waverider/modinfo.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

const FILES = [
  { name: "Prim.", path: "web/vendor/tables/Prim.wav", sha256: "b406f635226ecb277516f488ef2ced3b7329cb20d99606b69ac38e1da052cc2b" },
  { name: "Harm.", path: "web/vendor/tables/Harm.wav", sha256: "e1d2739aec3e49414924670a35dfe4c1d3c133ad84ca781531a7f51d3d50e93b" },
];

for (const file of FILES) {
  test(`${file.name} is the firmware's file, copied to the table without a change`, () => {
    const wav = readFileSync(file.path);
    assert.equal(createHash("sha256").update(wav).digest("hex"), file.sha256);

    const pending = originalTablePending(file.name, new Uint8Array(wav), 75);
    assert.equal(pending.name, file.name, "the exact store name, with no _wt suffix");
    assert.equal(pending.waves, 16);
    assert.equal(pending.points, 512);
    assert.equal(pending.gain, 1);

    const pcm = wav.subarray(wav.length - 16_384);
    for (let i = 0; i < pcm.length; i += 2) {
      assert.equal(pending.table[i], pcm[i + 1], `high byte at ${i}`);
      assert.equal(pending.table[i + 1], pcm[i], `low byte at ${i}`);
    }

    const round = readSlotFile(buildSlotFile(pending));
    assert.equal(round.entry.name, file.name);
    assert.deepEqual(round.table, pending.table);
  });
}

test("a file of another shape is refused", () => {
  const wav = new Uint8Array(readFileSync(FILES[0]!.path));
  assert.throws(() => originalTablePending("Prim.", wav.subarray(0, 1044), 0), WaveriderError);
});

const listing = (named: Record<number, string>, slots = 4) =>
  Array.from({ length: slots }, (_, slot) => ({
    slot,
    occupied: named[slot] !== undefined,
    ...(named[slot] === undefined ? {} : { name: named[slot]! }),
  }));

test("the listing decides what is missing, by exact name", () => {
  assert.deepEqual(missingOriginalTables(listing({})).map((t) => t.name), ["Prim.", "Harm."]);
  assert.deepEqual(missingOriginalTables(listing({ 2: "Prim." })).map((t) => t.name), ["Harm."]);
  assert.deepEqual(missingOriginalTables(listing({ 0: "Prim._wt512", 1: "Harm" })).length, 2);
  assert.deepEqual(missingOriginalTables(listing({ 0: "Prim.", 1: "Harm." })), []);
  assert.equal(originalTableSlot(listing({ 3: "Harm." }), "Harm."), 3);
});

test("the free slots skip occupied and staged slots, and a full store refuses", () => {
  assert.deepEqual(freeStoreSlots(listing({ 0: "A" }), 2, new Set([1])), [2, 3]);
  assert.throws(() => freeStoreSlots(listing({ 0: "A", 1: "B", 2: "C" }), 2), /1 free slot/);
});

test("every saved TBL value but 0 plays the same table after the shift", () => {
  const before = new Array<number | undefined>(128).fill(undefined);
  before[0] = 40;
  before[1] = 41;
  before[3] = 43;
  const harm = 7;
  const after = keepOldTblValues(before, harm);
  assert.equal(after.length, 128);

  // The two numberings, written out here rather than taken from the code under test.
  const oldBuildPlays = (coarse: number): number | string | undefined =>
    coarse === 0 ? "Prim." : coarse === 1 ? "Harm." : before[coarse - 2];
  const poolOnlyPlays = (coarse: number): number | string | undefined => {
    if (coarse === 0) return undefined;
    const slot = after[coarse - 1];
    return slot === harm ? "Harm." : slot;
  };
  for (let coarse = 1; coarse <= 128; coarse++) {
    assert.equal(poolOnlyPlays(coarse), oldBuildPlays(coarse), `coarse ${coarse}`);
  }
  assert.equal(poolOnlyPlays(0), undefined, "old Prim. stays silent");
});

test("the shift refuses a second press and a full pool", () => {
  const empty = new Array<number | undefined>(128).fill(undefined);
  assert.throws(() => keepOldTblValues(keepOldTblValues(empty, 7), 7), /already holds Harm/);
  const full = [...empty];
  full[127] = 9;
  assert.throws(() => keepOldTblValues(full, 7), /Pool slot 128/);
});

test("the capability is bit 0x100, and the empty-slot sentence follows it", () => {
  assert.equal(CAPABILITY.poolOnly, 0x100);
  assert.equal(emptyEntryPlays(true), "nothing");
  assert.equal(emptyEntryPlays(false), "the built-in Prim.");
});
