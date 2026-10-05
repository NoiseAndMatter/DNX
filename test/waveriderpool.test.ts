/**
 * What the pool plays, which is narrower than what a slot holds.
 *
 * These numbers are one firmware build's, not the format's, so they are pinned here rather than
 * derived from anything: when the loader widens, these assertions are what should fail first and
 * say what changed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_POOL_TBL,
  POOL_BYTES,
  POOL_ENTRIES,
  POOL_POINTS,
  POOL_BOOT_FILL_SECONDS,
  POOL_WAVES,
  poolPlacement,
  unplayableReason,
} from "@noiseandmatter/dnx-core/waverider/pool.js";
import { FORMAT_INT16_BE } from "@noiseandmatter/dnx-core/waverider/entries.js";
import { SLOT_BYTES } from "@noiseandmatter/dnx-core/waverider/layout.js";

test("the pool's limits, and the gap between stored and playable", () => {
  assert.equal(POOL_WAVES, 16);
  assert.equal(POOL_POINTS, 512);
  assert.equal(POOL_BYTES, 16_384);
  assert.equal(POOL_ENTRIES, 127);
  assert.equal(FIRST_POOL_TBL, 2, "TBL 0 and 1 are the baked tables");
  // **Boot only.** A commit refills on the next UI pass, about a second, and this number is not
  // that one. They were conflated here and the write path told people to wait five times too long.
  assert.equal(POOL_BOOT_FILL_SECONDS, 5);

  // **The gap, as arithmetic.** A slot holds thirty-two times what the pool loads, which is the
  // whole reason this module exists: the store was sized for a format that has not arrived.
  assert.equal(SLOT_BYTES / POOL_BYTES, 32);
});

test("a table the pool will not play says so, and says what happens to it instead", () => {
  assert.equal(unplayableReason({ waves: POOL_WAVES, points: POOL_POINTS }), undefined);
  assert.equal(
    unplayableReason({ waves: POOL_WAVES, points: POOL_POINTS, sampleFormat: FORMAT_INT16_BE }),
    undefined,
  );

  // The Tonverk table the slot was sized for: stored at full resolution, silent today.
  const biggest = unplayableReason({ waves: 64, points: 4_096 });
  assert.match(biggest!, /64 x 4096 is stored but not played/);
  assert.match(biggest!, /full resolution and will play unchanged/,
    "a reason that only says no leaves the user thinking the write failed");

  assert.match(unplayableReason({ waves: 8, points: 512 })!, /loads 16 x 512 only/);
  assert.match(unplayableReason({ waves: 16, points: 1_024 })!, /loads 16 x 512 only/);
  assert.match(unplayableReason({ waves: 16, points: 512, sampleFormat: 2 })!, /sample format 2/);
});

test("the pool is handed out in slot order, and runs out at 127", () => {
  // Order is applied here, so a caller passing a listing in listing order cannot get it wrong.
  const placed = poolPlacement([9, 0, 5]);
  assert.deepEqual([...placed], [[0, 2], [5, 3], [9, 4]]);

  // A duplicate slot is one slot, not two entries.
  assert.deepEqual([...poolPlacement([4, 4, 4])], [[4, 2]]);

  /*
   * **The 128th used slot gets no TBL number**, which is the case a user filling the store would
   * otherwise meet with no warning: stored, listed, verified, never played.
   */
  const many = poolPlacement(Array.from({ length: 130 }, (_, i) => i));
  assert.equal(many.get(0), FIRST_POOL_TBL);
  assert.equal(many.get(POOL_ENTRIES - 1), FIRST_POOL_TBL + POOL_ENTRIES - 1);
  assert.equal(many.get(POOL_ENTRIES), undefined, "the 128th used slot is past the pool");
  assert.equal(many.get(129), undefined);
  assert.equal([...many.values()].filter((v) => v !== undefined).length, POOL_ENTRIES);

  // And the numbers are contiguous from 2, because the pool is filled rather than indexed by slot.
  const sparse = poolPlacement([0, 100, 255]);
  assert.deepEqual([...sparse.values()], [2, 3, 4]);
});
