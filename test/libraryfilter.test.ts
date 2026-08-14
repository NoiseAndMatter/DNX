/**
 * Finding one preset in a bank of 256.
 *
 * All of this is pure, so it is tested directly rather than by scrolling a list on screen — which
 * is the reason `filter.ts` has no DOM in it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type LibraryRow,
  NO_FILTER,
  filterRows,
  tagCounts,
  toggleTag,
} from "../web/src/library/filter.js";
import { type TagName } from "../src/project/tags.js";

function row(over: Partial<LibraryRow> & { index: number }): LibraryRow {
  return { name: "", occupied: true, writable: false, size: 364, ...over };
}

const BANK: LibraryRow[] = [
  row({ index: 1, name: "BD 1 BR", tags: ["KICK", "HARD"], machine: "FM TONE" }),
  row({ index: 2, name: "BD DUSTY", tags: ["KICK", "SOFT"], machine: "FM TONE" }),
  row({ index: 3, name: "WIDE HATS", tags: ["HI-HAT", "BRIGHT"], machine: "FM DRUM" }),
  row({ index: 4, name: "DEEP TOM", tags: ["PERCUSSION", "DEEP"], machine: "FM DRUM" }),
  row({ index: 5, name: "PAD SLOW", tags: ["PAD", "SOFT"], machine: "WAVETONE" }),
  row({ index: 6, name: "", occupied: false, writable: true }),
];

test("no filter shows everything, including free slots", () => {
  const { rows, unknown } = filterRows(BANK, NO_FILTER);
  assert.equal(rows.length, 6);
  assert.equal(unknown, 0);
});

test("the omnibox matches the name", () => {
  assert.deepEqual(
    filterRows(BANK, { ...NO_FILTER, query: "bd" }).rows.map((r) => r.index),
    [1, 2],
  );
});

test("the omnibox matches a machine and a tag as well as a name", () => {
  // "matching on any field" — a search that only looked at names would send somebody back to
  // reading the table by eye for exactly the questions the table was built to answer.
  assert.deepEqual(filterRows(BANK, { ...NO_FILTER, query: "wavetone" }).rows.map((r) => r.index), [5]);
  assert.deepEqual(filterRows(BANK, { ...NO_FILTER, query: "hi-hat" }).rows.map((r) => r.index), [3]);
});

test("free and saved are searchable words, because that is how somebody would ask", () => {
  assert.deepEqual(filterRows(BANK, { ...NO_FILTER, query: "free" }).rows.map((r) => r.index), [6]);
  assert.equal(filterRows(BANK, { ...NO_FILTER, query: "saved" }).rows.length, 5);
});

test("several words all have to match", () => {
  // Two terms narrow. If they were OR, typing more would return more, which is not what a search
  // box does anywhere else.
  assert.deepEqual(
    filterRows(BANK, { ...NO_FILTER, query: "bd soft" }).rows.map((r) => r.index),
    [2],
  );
});

test("tags compound — two selected means both, not either", () => {
  // The user's word was "cummulative". Every click must narrow.
  assert.deepEqual(
    filterRows(BANK, { ...NO_FILTER, tags: ["KICK"] }).rows.map((r) => r.index),
    [1, 2],
  );
  assert.deepEqual(
    filterRows(BANK, { ...NO_FILTER, tags: ["KICK", "SOFT"] }).rows.map((r) => r.index),
    [2],
  );
  assert.deepEqual(filterRows(BANK, { ...NO_FILTER, tags: ["KICK", "PAD"] }).rows, []);
});

test("a row whose tags are unread is counted, not guessed at", () => {
  // The distinction this module exists for. Reading a bank's bodies takes seconds, and during them
  // a tag filter is being asked about rows nobody has read. Hiding them makes "nothing matches" a
  // lie; showing them makes a non-match look like a match.
  const partly = [...BANK, row({ index: 7, name: "UNREAD" })];

  const { rows, unknown } = filterRows(partly, { ...NO_FILTER, tags: ["KICK"] });
  assert.deepEqual(rows.map((r) => r.index), [1, 2]);
  assert.equal(unknown, 1, "the unread row is neither in nor out");
});

test("unknown counts only rows the other filters kept", () => {
  // Otherwise the number says "there is more to find here" while counting rows nobody asked for.
  const partly = [...BANK, row({ index: 7, name: "UNREAD" })];
  const { unknown } = filterRows(partly, { ...NO_FILTER, query: "bd", tags: ["KICK"] });
  assert.equal(unknown, 0, "UNREAD does not match the query, so it is not an unknown");
});

test("read-and-untagged is not the same as unread", () => {
  const tagged = [...BANK, row({ index: 7, name: "PLAIN", tags: [] })];
  const { rows, unknown } = filterRows(tagged, { ...NO_FILTER, tags: ["KICK"] });
  assert.deepEqual(rows.map((r) => r.index), [1, 2]);
  assert.equal(unknown, 0, "an empty tag list is an answer; undefined is the absence of one");
});

test("occupiedOnly hides free slots", () => {
  assert.equal(filterRows(BANK, { ...NO_FILTER, occupiedOnly: true }).rows.length, 5);
});

test("toggling a tag adds it, then removes it", () => {
  const once = toggleTag([], "KICK");
  assert.deepEqual(once, ["KICK"]);
  assert.deepEqual(toggleTag(once, "SOFT"), ["KICK", "SOFT"]);
  assert.deepEqual(toggleTag(once, "KICK"), []);
});

test("tag counts are what clicking would actually give you", () => {
  // Counted against the rows surviving everything else. A count over the whole bank would promise
  // 2 and deliver 1 the moment a query was also set.
  const all = tagCounts(BANK, NO_FILTER);
  assert.equal(all.find((t) => t.tag === "KICK")?.count, 2);

  const narrowed = tagCounts(BANK, { ...NO_FILTER, query: "dusty" });
  assert.equal(narrowed.find((t) => t.tag === "KICK")?.count, 1);
});

test("tags nothing carries are not offered", () => {
  // The vocabulary is 32 and a bank uses a handful. Listing all of them buries the live ones.
  const offered = tagCounts(BANK, NO_FILTER).map((t) => t.tag);
  assert.ok(!offered.includes("CYMBAL" as TagName));
  assert.ok(offered.includes("KICK" as TagName));
});
