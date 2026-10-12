/**
 * The Wavetables mode's two standing promises, checked against its source.
 *
 * Both are things a typecheck cannot see. The page's own id test matches `$("literal")`, and this
 * module reaches most of its elements through lists of names — so a typo in one of those lists
 * typechecks, renders, and throws the moment somebody presses the tab.
 *
 * The second promise has changed. The mode shipped read-only, which is what let it arrive before
 * the confirmation path existed; on 2026-10-13 it gained one write, the staged wavetable import. So
 * the promise is now **where** the write lives and what it passes through: the pane itself still
 * reaches no write path, and the module that does is gated per write and asks once. A test that
 * only looked for the old absence would now pass by finding nothing, because the names moved to a
 * neighbouring file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, "../web/src/library/wavetables.ts"), "utf8");
const STAGING = readFileSync(resolve(HERE, "../web/src/library/importstage.ts"), "utf8");
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

test("the pane itself still reaches no write path", () => {
  /*
   * ADD TO POOL, CLEAR SLOT, DELETE and Rename are still not built here, and the one write that
   * does exist lives in `importstage.ts` rather than in this file. Keeping the pane itself clean is
   * what makes that single entry point reviewable: a second write added straight into the renderer
   * would not have to pass anything this file's neighbour passes.
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
  assert.deepEqual(found, [], "a write path reached straight from the pane; it belongs in importstage.ts");
});

test("the one write the mode has is gated per write and asks once", () => {
  /*
   * **This is the test that replaced the read-only one, and it has to assert presence.** The names
   * it looks for moved out of `wavetables.ts` when staging was extracted, so the old absence check
   * started passing for the wrong reason — the file it read no longer contained the thing it was
   * written to forbid.
   *
   * Three properties, each of which has been got wrong somewhere before:
   *
   * - The gate is passed to **every** write, not checked once before the run. That is what makes
   *   the WRITE switch a stop button rather than a starting gun.
   * - The run asks once, naming every slot, which is the relaxation `batchtables.ts` argues for.
   * - The per-write confirm that answers yes is **not exported**, so nothing else can pick up a
   *   hook that says yes without asking.
   */
  assert.match(STAGING, /writeTableToSlot/, "the staging module should be the one that writes");
  assert.match(STAGING, /gate: requireWriteEnabled/, "each write must pass the gate itself");
  assert.match(STAGING, /askConfirm\(/, "the run must ask once before writing");

  const yes = /confirm: \(\) => Promise\.resolve\(true\)/;
  assert.match(STAGING, yes, "the per-write confirm should answer yes after the single question");
  assert.ok(
    !/export\s+(const|function)\s+\w*[Cc]onfirm/.test(STAGING),
    "a confirm hook that answers yes without asking must stay local to this module",
  );

  // And the listing is read at the moment of asking, not taken from what the pane already has.
  assert.match(STAGING, /readStoreListing/, "the empty-slot check must use a fresh listing");
});
