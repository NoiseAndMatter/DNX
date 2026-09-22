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
  tagOffers,
  toggleTag,
} from "../web/src/library/filter.js";
import { type TagName } from "@noiseandmatter/dnx-core/project/tags.js";

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

test("a tag's count is what clicking it would actually give you", () => {
  // Counted against the rows surviving everything else. A count over the whole bank would promise
  // 2 and deliver 1 the moment a query was also set.
  const all = tagOffers(BANK, NO_FILTER).offers;
  assert.equal(all.find((t) => t.tag === "KICK")?.count, 2);

  const narrowed = tagOffers(BANK, { ...NO_FILTER, query: "dusty" }).offers;
  assert.equal(narrowed.find((t) => t.tag === "KICK")?.count, 1);
});

test("tags nothing carries are not offered", () => {
  // The vocabulary is 32 and a bank uses a handful. Listing all of them buries the live ones.
  const offered = tagOffers(BANK, NO_FILTER).offers.map((t) => t.tag);
  assert.ok(!offered.includes("CYMBAL" as TagName));
  assert.ok(offered.includes("KICK" as TagName));
});

test("with nothing selected every offered tag is reachable", () => {
  // Nothing to compound with yet, so every tag in the bank leads somewhere and none is dimmed.
  const { offers, unread } = tagOffers(BANK, NO_FILTER);
  assert.equal(unread, 0);
  assert.ok(offers.length > 0);
  assert.deepEqual(offers.filter((o) => !o.available), []);
  assert.deepEqual(offers.filter((o) => o.selected), []);
});

test("one tag chosen dims the tags that lead nowhere, and keeps them", () => {
  // The user's request: "picking a tag narrows the list, and the tag cloud then shows the tags
  // still reachable". KICK leaves BD 1 BR and BD DUSTY, so HARD and SOFT still lead somewhere and
  // PAD does not. PAD stays in the cloud, dimmed: it is still part of the map of this bank.
  const { offers } = tagOffers(BANK, { ...NO_FILTER, tags: ["KICK"] });
  const by = (tag: string) => offers.find((o) => o.tag === tag);

  assert.equal(by("KICK")?.selected, true);
  assert.equal(offers[0]?.tag, "KICK", "the chosen tag comes first, where it was pressed");

  assert.equal(by("SOFT")?.available, true);
  assert.equal(by("SOFT")?.count, 1, "KICK and SOFT is BD DUSTY, and nothing else");
  assert.equal(by("HARD")?.count, 1);

  assert.equal(by("PAD")?.available, false, "no kick is also a pad");
  assert.equal(by("PAD")?.count, 0);
  assert.ok(by("PAD"), "and it is still offered, dimmed rather than taken away");
});

test("two tags compound, and the counts follow", () => {
  // Every click narrows, so the third tag is counted against what the first two left.
  const { offers } = tagOffers(BANK, { ...NO_FILTER, tags: ["KICK", "SOFT"] });
  const by = (tag: string) => offers.find((o) => o.tag === tag);

  assert.deepEqual(offers.slice(0, 2).map((o) => o.tag), ["KICK", "SOFT"], "chosen, in order");
  assert.equal(by("KICK")?.count, 1, "a chosen tag's number is the result it is part of");
  assert.equal(by("SOFT")?.count, 1);
  assert.equal(by("HARD")?.available, false, "BD DUSTY is not hard, so there is nowhere to go");
});

test("a chosen tag is never unclickable, even when it has narrowed to nothing", () => {
  // A filter you cannot undo is a trap. KICK and PAD together match nothing, and both chips must
  // still respond or the page is stuck showing an empty table.
  const { offers } = tagOffers(BANK, { ...NO_FILTER, tags: ["KICK", "PAD"] });
  assert.deepEqual(filterRows(BANK, { ...NO_FILTER, tags: ["KICK", "PAD"] }).rows, []);

  for (const tag of ["KICK", "PAD"]) {
    const chip = offers.find((o) => o.tag === tag);
    assert.equal(chip?.selected, true, `${tag} is drawn pressed`);
    assert.equal(chip?.available, true, `${tag} can still be dropped`);
    assert.equal(chip?.count, 0, "and it is honest about leaving nothing");
  }
});

test("nothing is dimmed while a row is unread, because unread is not absent", () => {
  // The hazard `filterRows` exists for, one level up. A tag can look unreachable purely because
  // the slots carrying it have not been read, and dimming on that is a lie the reads then quietly
  // correct. So no chip is disabled until the bank's tag read has finished.
  const partly = [...BANK, row({ index: 7, name: "UNREAD" })];

  const { offers, unread } = tagOffers(partly, { ...NO_FILTER, tags: ["KICK"] });
  assert.equal(unread, 1, "one occupied row nobody has read");
  assert.deepEqual(offers.filter((o) => !o.available), [], "so nothing is ruled out yet");
  assert.equal(offers.find((o) => o.tag === "PAD")?.count, 0, "the count is still an undercount");

  // The page marks that with a `+`. Once the read lands, the same tag is dimmed for real.
  const read = [...BANK, row({ index: 7, name: "UNREAD", tags: ["HI-HAT"] })];
  assert.equal(tagOffers(read, { ...NO_FILTER, tags: ["KICK"] }).unread, 0);
  assert.equal(
    tagOffers(read, { ...NO_FILTER, tags: ["KICK"] }).offers.find((o) => o.tag === "PAD")?.available,
    false,
  );
});

test("an unread row is only unknown to a question somebody asked", () => {
  // Rows the omnibox already excluded cannot make the cloud provisional: the `+` would never come
  // off while one unread slot in the bank failed to match a search.
  const partly = [...BANK, row({ index: 7, name: "UNREAD" })];
  assert.equal(tagOffers(partly, { ...NO_FILTER, query: "bd" }).unread, 0);
});

test("an empty bank offers nothing and says nothing is unread", () => {
  const empty: LibraryRow[] = [
    row({ index: 1, occupied: false, writable: true }),
    row({ index: 2, occupied: false, writable: true }),
  ];
  assert.deepEqual(tagOffers(empty, NO_FILTER), { offers: [], unread: 0 });
  assert.deepEqual(tagOffers([], NO_FILTER), { offers: [], unread: 0 });

  // A free slot is not an unread one: it has nothing in it to read, so it can never make the
  // cloud provisional. `filterRows` draws the same line for the table.
  assert.equal(tagOffers(empty, { ...NO_FILTER, tags: ["KICK"] }).unread, 0);
});
