/**
 * The Wavetables mode's two standing promises, checked against its source.
 *
 * Both are things a typecheck cannot see. The page's own id test matches `$("literal")`, and this
 * module reaches most of its elements through lists of names — so a typo in one of those lists
 * typechecks, renders, and throws the moment somebody presses the tab.
 *
 * The second promise has changed twice. The mode shipped read-only, which is what let it arrive
 * before the confirmation path existed; on 2026-10-13 it gained the staged wavetable import, and
 * then the pool write that places a stored table into a project's list. So the promise is now
 * **where** the writes live and what they pass through: the pane itself still reaches no write
 * path, and the two modules that do are gated per write and ask once. A test that only looked for
 * the old absence would now pass by finding nothing, because the names moved to neighbouring files.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, "../web/src/library/wavetables.ts"), "utf8");
const STAGING = readFileSync(resolve(HERE, "../web/src/library/importstage.ts"), "utf8");
const POOLWRITE = readFileSync(resolve(HERE, "../web/src/library/poolwrite.ts"), "utf8");
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
   * CLEAR SLOT, DELETE and Rename are still not built, and the two writes that do exist live in
   * `importstage.ts` and `poolwrite.ts` rather than in this file. Keeping the renderer itself clean
   * is what makes those entry points reviewable: a third write added straight into the drawing code
   * would not have to pass anything its neighbours pass.
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
  assert.deepEqual(
    found,
    [],
    "a write path reached straight from the pane; it belongs in importstage.ts or poolwrite.ts",
  );
});

test("the write control is enabled by the panel, not only by its own handler", () => {
  /*
   * **This test exists because the feature shipped unreachable and everything else passed.**
   *
   * `wavimportWrite` carries `disabled` in the markup. The only line clearing it sat inside
   * `writeAll`, which cannot run until the button is pressed, so the button could never be
   * pressed and the whole write path was dead. The suite was green: the other tests read the
   * source for the names they wanted and found them.
   *
   * The rule that catches it is that the **render** decides the control's state. A control whose
   * `disabled` is only ever restored at the end of its own run has nothing that can first turn it
   * on. This is the same shape as the "Save to +Drive" button that shipped hidden with nothing to
   * unhide it, so it is worth a standing check rather than a memory.
   */
  assert.match(
    PAGE,
    /id="wavimportWrite"[^>]*\sdisabled/,
    "if this control no longer ships disabled, this test is guarding nothing — rewrite it",
  );

  const start = STAGING.indexOf("function renderPanel(");
  assert.ok(start > 0, "renderPanel has been renamed; this check no longer guards anything");
  // The next function declared at the same indent ends it. These all sit inside `wireImport`.
  const rest = STAGING.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?function /);
  const body = end === -1 ? rest : rest.slice(0, end);

  assert.match(
    body,
    /wavimportWrite"\)\.disabled =/,
    "renderPanel must decide whether the write control can be pressed; otherwise nothing can " +
      "turn it on and the feature is unreachable",
  );
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

test("the pool write is gated per write, asks once, and keeps its yes to itself", () => {
  /*
   * The second write the mode gained, and the one that can change what a sound plays without
   * touching a single byte of audio: it rewrites a project's list of which stored tables it
   * reaches. The same three properties as the import, for the same reasons.
   */
  assert.match(POOLWRITE, /writePool/, "the pool module should be the one that writes a pool");
  assert.match(POOLWRITE, /gate: requireWriteEnabled/, "the write must pass the gate itself");
  assert.match(POOLWRITE, /askConfirm\(/, "it must ask before writing");
  assert.match(POOLWRITE, /onBackup: downloadBackup\(/, "the record being replaced must be saved");

  assert.match(
    POOLWRITE,
    /confirm: \(\) => Promise\.resolve\(true\)/,
    "the per-write confirm should answer yes after the single question",
  );
  assert.ok(
    !/export\s+(const|function)\s+\w*[Cc]onfirm/.test(POOLWRITE),
    "a confirm hook that answers yes without asking must stay local to this module",
  );
});

test("the pool write tells somebody when it is pinning a pool rather than adding to one", () => {
  /*
   * **The one sentence this feature cannot ship without.** A project with no list of its own plays
   * every stored table in store-slot order. Writing a list for it pins what it plays today and
   * stops new tables joining it — a change to how the project behaves, which nobody asked for in
   * words when they pressed *Add to pool*.
   *
   * Asserted on the source because the alternative is a browser and a second instrument: the
   * sentence is built inside the confirmation, and the only other way to see it is to have a
   * project with no pool record and press the button.
   */
  assert.match(
    POOLWRITE,
    /summary\.authored/,
    "the confirmation has to branch on whether anybody wrote this pool",
  );
  assert.match(
    POOLWRITE,
    /joins this project/,
    "it must say that a new table stops joining the project on its own",
  );
});

test("the pool write control is enabled by its render, not by its own handler", () => {
  // Same rule, same reason, as the staged-import button two tests up: a control whose only
  // enabling line sits inside the run it starts can never be pressed.
  assert.match(
    PAGE,
    /id="wavepoolAdd"[^>]*\sdisabled/,
    "if this control no longer ships disabled, this test is guarding nothing — rewrite it",
  );

  const start = POOLWRITE.indexOf("function redraw(");
  assert.ok(start > 0, "redraw has been renamed; this check no longer guards anything");
  const rest = POOLWRITE.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?function /);
  const body = end === -1 ? rest : rest.slice(0, end);

  assert.match(
    body,
    /button\.disabled =/,
    "redraw must decide whether the write control can be pressed",
  );
});
