/**
 * The join between a pool record and a listing of the store, where the interesting states live.
 *
 * MISSING is the subject. It cannot be seen in the record — an entry naming a deleted table looks
 * exactly like an entry naming a stored one — and it is the state that makes a sound play the wrong
 * thing, so these tests are about the rules the firmware session and DNX agreed rather than about
 * arithmetic.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type StoreSlotFacts,
  describePool,
  summarisePool,
} from "@noiseandmatter/dnx-core/waverider/poolview.js";
import { type PoolRecord } from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { POOL_ENTRIES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { INDEX_ENTRIES } from "@noiseandmatter/dnx-core/waverider/layout.js";

/** A listing of all 256 slots, with the named ones in use. */
function listing(used: Record<number, string>): StoreSlotFacts[] {
  const out: StoreSlotFacts[] = [];
  for (let slot = 0; slot < INDEX_ENTRIES; slot++) {
    const name = used[slot];
    out.push(name === undefined ? { slot, occupied: false } : { slot, name, occupied: true });
  }
  return out;
}

function record(entries: (number | undefined)[], over: Partial<PoolRecord> = {}): PoolRecord {
  return {
    projectSlot: 4,
    automatic: false,
    generation: 7,
    entries,
    ...over,
  };
}

test("a cell carries all three of a table's numbers, which are not interchangeable", () => {
  const summary = summarisePool(record([9, 20]), listing({ 9: "HS SAW", 20: "QUANT NOISE" }));

  // pool index 0, shown slot 1, coarse 2 — stored-to-label is coarse - 1 and stored-to-index is
  // coarse - 2, and either written where the other belongs looks right across most of the range.
  assert.deepEqual(summary.cells[0], {
    index: 0, shown: 1, coarse: 2, storeSlot: 9, name: "HS SAW", state: "table",
  });
  assert.deepEqual(summary.cells[1], {
    index: 1, shown: 2, coarse: 3, storeSlot: 20, name: "QUANT NOISE", state: "table",
  });
  assert.equal(summary.cells[2]?.state, "empty");
  assert.equal(summary.cells.length, POOL_ENTRIES);
});

test("an entry naming a free store slot is MISSING, and the free count excludes it", () => {
  // The table at slot 20 was deleted. The entry still names it, so pool slot 2 plays Prim.
  const summary = summarisePool(record([9, 20]), listing({ 9: "HS SAW" }));

  assert.equal(summary.cells[1]?.state, "missing");
  assert.equal(summary.cells[1]?.storeSlot, 20);
  assert.equal(summary.cells[1]?.name, undefined, "there is no name to show: the slot is empty");
  assert.match(summary.cells[1]?.note ?? "", /deleted/);
  assert.match(summary.cells[1]?.note ?? "", /Prim/, "and what it plays instead");

  assert.equal(summary.tables, 1);
  assert.equal(summary.missing, 1);
  // **126, not 127.** The slot is spoken for: ADD TO POOL will not fill it, and only CLEAR SLOT
  // frees it. A free count that included it would promise a slot nobody can have.
  assert.equal(summary.free, POOL_ENTRIES - 2);
});

test("a slot absent from the listing is not reported as a deleted table", () => {
  // A short listing and a deleted table read the same from the record, and one of them is a reason
  // to tell somebody their sound is broken. So the note says which this is.
  const short: StoreSlotFacts[] = [{ slot: 9, name: "HS SAW", occupied: true }];
  const summary = summarisePool(record([9, 20]), short);

  assert.equal(summary.cells[1]?.state, "missing");
  assert.match(summary.cells[1]?.note ?? "", /not in the listing/);
  assert.doesNotMatch(summary.cells[1]?.note ?? "", /deleted/);
});

test("two entries may name one slot, and the store side can say which", () => {
  const summary = summarisePool(
    record([9, 20, 9]),
    listing({ 9: "HS SAW", 20: "QUANT NOISE" }),
  );

  assert.deepEqual(summary.byStoreSlot.get(9), [0, 2]);
  assert.deepEqual(summary.repeated, [9]);
  assert.equal(summary.tables, 3, "three entries hold a table, two of them the same one");
});

test("whether somebody wrote the pool changes what the numbers mean", () => {
  const entries = [9, 20];
  const store = listing({ 9: "HS SAW", 20: "QUANT NOISE" });

  // A read with no stored record behind it: generation 0. The entries are real — the firmware
  // synthesised them and that is what the project plays — but an upload moves them.
  const untouched = summarisePool(record(entries, { generation: 0, automatic: true }), store);
  assert.equal(untouched.kind, "untouched");
  assert.equal(untouched.authored, false);
  assert.match(describePool(untouched), /no pool of its own/);
  assert.match(describePool(untouched), /sounds do not follow/);

  // Written as automatic on purpose. Same entries, same hazard, different sentence.
  const automatic = summarisePool(record(entries, { automatic: true }), store);
  assert.equal(automatic.kind, "automatic");
  assert.equal(automatic.authored, false);
  assert.match(describePool(automatic), /follow the store/);

  // A list somebody wrote. These stay put.
  const list = summarisePool(record(entries), store);
  assert.equal(list.kind, "list");
  assert.equal(list.authored, true);
  assert.match(describePool(list), /stay where they are/);
});

test("the working project says so rather than calling itself slot 0", () => {
  const summary = summarisePool(
    record([9], { projectSlot: 0 }),
    listing({ 9: "HS SAW" }),
  );
  assert.match(describePool(summary), /the working project/);
});

test("an empty list is a pool, and reads as one", () => {
  // A project made with CREATE NEW holds a record with no entries, which is audibly different from
  // having no record: it plays nothing, where a project with no record plays the whole store.
  const summary = summarisePool(record([]), listing({ 9: "HS SAW" }));

  assert.equal(summary.kind, "list");
  assert.equal(summary.tables, 0);
  assert.equal(summary.missing, 0);
  assert.equal(summary.free, POOL_ENTRIES);
  assert.match(describePool(summary), /pool of its own/);
});
