/**
 * What proves a pool write landed.
 *
 * **The claim under test is one sentence**: the firmware owns the generation, the record hash and
 * the container CRC, and everything else — the entries above all — is compared. That is the only
 * evidence a pool write has, because a refusal on this route answers the commit with `ok` and
 * writes nothing.
 *
 * The transport is not mocked here. What is tested is the comparison, which is where the
 * reasoning lives: a read-back is simulated exactly as the firmware produces one, by stamping the
 * generation and recomputing the two checks over it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { STAMPED_BY_FIRMWARE, poolPath } from "@noiseandmatter/dnx-core/device/wavepoolwrite.js";
import { compareStored } from "@noiseandmatter/dnx-core/device/safewrite.js";
import {
  RECORD,
  buildPoolFile,
  readPoolFile,
} from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { HEADER_BYTES } from "@noiseandmatter/dnx-core/project/container.js";
import { crc32ZeroInit } from "@noiseandmatter/dnx-core/project/checksum.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { STORED_FORM_BY_ROOT, FORM_RAW } from "@noiseandmatter/dnx-core/device/storagewrite.js";

const putBe32 = (b: Uint8Array, at: number, v: number): void => {
  for (let i = 0; i < 4; i++) b[at + i] = (v >>> (24 - i * 8)) & 0xff;
};

/** What the firmware hands back after taking a write: generation + 1, and both checks redone. */
function asStored(sent: Uint8Array, generation: number): Uint8Array {
  const out = Uint8Array.from(sent);
  const record = out.subarray(HEADER_BYTES, HEADER_BYTES + 512);
  putBe32(record, RECORD.generation, generation);
  putBe32(record, RECORD.hash, xxHash32(record.subarray(0, RECORD.hash)));
  putBe32(out, HEADER_BYTES + 512, crc32ZeroInit(record));
  return out;
}

function sample(): Uint8Array {
  return buildPoolFile({ projectSlot: 3, automatic: false, entries: [3, undefined, 0], generation: 4 });
}

test("a pool slot addresses the path the device resolves", () => {
  assert.equal(poolPath(0), "/wavepool/0");
  assert.equal(poolPath(128), "/wavepool/128");
});

test("the route stores the raw form, and the table says where that was measured", () => {
  assert.equal(STORED_FORM_BY_ROOT["wavepool"], FORM_RAW);
});

test("a correct pool write never reads back identical, and that is not a fault", () => {
  const sent = sample();
  const back = asStored(sent, 5);

  // Without the excusal it looks like a failed write, which is what it would have reported.
  assert.notDeepEqual(compareStored(sent, back), []);

  // With it, a write the firmware took is a write that verified.
  assert.deepEqual(compareStored(sent, back, STAMPED_BY_FIRMWARE), []);
});

test("an entry that did not land is not excused, which is the whole proof", () => {
  const sent = sample();
  const back = asStored(sent, 5);

  // The instrument holds a different list: store slot 9 where we sent 3. This is what a stale
  // write looks like from here — our entries are simply not there.
  const record = back.subarray(HEADER_BYTES, HEADER_BYTES + 512);
  record[RECORD.entries + 1] = 9;
  putBe32(record, RECORD.hash, xxHash32(record.subarray(0, RECORD.hash)));
  putBe32(back, HEADER_BYTES + 512, crc32ZeroInit(record));

  const mismatches = compareStored(sent, back, STAMPED_BY_FIRMWARE);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.at, HEADER_BYTES + RECORD.entries + 1);
  assert.equal(readPoolFile(back).entries[0], 9, "and the reader agrees about what it holds");
});

test("the stamped set is the three fields the firmware owns, and nothing else", () => {
  assert.equal(STAMPED_BY_FIRMWARE.size, 12);

  for (let i = 0; i < 4; i++) {
    assert.ok(STAMPED_BY_FIRMWARE.has(HEADER_BYTES + RECORD.generation + i), `generation +${i}`);
    assert.ok(STAMPED_BY_FIRMWARE.has(HEADER_BYTES + RECORD.hash + i), `record hash +${i}`);
    assert.ok(STAMPED_BY_FIRMWARE.has(HEADER_BYTES + 512 + i), `container CRC +${i}`);
  }

  // Every entry byte is compared. A set that grew to cover one would make the write unprovable.
  for (let j = 0; j < 8; j++) {
    assert.ok(!STAMPED_BY_FIRMWARE.has(HEADER_BYTES + RECORD.entries + j), `entry byte ${j}`);
  }
  assert.ok(!STAMPED_BY_FIRMWARE.has(HEADER_BYTES + RECORD.entriesInUse));
  assert.ok(!STAMPED_BY_FIRMWARE.has(HEADER_BYTES + RECORD.flags));
});

test("the generation alone cannot prove a write, which is why it is not the proof", () => {
  /*
   * The hole in "check that the generation is sent + 1". Another writer lands between our read
   * and our write: ours is refused, and the generation is still `before + 1` — from theirs. A
   * generation check calls that a success; the entries do not.
   */
  const before = 4;
  const ours = buildPoolFile({ projectSlot: 3, automatic: false, entries: [3], generation: before });
  const theirs = buildPoolFile({ projectSlot: 3, automatic: false, entries: [7], generation: before });
  const held = asStored(theirs, before + 1);

  assert.equal(readPoolFile(held).generation, before + 1, "the generation looks exactly right");
  assert.notDeepEqual(compareStored(ours, held, STAMPED_BY_FIRMWARE), [], "the entries do not");
});
