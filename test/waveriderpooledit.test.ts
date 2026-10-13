/**
 * Placing a table into a pool: the arithmetic, stated as pools rather than as device traffic.
 *
 * Every case here is one somebody would otherwise only find by writing a pool to an instrument and
 * then wondering where a table went. The decisive one is the ordering test: it fails for a plausible
 * implementation, and the symptom on hardware would be a table silently not added.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { POOL_ENTRIES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { clearInPool, freeIndices, placeInPool } from "@noiseandmatter/dnx-core/waverider/pooledit.js";

/** A pool holding the given store slots at indices 0.., and nothing after. */
function pool(...slots: (number | undefined)[]): (number | undefined)[] {
  const entries: (number | undefined)[] = new Array<number | undefined>(POOL_ENTRIES).fill(undefined);
  slots.forEach((slot, index) => {
    entries[index] = slot;
  });
  return entries;
}

test("a named index takes the table and says what it displaced", () => {
  const before = pool(3, 9, 40);
  const { entries, placed } = placeInPool(before, [{ storeSlot: 77, index: 1 }]);

  assert.equal(entries[1], 77);
  assert.deepEqual(placed, [{ storeSlot: 77, index: 1, replaced: 9 }]);
  // The displaced slot is reported rather than refused: replacing an entry is how a pool is
  // curated, and the caller's job is to name what is about to go, not to prevent it.
  assert.equal(entries[0], 3);
  assert.equal(entries[2], 40);
});

test("no index means the first empty slot, and an entry is never empty because its table is gone", () => {
  /*
   * **This is the MISSING rule, in the only terms this module can see it.** An entry naming a store
   * slot whose table was deleted is a number, so it is occupied here — which is exactly what makes
   * the instrument's behaviour and DNX's agree: ADD TO POOL skips it and fills the first empty
   * index. Treating it as spare would reuse somebody's dangling entry and leave every sound set to
   * that number playing an unrelated table.
   */
  const withMissing = pool(3, 250, undefined, 9);
  const { entries, placed } = placeInPool(withMissing, [{ storeSlot: 11 }]);

  assert.equal(placed[0]!.index, 2, "the first *empty* index, not the first useless one");
  assert.equal(entries[1], 250, "the dangling entry survives untouched");
  assert.equal(entries[2], 11);
  assert.equal(placed[0]!.replaced, undefined, "an empty slot displaced nothing");
});

test("two tables with no index take two different slots", () => {
  const { entries, placed } = placeInPool(pool(3), [{ storeSlot: 8 }, { storeSlot: 9 }]);
  assert.deepEqual(placed.map((one) => one.index), [1, 2]);
  assert.equal(entries[1], 8);
  assert.equal(entries[2], 9);
});

test("a named index is reserved before a nameless one is handed a slot", () => {
  /*
   * **The case that fails for the obvious implementation.** Walking the requests in order gives the
   * first one index 1, the second one then replaces it, and the table from store slot 8 is gone
   * with no error raised anywhere. On an instrument that reads as "I added two tables and only one
   * arrived", which is a bug nobody can see from the pool afterwards.
   */
  const { entries, placed } = placeInPool(pool(3), [
    { storeSlot: 8 },
    { storeSlot: 9, index: 1 },
  ]);

  assert.equal(entries[1], 9, "the named index belongs to the request that named it");
  assert.equal(entries[2], 8, "the nameless one moved along rather than being overwritten");
  // Reported in request order, whatever order they were resolved in: the caller numbered them.
  assert.deepEqual(placed, [
    { storeSlot: 8, index: 2 },
    { storeSlot: 9, index: 1 },
  ]);
});

test("one index asked for twice is refused rather than letting one table win", () => {
  assert.throws(
    () => placeInPool(pool(), [{ storeSlot: 1, index: 4 }, { storeSlot: 2, index: 4 }]),
    (error: unknown) =>
      error instanceof WaveriderError && /asked for twice/.test(error.message),
  );
});

test("a full pool refuses a table with no index, and says what to do instead", () => {
  const full = new Array<number | undefined>(POOL_ENTRIES).fill(7);
  assert.throws(
    () => placeInPool(full, [{ storeSlot: 9 }]),
    (error: unknown) =>
      error instanceof WaveriderError &&
      /no free slot/.test(error.message) &&
      // The refusal has to name the way out, because there is one: name the slot to replace.
      /naming the slot it replaces/.test(error.message),
  );
});

