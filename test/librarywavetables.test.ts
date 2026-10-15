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
const DELETE = readFileSync(resolve(HERE, "../web/src/library/tabledelete.ts"), "utf8");
const PAGE = readFileSync(resolve(HERE, "../web/library.html"), "utf8");
const MAIN = readFileSync(resolve(HERE, "../web/src/library/main.ts"), "utf8");
const ERASE = readFileSync(resolve(HERE, "../web/src/wavetableerase.ts"), "utf8");

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
  // The sequence is core's, shared with the probe's folder batch; the staging module only words it.
  const BATCH = readFileSync(resolve(HERE, "../packages/core/src/device/waveriderbatch.ts"), "utf8");
  assert.match(STAGING, /writeTablesToSlots\(/, "the staging module writes through the shared batch");
  assert.match(STAGING, /gate: requireWriteEnabled/, "and hands it the WRITE switch");
  assert.match(STAGING, /askConfirm\(/, "the run must ask once before writing");

  assert.match(BATCH, /gate: host\.gate/, "each write must pass the gate itself");
  assert.match(BATCH, /\(\): Promise<boolean> => Promise\.resolve\(true\)/,
    "the per-write confirm should answer yes after the single question");
  for (const source of [STAGING, BATCH]) {
    assert.ok(
      !/export\s+(const|function)\s+\w*([Cc]onfirm|[Aa]sked)/.test(source),
      "a confirm hook that answers yes without asking must stay local",
    );
  }

  // And the listing is read at the moment of asking, not taken from what the pane already has.
  assert.match(BATCH, /readStoreListing/, "the empty-slot check must use a fresh listing");
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

test("the delete is gated, asks once, and copies before it asks", () => {
  /*
   * **The mode's only destructive control.** Everything else it does can be undone by writing
   * something else; this cannot be undone on the instrument at all, so the copy is the whole
   * safety net — and it is taken *before* the question. Being told after agreeing that the copy
   * failed is not consent, which is the rule `safeWriteFile` follows for an overwrite and the
   * reason this is asserted rather than left to whoever edits the flow next.
   */
  assert.match(DELETE, /deleteTableSlot/, "the delete module should be the one that deletes");
  assert.match(DELETE, /gate: requireWriteEnabled/, "the delete must pass the gate itself");
  assert.match(DELETE, /askConfirm\(/, "it must ask before deleting");
  assert.match(DELETE, /onBackup: downloadBackup\(/, "the table must be saved before it goes");

  assert.match(
    DELETE,
    /confirm: \(\) => Promise\.resolve\(true\)/,
    "the per-delete confirm should answer yes after the single question",
  );
  assert.ok(
    !/export\s+(const|function)\s+\w*[Cc]onfirm/.test(DELETE),
    "a confirm hook that answers yes without asking must stay local to this module",
  );
});

test("the delete says what it has not checked, rather than implying it checked everything", () => {
  /*
   * The page has read **one** project's pool. It can name the slots in that one exactly, and a
   * sentence saying "no pool slot names this table" would be read as "nothing points at this" —
   * a claim about 128 projects made on evidence from one.
   *
   * And the case the firmware session raised on 2026-10-13: a pool entry names a store slot, so a
   * slot refilled later makes every entry still pointing there play the new table, silently, in
   * every project. The question has to say that before the delete, not after.
   */
  assert.match(DELETE, /has not looked/, "it must admit which pools it did not read");
  assert.match(DELETE, /plays that new table instead/, "it must warn about the slot being refilled");
});

test("removing from a pool warns that the slot goes quiet and becomes the next hole", () => {
  /*
   * `poolview.ts` argues at length that DNX must not clear an entry on somebody's behalf. This is
   * a person asking, which is a different thing — but the consequence is identical and is not
   * visible from a button called Remove from pool: the sounds set to that number stop playing
   * anything, nothing renumbers, and the empty slot is where the next add lands.
   */
  assert.match(POOLWRITE, /clearInPool/, "the removal should use the shared arithmetic");
  assert.match(POOLWRITE, /play the built-in Prim/, "it must say what the sounds will do");
  assert.match(POOLWRITE, /Nothing renumbers/, "it must say the later slots do not move");
  assert.match(POOLWRITE, /the next table added with no slot chosen lands here/,
    "it must say the empty slot is the next hole");
});

test("both pool edits go through one write, not two copies of it", () => {
  /*
   * Adding and removing differ only in the entries and the sentence. Two copies of the write would
   * have to be kept in step through the gate, the backup, the cancelled case and the three ways a
   * write can fail to land, and the half nobody exercised is the one that would drift.
   */
  const writes = [...POOLWRITE.matchAll(/await writePool\(/g)].length;
  assert.equal(writes, 1, `writePool is called ${writes} times; both edits should share one send`);
});

test("the store takes the house gesture: multi-select and drag onto a pool slot", () => {
  /*
   * **The rule this was breaking.** `one-visual-language-across-tools`: never type a slot name,
   * select and drag on a grid as the manager does. The pane shipped with one selected row and a
   * button, which is a second vocabulary for moving a thing from one collection to another — the
   * owner named it by asking for "multi-select and drag and drop, like we do transferring
   * patterns between projects".
   *
   * Asserted against the source because the gesture needs a pointer and an instrument to try, and
   * the one thing a reader cannot see from the diff is whether the drag reaches a *shared*
   * controller or a second private one.
   */
  assert.match(SOURCE, /new GridDrag\(/, "the drag must use the shared controller");
  assert.match(SOURCE, /drag\.bind\(tr, STORE_GRID/, "store rows must be drag sources");
  assert.match(SOURCE, /drag: \{ controller: drag, grid: POOL_GRID \}/,
    "pool cells must be drop targets");

  // Shift and ctrl, which is what makes it a selection rather than a highlight.
  assert.match(SOURCE, /event\.shiftKey/, "shift-click must take a run");
  assert.match(SOURCE, /event\.ctrlKey \|\| event\.metaKey/, "ctrl or cmd must toggle one");
});

test("a drop is a copy, and only ever store to pool", () => {
  /*
   * `move` would be the page claiming something the instrument does not do: the table stays in
   * the store and every other project keeps it. And a drop that is not store-to-pool returns no
   * hint, which leaves the browser's own refusal cursor rather than a target nobody can use.
   */
  assert.match(SOURCE, /action: "copy"/, "adding to a pool copies; the store keeps the table");
  assert.match(
    SOURCE,
    /from\.grid !== STORE_GRID \|\| grid !== POOL_GRID\) return undefined/,
    "any other combination of grids must be refused",
  );
});

test("the button and the drop place tables the same way", () => {
  /*
   * Two gestures, one meaning. If the button had kept its own placement logic, a drop of three on
   * slot 10 and a press with three selected could land differently — and a wrong pool index looks
   * right on screen and plays the wrong table on the instrument.
   */
  assert.match(POOLWRITE, /async function addAt\(/, "there should be one placement entry point");
  const direct = [...POOLWRITE.matchAll(/placeInPool\(/g)].length;
  assert.equal(direct, 1, `placeInPool is called ${direct} times; both gestures should share one`);
  assert.match(POOLWRITE, /await addAt\(chosen, host\.pickedIndex\(\)\)/, "the button must go through it too");

  /*
   * **The half this test used to miss.** It checked that both gestures call `addAt` and that
   * `placeInPool` appears once, and both were true while the two disagreed about *which* tables
   * and *which* slots — the drag filtered out empty store slots and the button did not, and the
   * button laid a run over occupied slots where it used to fill free ones. Comparing call sites
   * is not comparing answers.
   *
   * So the decision is `planAdd`, which is pure and has its own tests, and the only thing left
   * to assert here is that nothing works it out a second time.
   */
  assert.match(POOLWRITE, /planAdd\(storeSlots, occupiedSlots\(reading\), firstIndex\)/,
    "the placement decision must come from planAdd, not be rebuilt here");
  assert.ok(
    !/storeSlots\.map\(\(storeSlot, /.test(POOLWRITE),
    "poolwrite must not build placement requests itself",
  );
  assert.ok(
    !/\.filter\(\s*\(slot\) => reading/.test(POOLWRITE),
    "the occupied filter belongs in planAdd, not beside the caller",
  );
});

test("another instrument is asked, rather than inheriting the last one's answer", () => {
  /*
   * **The bug this is here for**, found on 2026-10-14 against the emulator: with the mode open on
   * a Waverider build, connecting a stock Digitone II left the Waverider's pool and store drawn on
   * screen, and left `support` saying the erase route was there — so the settings sheet went on
   * offering *Erase the wavetable region* for an instrument that has no wavetable region. The page
   * already clears the preset bank cache for exactly this reason, one pane over.
   *
   * Asserted against the source because the mode is DOM-bound and this is a wiring promise: that
   * `connect` calls it, and that what it drops includes the gate answer.
   */
  assert.match(SOURCE, /async function reconnected\(\): Promise<void> \{/,
    "the mode must offer a way to be told the instrument changed");
  const body = /async function reconnected\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(SOURCE);
  assert.ok(body, "reconnected is no longer one function — rewrite this test, do not delete it");
  for (const dropped of ["support = undefined", "reading = undefined", "tables.clear()"]) {
    assert.ok(body[1]!.includes(dropped),
      `reconnected must drop ${dropped}: it describes the instrument that has gone`);
  }

  assert.match(MAIN, /await wavetables\.reconnected\(\);/,
    "connect must tell the mode that another instrument answered");
  const connectBody = /async function connect\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(MAIN);
  assert.ok(connectBody, "connect is no longer one function — rewrite this test, do not delete it");
  assert.ok(connectBody[1]!.includes("await wavetables.reconnected();"),
    "the call belongs in connect, where the new instrument is adopted");

  /*
   * And the second half of the same bug: the erase control reads the gate's whole answer, so
   * *asked and this instrument has no store* cannot be reported as *nobody has asked yet*, which
   * sends somebody to a tab that has already answered.
   */
  assert.match(ERASE, /provideWaveriderSupport\(find: \(\) => WaveriderSupport \| undefined\)/,
    "the erase control must see the whole gate answer, not only its features");
  assert.match(ERASE, /support\.state === "unsupported"/,
    "an instrument with no wavetable store must be told so");
  // And when no tool has asked, it asks for itself rather than sending somebody to another tab.
  assert.match(ERASE, /askWaveriderSupport\(/,
    "the erase must be able to ask the gate itself: it is offered on every page now");
});

test("one conversation at a time: every device path takes the pane and gives it back", () => {
  /*
   * **The bug this is here for**, found at the instrument on 2026-10-14: clicking anything while
   * a read was in flight stopped the read. The +Drive takes one conversation at a time, so each
   * path that starts one locks the pane for its duration.
   *
   * The release has to come **before** `reread`, because that is the mode's own refresh and it
   * takes the lock itself — a module still holding it would make the re-read refuse, and the pane
   * would sit there describing an instrument it had just changed.
   */
  assert.match(SOURCE, /function lock\(on: boolean\): void \{/, "the mode owns the lock");
  const lockBody = /function lock\(on: boolean\): void \{([\s\S]*?)\n  \}/.exec(SOURCE);
  assert.ok(lockBody, "lock is no longer one function — rewrite this test, do not delete it");
  assert.ok(lockBody[1]!.includes("busy = on"), "the flag the handlers read is the lock's own");
  assert.ok(lockBody[1]!.includes('classList.toggle("locked", on)'),
    "the grids must stop taking clicks: their rows are what start a read");

  // The mode's two own reads.
  for (const [name, body] of [
    ["refresh", /async function refresh\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(SOURCE)],
    ["the preview read", /previewBusy = true;([\s\S]*?)previewBusy = false;/.exec(SOURCE)],
  ] as const) {
    assert.ok(body, `${name} is no longer one block — rewrite this test, do not delete it`);
    assert.ok(body[1]!.includes("lock(true)"), `${name} must take the pane`);
  }

  for (const [name, source] of [
    ["the staged write", STAGING],
    ["the pool write", POOLWRITE],
    ["the delete", DELETE],
  ] as const) {
    assert.match(source, /host\.lock\(true\);/, `${name} must take the pane while it writes`);
    assert.match(source, /host\.lock\(false\);/, `${name} must give it back`);
    const release = source.indexOf("host.lock(false);");
    const reread = source.indexOf("host.reread()");
    assert.ok(release < reread,
      `${name} must release the lock before the re-read, which takes it in turn`);
  }
});

test("a drop says where it would land, by the rule the drop itself runs", () => {
  /*
   * The owner, at the instrument on 2026-10-14: there was no feedback about where a dragged file
   * would go. The marks have to come from `placeFrom` — the placement the drop runs — or the
   * highlight becomes a second rule that drifts from the first and lights up the wrong slots.
   */
  const bind = /function bind\(\): void \{([\s\S]*?)\n  \}/.exec(STAGING);
  assert.ok(bind, "bind is no longer one function — rewrite this test, do not delete it");
  const body = bind[1]!;

  assert.ok(body.includes("placeFrom("), "the marks must come from the placement rule, not a copy");
  for (const mark of ["dropland", "dropskip", "dropfull"]) {
    assert.ok(body.includes(mark), `a drop must be able to say ${mark}`);
  }
  // `files` is empty until the drop; `items` is not, and its length is the count to place.
  assert.ok(body.includes("dataTransfer?.items"),
    "a drag in flight hides its files, so the count comes from the item list");
  for (const clearing of ["dragleave", "drop"]) {
    assert.ok(body.includes(clearing), `the marks must be cleared on ${clearing}`);
  }
});

test("the copying is asked for before it starts", () => {
  /*
   * **The owner, 2026-10-14**: pressing *Erase* began by backing up without a word, and somebody
   * who sat through minutes of copying only to cancel the erase had been asked nothing at all.
   * The button keeps its name — it is the command — and the press asks first whether to save the
   * copies; the erase is asked again afterwards, which is the question that sends something.
   */

  const first = ERASE.indexOf("Save the copies");
  const second = ERASE.indexOf("Erase the region");
  assert.ok(first > 0, "the first question must offer to save the copies");
  assert.ok(second > first, "the erase question comes after the copies are agreed to");

  // Cancelling the first leaves everything where it was, which is the whole point of asking.
  assert.match(ERASE, /Nothing was copied and nothing was sent\./,
    "cancelling the copies must say that nothing happened");

  // The count is what makes the question answerable, so the listing is read before asking.
  const counting = ERASE.indexOf("readStoreListing(");
  assert.ok(counting > 0 && counting < first,
    "the tables are counted before the question that names how many there are");
});

test("one control chooses what to work with, and one list chooses the project", () => {
  /*
   * **The owner, 2026-10-14**: Sounds / Wavetables tabs above the panes and a Presets / Kits list in
   * the toolbar were two answers to one question, and a *Pool of* dropdown in the wavetable pane
   * beside the toolbar's project list put the same names on screen twice. Both are one control now.
   */
  for (const gone of ['id="libraryMode"', 'id="modeSounds"', 'id="modeWavetables"', 'id="wavepoolProject"']) {
    assert.ok(!PAGE.includes(gone), `${gone} is gone from the page: its job is the toolbar's now`);
  }
  const kinds = /<select id="kind"[^>]*>([\s\S]*?)<\/select>/.exec(PAGE);
  assert.ok(kinds, "the toolbar's kind list is no longer a select — rewrite this test, do not delete it");
  for (const option of ['value="preset"', 'value="kit"', 'value="wavetable"']) {
    assert.ok(kinds[1]!.includes(option), `the kind list must offer ${option}`);
  }

  // The dropdown is the mode switch, and every change of its value goes through one function, so
  // the mode cannot disagree with what the dropdown says.
  assert.match(MAIN, /\$\("kind"\)\.addEventListener\("change", \(\) => \{\s*applyKind\(\);/,
    "a change of the kind list must decide the mode");
  assert.match(MAIN, /function applyKind\(\): void \{/, "the mode follows the dropdown in one place");

  // The mode must not hide the control that is now the only way out of it.
  assert.ok(!idList("SOUNDS_ONLY").includes("kind"),
    "Wavetables must not hide the dropdown: without the tabs it is how somebody leaves");

  // One list, filled one way. Two fillers had already drifted: `24. PRESETS` against `024 PRESETS`.
  assert.match(MAIN, /renderProjectList\(/, "Presets and Kits fill the list with the shared renderer");
  assert.match(SOURCE, /renderProjectList\(/, "and so does Wavetables");
  assert.match(SOURCE, /\$<HTMLSelectElement>\("driveProjects"\)/,
    "Wavetables reads its project from the toolbar's list, not a list of its own");

  // The working project has a pool and no file: Open refuses it rather than failing on it.
  assert.match(MAIN, /index === WORKING_PROJECT/, "Open must refuse the working project");
});

test("a resample names where it started, not only where it ended", () => {
  /*
   * The owner, 2026-10-14, looking at a 15 x 2048 file staged at 64 waves: *resampled to 64 x 2048*
   * hid half of the change. The line names the shape the file already was — kept from the proposal
   * when its sample count divides exactly — or its sample count when it divides into nothing.
   */
  assert.match(STAGING, /source\?: Geometry;/, "the staged entry keeps the shape the file already was");
  assert.match(STAGING, /proposal\.exact \? \{ source: proposal\.geometry \}/,
    "and only when the proposal divided exactly: anything else was never that shape");
  // "resampled" or "blended", then both ends.
  assert.match(STAGING, /"resampled"\} from \$\{from\} to /, "the line says both ends");
});

test("the pool starts on the working project, and a saved one says it is not what plays", () => {
  /*
   * Option B, the owner's choice on 2026-10-14. The list started on the project open in Presets, so
   * with project 24 open an edit went to 24's saved record while the instrument went on playing
   * the working one — a write that looked like it did nothing. The firmware refills what plays only
   * from the working record, so that is where a first edit has to land.
   */
  assert.match(SOURCE, /renderProjectList\(select, listed, WORKING_PROJECT\)/,
    "entering Wavetables must start on the working project, whatever is open in Presets");
  assert.ok(!/host\.openSlot\(/.test(SOURCE),
    "the open project must no longer choose the pool: that is the trap option B removes");
  assert.match(SOURCE, /summary\.projectSlot === WORKING_PROJECT\s*\?\s*""/,
    "a saved project's pool must say when it is not the one playing");
  assert.match(SOURCE, /Changes play after you next load it on the/, "in words a musician acts on");
});

test("blend is a toggle that changes how the table is built, and says when it did", () => {
  /*
   * The owner, 2026-10-14: raising the wave count re-cuts the file, which sounded interesting and
   * stays the default; a toggle named blend keeps the file's own waves and mixes new ones between
   * them instead. Asserted here: the control exists, both the panel and the write build through one
   * choice — so what plays in the preview is what gets written — and the line names the method.
   */
  assert.match(PAGE, /id="wavimportBlend" type="checkbox"/, "the toggle is on the page");
  assert.match(PAGE, /<label class="lbl" for="wavimportBlend">blend<\/label>/, "and is called blend");
  assert.match(STAGING, /blend: false,/, "off until somebody turns it on: the re-cut is the default");
  assert.equal((STAGING.match(/choiceFor\(entry\)/g) ?? []).length, 2,
    "the panel and the write must build the same table, from one choice");
  assert.match(STAGING, /entry\.blend && entry\.source \? \{ blendFrom: entry\.source \}/,
    "the blend applies only when the file has whole waves to keep");
  assert.match(STAGING, /"blended" : "resampled"/, "the line says blended rather than resampled");
});

test("an import that stops part-way says where, why, and how many went in", async () => {
  const { importOutcome } = await import("../web/src/library/importoutcome.js");
  const written = [{ slot: 50 }] as never[];
  const [message, kind] = importOutcome(
    { kind: "stopped", written, at: { slot: 51, name: "SECOND" } as never, problem: "no reply to 0x4054 within 10000ms" },
    3,
  );
  assert.equal(kind, "error");
  assert.equal(message, "Stopped at slot 51 (SECOND): no reply to 0x4054 within 10000ms. 1 table written, 2 not sent.");
  const [gated] = importOutcome(
    { kind: "stopped", written: [], at: { slot: 2, name: "STOPA" } as never, problem: "WRITE is off. Nothing was sent." },
    2,
  );
  assert.equal(gated, "Stopped at slot 2 (STOPA): WRITE is off. Nothing was sent. 0 tables written, 2 not sent.");
  // A table that is in the store and failed only its read-back is written, not "not sent".
  const [landed] = importOutcome(
    {
      kind: "stopped", written, at: { slot: 51, name: "SECOND" } as never,
      problem: "the slot is in use but the read-back differs: byte 40", landed: { slot: 51 } as never,
    },
    3,
  );
  assert.equal(landed, "Stopped at slot 51 (SECOND): the slot is in use but the read-back differs: byte 40. 2 tables written, 1 not sent.");
  // And the import takes it off the staged list with the rest.
  assert.match(STAGING, /\.\.\.\(outcome\.landed \? \[outcome\.landed\] : \[\]\)/);
  // And the button reports a throw rather than dropping it.
  assert.match(STAGING, /writeAll\(\)\.catch\(/);
  assert.doesNotMatch(STAGING, /void writeAll\(\)/);
});
