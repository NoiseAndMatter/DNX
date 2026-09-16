/**
 * Two library defects the first release test run found, held by reading the source.
 *
 * Both live in DOM code this suite does not run, so the properties are checked where they are
 * written: the table marks the selected row and has a style for it, and opening a project clears the
 * marks that described the previous one.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HELP_PAGES } from "../web/src/helppages.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

test("the library table marks the row Rename will act on", () => {
  // Reported by the owner: a preset could be selected with nothing on screen saying so.
  const table = read("web/src/library/librarytable.ts");
  assert.match(table, /tr\.classList\.add\("selected"\)/, "the selected row gets a class");
  assert.match(table, /aria-selected/, "and says so to assistive technology");

  const page = read("web/src/library/main.ts");
  assert.match(page, /selected: state\.selected\.index/, "the page passes its selection to the table");

  const css = read("web/dnx.css");
  assert.match(css, /\.libtable tbody tr\.selected/, "and the stylesheet draws it");
});

test("opening a project clears the previous project's kit marks", () => {
  // Found in the release run: History read 'Nothing done yet.' while the findings panel said a
  // pattern of the newly opened project had had a kit loaded.
  const page = read("web/src/library/main.ts");
  const start = page.indexOf("function adopt(");
  assert.ok(start > 0, "adopt has been renamed; this check no longer guards anything");
  const end = /\r?\n\}\r?\n/.exec(page.slice(start));
  assert.ok(end, "adopt has no closing brace at column 0");
  assert.match(page.slice(start, start + end.index), /applied\.clear\(\)/);
});

test("a preset dropped into the pool is named after the bytes that were read", () => {
  /*
   * **Found on a Digitone 1, 2026-09-15.** Rename `/soundbanks/H/3` to RELTEST H3D, drop it into a
   * free pool slot thirty seconds later, and the line read "RELTEST H3C -> slot 37" while the slot
   * itself held RELTEST H3D. The right preset went in; only the sentence and the undo entry were
   * wrong, because both named `bank.entries` — the listing taken when Browse ran, which a rename
   * leaves behind. `preview.name` and `plan.name` come out of the object that was just read.
   */
  const page = read("web/src/library/main.ts");
  const start = page.indexOf("async function addToPool(");
  assert.ok(start > 0, "addToPool has been renamed; this check no longer guards anything");
  const end = /\r?\n\}\r?\n/.exec(page.slice(start));
  assert.ok(end, "addToPool has no closing brace at column 0");
  const body = page.slice(start, start + end.index);

  assert.doesNotMatch(body, /bank\.entries/, "the pool add must not name a slot from the listing");
  assert.match(body, /tag\(`add \$\{preview\.name/, "the undo entry names what was read");
  assert.match(body, /\$\{plan\.name \|\| "preset"\} → slot/, "and so does the line after it");
});

test("a rename updates the listing behind the table, not only the row", () => {
  // The same stale listing reached the kit drop's fallback name, and anything else that names a
  // slot without reading it.
  const page = read("web/src/library/main.ts");
  const start = page.indexOf("if (result.committed && result.listedAs !== undefined)");
  assert.ok(start > 0, "the rename no longer updates the row in place");
  const block = page.slice(start, start + 600);
  assert.match(block, /state\.rows\.find/, "the table row still follows the rename");
  assert.match(block, /state\.bank\?\.entries\.find/, "and so does the listing behind it");
});

test("the refusal for a Digitone 1 project states the rule, not a delay", () => {
  /*
   * Asked for by the owner. The old wording ended "are not joined up yet", which reads as a
   * feature that is coming — and presets going from a Digitone II to a Digitone 1 is not coming,
   * because only FM TONE has an equivalent and a Digitone has no field for the third LFO. See
   * ROADMAP 17 for what a conversion would have to guess at.
   */
  const page = read("web/src/library/main.ts");
  const start = page.indexOf("function adopt(");
  assert.ok(start > 0, "adopt has been renamed; this check no longer guards anything");
  const block = page.slice(start, start + 1400);
  assert.match(block, /travel one way/, "the refusal says presets go one way");
  assert.doesNotMatch(block, /not joined up yet/, "and does not read as a delay");
});

test("the help says presets travel one way, with both of the owner's reasons", () => {
  const library = HELP_PAGES.find((page) => page.key === "library");
  const section = library?.sections.find((s) => s.heading === "Presets travel one way");
  assert.ok(section, "the library help lost its one-way section");
  assert.match(section!.body, /FM TONE/, "only FM TONE has an equivalent");
  assert.match(section!.body, /third LFO/, "and the third LFO is lost");
});