test("the same table may sit at two indices, which the firmware allows", () => {
  const { entries } = placeInPool(pool(3), [{ storeSlot: 3, index: 5 }]);
  assert.equal(entries[0], 3);
  assert.equal(entries[5], 3);
});

test("a store slot or an index outside its range is refused by name", () => {
  assert.throws(() => placeInPool(pool(), [{ storeSlot: 256 }]), WaveriderError);
  assert.throws(() => placeInPool(pool(), [{ storeSlot: -1 }]), WaveriderError);
  assert.throws(() => placeInPool(pool(), [{ storeSlot: 1, index: POOL_ENTRIES }]), WaveriderError);
  assert.throws(() => placeInPool(pool(), [{ storeSlot: 1, index: 1.5 }]), WaveriderError);
});

test("the entries handed in are left alone, and the answer is always a whole pool", () => {
  // The caller's copy is usually the reading on screen. Editing it in place would move the pane's
  // own idea of the pool before anything was sent, and a cancelled write would leave it wrong.
  const before = pool(3, 9);
  const { entries } = placeInPool(before, [{ storeSlot: 77, index: 0 }]);
  assert.equal(before[0], 3, "the input was mutated");
  assert.equal(entries.length, POOL_ENTRIES, "buildPoolFile wants the whole pool");
});

test("freeIndices counts the empty ones and nothing else", () => {
  assert.deepEqual(freeIndices(pool(3, 9)).slice(0, 2), [2, 3]);
  assert.equal(freeIndices(pool(3, 9)).length, POOL_ENTRIES - 2);
  assert.deepEqual(freeIndices(new Array<number | undefined>(POOL_ENTRIES).fill(1)), []);

  // A short array is a legal record in hand: `readPoolFile` always returns 128, but a caller
  // building one may pass fewer, and the missing tail is free rather than absent.
  assert.equal(freeIndices([1, 2]).length, POOL_ENTRIES - 2);
});

test("nothing to place is a mistake rather than a no-op write", () => {
  // A pool write is an overwrite with a backup and a confirmation. Sending one that changes
  // nothing would spend all of that to achieve nothing, so it is refused here.
  assert.throws(() => placeInPool(pool(3), []), WaveriderError);
});

test("clearing a slot empties it and leaves everything else exactly where it was", () => {
  /*
   * **The hole stays a hole, on purpose.** Closing it up would renumber every table after it, and
   * every sound already set to one of those numbers would then play a different table — a far
   * bigger change than the one being asked for, applied to sounds nobody mentioned.
   */
  const before = pool(3, 9, 40, 77);
  const { entries, placed } = clearInPool(before, [1]);

  assert.equal(entries[1], undefined, "the named slot is empty");
  assert.deepEqual(entries.slice(0, 4), [3, undefined, 40, 77], "nothing shuffled up");
  assert.deepEqual(placed, [{ storeSlot: 9, index: 1, replaced: 9 }]);
  assert.equal(before[1], 9, "the input was mutated");
});

test("clearing an already empty slot is refused rather than written as a no-op", () => {
  // A pool write costs a confirmation, a saved copy and an overwrite of somebody's record. Sending
  // one that changes nothing spends all of that to achieve nothing.
  assert.throws(
    () => clearInPool(pool(3), [5]),
    (error: unknown) => error instanceof WaveriderError && /already empty/.test(error.message),
  );
  assert.throws(() => clearInPool(pool(3), []), WaveriderError);
});

test("clearing refuses a slot named twice, and an index outside the pool", () => {
  assert.throws(
    () => clearInPool(pool(3, 9), [0, 0]),
    (error: unknown) => error instanceof WaveriderError && /named twice/.test(error.message),
  );
  assert.throws(() => clearInPool(pool(3), [POOL_ENTRIES]), WaveriderError);
  assert.throws(() => clearInPool(pool(3), [-1]), WaveriderError);
});

test("a cleared slot is then the first free one, which is the hole the warning is about", () => {
  // The two halves meeting: take slot 2 out, and the next add with no index goes straight into it
  // rather than to the end. This is exactly what `poolview.ts` warns of, and it is correct —
  // it is only wrong when DNX does the clearing without being asked.
  const { entries } = clearInPool(pool(3, 9, 40), [1]);
  const next = placeInPool(entries, [{ storeSlot: 55 }]);
  assert.equal(next.placed[0]!.index, 1, "the next add falls into the hole");
  assert.equal(next.entries[2], 40, "and the table after it has not moved");
});
