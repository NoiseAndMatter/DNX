/**
 * Which slots a bank switch actually has to read.
 *
 * The whole value of the cache is a number â€” round trips avoided â€” and counting those by switching
 * banks on a real instrument and watching a status line is not a test anyone runs twice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BankCache,
  type SlotFacts,
  forget,
  planBankRead,
  remember,
} from "../web/src/library/bankcache.js";
import { type LibraryBank, type LibraryEntry } from "../src/device/library.js";

function entry(index: number, over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    name: `P${index}`,
    index,
    size: 364,
    occupied: true,
    writable: false,
    ...over,
  };
}

function bank(entries: LibraryEntry[]): LibraryBank {
  return {
    kind: "preset",
    bank: "A",
    path: "/soundbanks/A",
    entries,
    used: entries.filter((e) => e.occupied).length,
  };
}

const facts = (n: number): Map<number, SlotFacts> =>
  new Map(Array.from({ length: n }, (_, i) => [i + 1, { tags: ["KICK" as const], machine: "FM TONE" }]));

test("with nothing cached, every occupied slot is read", () => {
  const fresh = bank([entry(1), entry(2), entry(3, { occupied: false, name: "" })]);
  const { toRead, reuse } = planBankRead(undefined, fresh);
  assert.deepEqual(toRead, [1, 2]);
  assert.equal(reuse.size, 0);
});

test("an empty slot is never read â€” there is nothing in it to have tags", () => {
  const fresh = bank([entry(1, { occupied: false, name: "" }), entry(2, { occupied: false, name: "" })]);
  assert.deepEqual(planBankRead(undefined, fresh).toRead, []);
});

test("an unchanged bank reads nothing at all", () => {
  // The point of the exercise: A -> B -> A costs one listing, not 256 body reads.
  const cache: BankCache = new Map();
  const first = bank([entry(1), entry(2)]);
  remember(cache, "preset", first, facts(2));

  const again = planBankRead(cache.get("preset/A"), bank([entry(1), entry(2)]));
  assert.deepEqual(again.toRead, [], "nothing changed, so nothing is re-read");
  assert.equal(again.reuse.size, 2, "and both slots keep what was learned about them");
});

test("only the slot that changed is read again", () => {
  const cache: BankCache = new Map();
  remember(cache, "preset", bank([entry(1), entry(2), entry(3)]), facts(3));

  // Slot 2 renamed on the instrument's front panel.
  const fresh = bank([entry(1), entry(2, { name: "RENAMED" }), entry(3)]);
  const { toRead, reuse } = planBankRead(cache.get("preset/A"), fresh);

  assert.deepEqual(toRead, [2]);
  assert.deepEqual([...reuse.keys()], [1, 3]);
});

test("a slot becoming protected counts as changed", () => {
  // The instrument marks saved work, so `writable` flipping is a real event on the device even
  // though the name and size are untouched. Part of the fingerprint for that reason.
  const cache: BankCache = new Map();
  remember(cache, "preset", bank([entry(1)]), facts(1));

  const fresh = bank([entry(1, { writable: true })]);
  assert.deepEqual(planBankRead(cache.get("preset/A"), fresh).toRead, [1]);
});

test("a slot that became occupied is read; one that became empty is not", () => {
  const cache: BankCache = new Map();
  remember(cache, "preset", bank([entry(1), entry(2, { occupied: false, name: "" })]), facts(1));

  const fresh = bank([entry(1, { occupied: false, name: "" }), entry(2, { name: "NEW" })]);
  const { toRead } = planBankRead(cache.get("preset/A"), fresh);
  assert.deepEqual(toRead, [2], "the newly filled slot, and only it");
});

test("an occupied slot whose read failed last time is not treated as cached", () => {
  // The trap: its listing entry is unchanged, so a naive fingerprint comparison would skip it
  // forever and the row would say "readingâ€¦" for the rest of the session.
  const cache: BankCache = new Map();
  const only = bank([entry(1), entry(2)]);
  remember(cache, "preset", only, facts(1)); // slot 2's read failed, so no facts for it

  const { toRead, reuse } = planBankRead(cache.get("preset/A"), bank([entry(1), entry(2)]));
  assert.deepEqual(toRead, [2]);
  assert.deepEqual([...reuse.keys()], [1]);
});

test("force reads everything and keeps nothing", () => {
  // For the case a listing cannot see: a slot overwritten by something of the same name and size.
  const cache: BankCache = new Map();
  remember(cache, "preset", bank([entry(1), entry(2)]), facts(2));

  const { toRead, reuse } = planBankRead(cache.get("preset/A"), bank([entry(1), entry(2)]), {
    force: true,
  });
  assert.deepEqual(toRead, [1, 2]);
  assert.equal(reuse.size, 0);
});

test("kits and presets are different banks under the same letter", () => {
  const cache: BankCache = new Map();
  remember(cache, "preset", bank([entry(1)]), facts(1));
  assert.equal(cache.get("kit/A"), undefined, "browsing kits must not reuse a preset bank's tags");
  assert.ok(cache.get("preset/A"));
});

test("forgetting one bank leaves the others", () => {
  const cache: BankCache = new Map();
  remember(cache, "preset", bank([entry(1)]), facts(1));
  remember(cache, "kit", { ...bank([entry(1)]), kind: "kit", bank: "B" }, facts(1));

  forget(cache, "preset", "A");
  assert.equal(cache.get("preset/A"), undefined);
  assert.ok(cache.get("kit/B"), "a refresh of one bank is not a refresh of all of them");
});

test("the cache holds copies, so a later listing cannot rewrite history", () => {
  // `remember` copies both the entries and the facts. Storing the live arrays would mean the next
  // listing mutating what it is about to be compared against â€” a cache that always agrees.
  const cache: BankCache = new Map();
  const entries = [entry(1)];
  const live = bank(entries);
  remember(cache, "preset", live, facts(1));

  entries[0] = entry(1, { name: "MUTATED" });
  assert.deepEqual(planBankRead(cache.get("preset/A"), bank(entries)).toRead, [1]);
});

