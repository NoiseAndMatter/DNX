/**
 * The line somebody types to describe a pool, and what it has to survive.
 *
 * The case that drove it is the full-pool test: 78 distinct tables reaching 128 entries, with
 * three chosen ones at the top where a wrap to Prim. would show. `0-77, 0-46, 20, 4, 46` is that
 * list, and it can be counted by eye, which a button labelled *fill the pool* cannot.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffEntries,
  parseEntryList,
  summariseEntryList,
} from "@noiseandmatter/dnx-core/waverider/entrylist.js";
import { POOL_ENTRIES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

test("the full-pool list parses to exactly what the test needs", () => {
  const entries = parseEntryList("0-77, 0-46, 20, 4, 46");

  assert.equal(entries.length, POOL_ENTRIES);
  assert.equal(entries.filter((e) => e !== undefined).length, 128, "no empty entries");

  // 78 distinct tables, then repeats, then the three that have to be distinguishable by ear.
  assert.equal(entries[0], 0);
  assert.equal(entries[77], 77);
  assert.equal(entries[78], 0, "the repeats start over");
  assert.equal(entries[125], 20, "17 HS Saw");
  assert.equal(entries[126], 4, "01 Basic Sine2Saw");
  assert.equal(entries[127], 46, "43 Quant Noise");

  const summary = summariseEntryList(entries);
  assert.equal(summary.used, 128);
  assert.equal(summary.distinct, 78);
  assert.ok(summary.repeated.includes(20));
});

test("a short list is padded and a long one is refused", () => {
  const short = parseEntryList("3 9");
  assert.equal(short.length, POOL_ENTRIES);
  assert.deepEqual(short.slice(0, 3), [3, 9, undefined]);

  // Refused rather than cut: a list silently truncated is a pool whose last tables are missing
  // for no visible reason.
  assert.throws(
    () => parseEntryList(`0-${POOL_ENTRIES}`),
    (error: unknown) => error instanceof WaveriderError && /refused rather than cut/i.test(error.message),
  );
});

test("the three things the grammar has", () => {
  assert.deepEqual(parseEntryList("5").slice(0, 2), [5, undefined]);
  assert.deepEqual(parseEntryList("3-6").slice(0, 5), [3, 4, 5, 6, undefined]);
  assert.deepEqual(parseEntryList("6-3").slice(0, 5), [6, 5, 4, 3, undefined], "descending too");
  assert.deepEqual(parseEntryList(". . 7").slice(0, 4), [undefined, undefined, 7, undefined]);
  assert.deepEqual(parseEntryList("1,2 , 3").slice(0, 4), [1, 2, 3, undefined], "commas or spaces");
});

test("a token that is not one of those three is named in the error", () => {
  assert.throws(
    () => parseEntryList("3, banana, 5"),
    (error: unknown) => error instanceof WaveriderError && /"banana"/.test(error.message),
  );
  assert.throws(() => parseEntryList("256"), WaveriderError);
  assert.throws(() => parseEntryList("250-260"), WaveriderError);
});

test("duplicates pass, because the instrument's rule is not the codec's", () => {
  // The instrument skips a table already in the pool. This does not: a record naming a slot twice
  // is legal, and the full-pool test needs fifty repeats. The pane enforces the instrument's rule.
  const entries = parseEntryList("7 7 7");
  assert.deepEqual(entries.slice(0, 3), [7, 7, 7]);
  assert.deepEqual(summariseEntryList(entries).repeated, [7]);
});

test("a conflict names every entry that moved, not that something did", () => {
  // ADD TO POOL writes every ticked table in one generation step, so a refused write can cover
  // six additions. "The pool changed" leaves somebody guessing what overwrite would discard.
  const before = parseEntryList("3 . 9");
  const after = parseEntryList("3 5 9 11");

  assert.deepEqual(diffEntries(before, after), [
    { index: 1, before: undefined, after: 5 },
    { index: 3, before: undefined, after: 11 },
  ]);
  assert.deepEqual(diffEntries(before, before), [], "no change is an empty list, not a null");
});
