/**
 * The Wavetables mode's two standing promises, checked against its source.
 *
 * Both are things a typecheck cannot see. The page's own id test matches `$("literal")`, and this
 * module reaches most of its elements through lists of names — so a typo in one of those lists
 * typechecks, renders, and throws the moment somebody presses the tab.
 *
 * The second promise is that this mode reads and never writes, which is what let it ship before the
 * confirmation and backup path for ADD TO POOL and DELETE existed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, "../web/src/library/wavetables.ts"), "utf8");
const PAGE = readFileSync(resolve(HERE, "../web/library.html"), "utf8");

/** The element ids in a `const NAME = [...] as const` list. */
function idList(name: string): string[] {
  const block = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`).exec(SOURCE);
  assert.ok(block, `${name} is no longer an array of id literals — rewrite this test, do not delete it`);
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

test("every id the mode toggles by name exists on the page", () => {
  const declared = new Set([...PAGE.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));

  const lists = ["SOUNDS_ONLY", "OURS", "TITLES"];
  const missing: string[] = [];
  for (const list of lists) {
    const ids = idList(list);
    assert.ok(ids.length > 0, `${list} is empty`);
    for (const id of ids) if (!declared.has(id)) missing.push(`${id} (in ${list})`);
  }

  assert.deepEqual(missing, [], "the Wavetables mode hides or retitles ids its page does not define");
});

test("the mode owns its own elements and hides nobody else's", () => {
  // The two lists must not overlap: an id in both would be hidden on the way in as Sounds mode's,
  // then unhidden as this mode's, and the pane would show an empty grid under a heading about a
  // pool nobody has read.
  const both = idList("SOUNDS_ONLY").filter((id) => idList("OURS").includes(id));
  assert.deepEqual(both, [], "these ids are claimed by both modes");
});

test("nothing in this mode writes to the instrument", () => {
  /*
   * The mode shipped read-only on purpose: ADD TO POOL, CLEAR SLOT, DELETE and Rename each need
   * the confirmation and backup path every write in DNX goes through, and the reading is worth
   * having before them — it is what can say *this slot plays Prim. because its table was deleted*.
   *
   * When the write half lands this test changes to require the permit, rather than being deleted.
   */
  const writers = [
    "writeStoredFile",
    "safeWriteFile",
    "writePool",
    "renameSlot",
    "writeTableToSlot",
    "deleteRequest",
  ];
  const found = writers.filter((name) => SOURCE.includes(name));
  assert.deepEqual(found, [], "the Wavetables mode is read-only; these reach a write path");
});
