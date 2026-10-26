/**
 * Pool planning and transfer planning.
 *
 * The allocation rule is the DT2's, read statically in DT2 1.16 (`0x40154476`):
 * `(length + 8207) & ~8191`. The expected values below are worked by hand from that expression,
 * not from `allocationBytes`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocationBytes,
  DN2_POOL_BYTES,
  DT2_POOL_BYTES,
  minutesIn,
  planPool,
  requireFits,
  SamplePool,
} from "@noiseandmatter/dnx-core/sample/pool.js";
import { planTransfer, planTransferTo, DATA_API_BYTES_PER_SECOND } from "@noiseandmatter/dnx-core/sample/transfer.js";
import { SampleError } from "@noiseandmatter/dnx-core/sample/errors.js";
import type { SampleId } from "@noiseandmatter/dnx-core/sample/identity.js";

const id = (n: number, size: number): SampleId => ({ hash: n.toString(16).padStart(16, "0"), size });

test("an allocation is the length plus 16 bytes, rounded up to 8 KiB", () => {
  // (2 + 8207) & ~8191 = 8192; (8176 + 8207) & ~8191 = 16383 & ~8191 = 8192; 8177 -> 16384.
  assert.equal(allocationBytes(2), 8192);
  assert.equal(allocationBytes(8176), 8192);
  assert.equal(allocationBytes(8177), 16_384);
  // One second of stereo: 192,000 + 8,207 = 200,207, & ~8191 = 196,608.
  assert.equal(allocationBytes(192_000), 196_608);
  assert.throws(() => allocationBytes(0), SampleError);
});

test("the budgets are the DT2's 400 MiB and the DN2's estimated 180.5 MiB", () => {
  assert.equal(DT2_POOL_BYTES, 0x19000000);
  assert.equal(DN2_POOL_BYTES, 189_267_968);
  // "32.9 minutes of mono" in the Bloom note.
  assert.equal(minutesIn(DN2_POOL_BYTES).toFixed(1), "32.9");
});

test("a plan counts each sample once and says when it does not fit", () => {
  const plan = planPool([id(1, 2), id(2, 8177), id(1, 2)], 20_000);
  assert.deepEqual(plan.allocations.map((a) => a.bytes), [8192, 16_384]);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.totalBytes, 24_576);
  assert.equal(plan.fits, false);
  assert.equal(plan.overBytes, 4_576);
  assert.throws(() => requireFits(plan), /too much/);
  assert.equal(requireFits(planPool([id(1, 2)], 8192)).fits, true);
});

test("the running pool keeps one copy, reuses a freed region by first fit, and stops when full", () => {
  const pool = new SamplePool(40_960);
  assert.equal(pool.load(id(1, 8177)), "appended"); // 16 KiB at 0
  assert.equal(pool.load(id(2, 2)), "appended"); // 8 KiB at 16 KiB
  assert.equal(pool.load(id(1, 8177)), "present");
  assert.equal(pool.usedBytes(), 24_576);

  assert.ok(pool.unload(id(1, 8177)));
  assert.equal(pool.freeBytes(), 40_960 - 24_576 + 16_384);
  // An 8 KiB sample takes the freed 16 KiB region whole, as the DT2's first fit does.
  assert.equal(pool.load(id(3, 2)), "reused");
  assert.equal(pool.usedBytes(), 24_576);
  // 16 KiB more goes after the end: 24 KiB + 16 KiB is exactly the 40 KiB budget.
  assert.equal(pool.load(id(4, 8177)), "appended");
  // Now nothing is free, so even the smallest sample does not fit.
  assert.equal(pool.load(id(5, 2)), "full");
  assert.equal(pool.unload(id(9, 2)), false);
});

test("a transfer plan sends only what the device lacks, by identity", () => {
  const plan = planTransfer([id(1, 1000), id(2, 2000), id(1, 1000), id(3, 3000)], [id(2, 2000), id(3, 2998)]);
  // id 3 on the device has another size, so it is another sample and is sent.
  assert.deepEqual(plan.send, [id(1, 1000), id(3, 3000)]);
  assert.deepEqual(plan.present, [id(2, 2000)]);
  assert.equal(plan.sendBytes, 4000);
  assert.equal(plan.seconds, 4000 / DATA_API_BYTES_PER_SECOND);
  assert.equal(planTransfer([id(1, 1000)], [], 1000).seconds, 1);
});

test("planTransferTo asks the store once, and only for its holdings", async () => {
  let asked = 0;
  const store = {
    holdings: async () => {
      asked++;
      return [id(1, 10)];
    },
  };
  const plan = await planTransferTo(store, [id(1, 10), id(2, 20)]);
  assert.equal(asked, 1);
  assert.deepEqual(plan.send, [id(2, 20)]);
});
