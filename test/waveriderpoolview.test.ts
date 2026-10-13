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
  tblLabel,
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
    followsStore: false,
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
  const store: StoreSlotFacts[] = [
    { slot: 9, occupied: true, name: "HS SAW" },
    { slot: 20, occupied: true, name: "QUANT NOISE" },
  ];

  /*
   * **Three states, and the first one changed meaning on 2026-10-13.** A project with no record
   * used to be answered by the firmware with every stored table filled in; it now plays nothing.
   * Both answers still arrive here, because an instrument that has not been flashed sends the old
   * one, so the summary has to describe the record in front of it rather than a default.
   */

  // A record-less read from a build that fills it: the project really does play these.
  const follows = summarisePool(record(entries, { generation: 0, followsStore: true }), store);
  assert.equal(follows.kind, "follows-store");
  assert.equal(follows.authored, false, "nobody chose these slots, so they are not pinned");
  assert.match(describePool(follows), /follows the store/);
  assert.match(describePool(follows), /moves every later pool slot/);

  // The same project read from a build where no record means no pool.
  const empty = summarisePool(record([], { generation: 0, followsStore: false }), store);
  assert.equal(empty.kind, "empty");
  assert.equal(empty.authored, false);
  assert.match(describePool(empty), /plays no wavetables/);
  assert.match(describePool(empty), /built-in Prim/);
  // It must not tell somebody their sounds will shift: there is nothing in it to shift.
  assert.doesNotMatch(describePool(empty), /moves every later pool slot/);

  // And a list somebody wrote, which is pinned.
  const list = summarisePool(record(entries, { generation: 4, followsStore: false }), store);
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

test("the TBL label is the pool slot, not the stored value", () => {
  /*
   * **The arithmetic that was wrong in the help from the day it was written.** A sound stores
   * `index + 2`; the instrument displays `stored - 1` as `T:%03d`. So the number on screen is the
   * shown pool slot and there is nothing for a person to add. DNX told people to add one until the
   * firmware session read `csrc/waverider/page.c` on 2026-10-13 and said otherwise.
   *
   * Pinned at both ends because an off-by-one in the middle of the range looks right: `T:005` for
   * slot 5 is the case somebody can check against their own instrument.
   */
  assert.equal(tblLabel(0), "T:001", "the first pool slot, stored as coarse 2");
  assert.equal(tblLabel(4), "T:005", "pool slot 5 — the example the help gives");
  assert.equal(tblLabel(POOL_ENTRIES - 1), "T:128", "the last pool slot, stored as coarse 129");

  // Three digits, always: the cell is a fixed width and `T:5` is not a thing anybody will see.
  assert.match(tblLabel(9), /^T:\d{3}$/);

  // And it agrees with the summary's own `shown`, which is the number both panes print.
  const summary = summarisePool(record([9]), [{ slot: 9, occupied: true, name: "A" }]);
  assert.equal(tblLabel(0), `T:${String(summary.cells[0]!.shown).padStart(3, "0")}`);
  assert.equal(summary.cells[0]!.coarse, 2, "stored is still index + 2, and is not what is shown");
});
