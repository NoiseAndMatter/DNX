import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import {
  NAME_SIZE,
  RenameError,
  applyRename,
  normaliseName,
  planRename,
  readPatternName,
  verifyRename,
} from "@noiseandmatter/dnx-core/librarian/rename.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

/**
 * Corpus-dependent tests skip on a fresh clone, which is the project's rule and is about the
 * corpus being *absent*. It is not licence to pass quietly: once the corpus is there, a test
 * that cannot find the fixture it needs **throws**, because a test that goes green by finding
 * nothing is how three lock tests in PR #33 passed with the bug reintroduced.
 */
const skip = NO_CORPUS && SKIP_REASON;

function corpusImage(): Uint8Array {
  const path = `${CORPUS}02_DN2/01_Projects/MORNING_JAM.dn2prj`;
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

// --- what a typed name becomes ---------------------------------------------------------------

test("a name is upper-cased, because the device has no lowercase", () => {
  // Not a stylistic choice: across 13,488 pattern and preset names in the corpus there is not
  // one lowercase letter. Refusing "kick" while the hardware simply types KICK would be
  // pedantry about a form with exactly one meaning.
  assert.equal(normaliseName("intro").name, "INTRO");
  assert.match(normaliseName("intro").notes.join(" "), /lowercase/);
});

test("a name that needs nothing done to it gets no notes", () => {
  // Every note is shown to the user. One that fires on a name nobody changed trains them to
  // ignore the ones that matter.
  assert.deepEqual(normaliseName("INTRO 01"), { name: "INTRO 01", notes: [] });
});

test("the field is sixteen characters, and the corpus uses all sixteen", () => {
  // Preset names reach 16 in real files, so there is no terminator to leave room for. The
  // project name writer truncates to 15 for its own field; that difference is real.
  const long = normaliseName("ABCDEFGHIJKLMNOPQRST");
  assert.equal(long.name.length, NAME_SIZE);
  assert.equal(long.name, "ABCDEFGHIJKLMNOP");
  assert.match(long.notes.join(" "), /truncated/);
});

test("exactly sixteen characters is not truncation", () => {
  const exact = normaliseName("ABCDEFGHIJKLMNOP");
  assert.equal(exact.name.length, NAME_SIZE);
  assert.deepEqual(exact.notes, []);
});

test("characters the device cannot store are dropped and reported", () => {
  const result = normaliseName("IN\u0000TRO\u0007");
  assert.equal(result.name, "INTRO");
  assert.match(result.notes.join(" "), /dropped 2 character/);
});

test("accented letters survive, because the corpus proves the device writes them", () => {
  // The corpus shows Å Æ Ç Ö Ü in real names, so Latin-1 is allowed rather than a hand-picked
  // list that could only ever record what nobody happened to type.
  assert.equal(normaliseName("BJÖRK").name, "BJÖRK");
});

test("surrounding spaces go, inner ones stay", () => {
  const result = normaliseName("  INTRO 01  ");
  assert.equal(result.name, "INTRO 01");
  assert.match(result.notes.join(" "), /surrounding spaces/);
});

test("emoji and other non-Latin-1 characters are dropped, not mangled", () => {
  // Encoding one as Latin-1 would write whichever low byte happened to fall out, which is how
  // a name field turns into noise the device renders as garbage.
  assert.equal(normaliseName("INTRO \u{1F600}").name, "INTRO");
});

// --- planning ----------------------------------------------------------------------------------

test("a slot outside the bank is blocked, not clamped", { skip }, () => {
  const project = corpusImage();
  const device = deviceFor(project);
  const plan = planRename(project, device, new Map([[device.patternCount, "X"]]));
  assert.equal(plan.ok, false);
  assert.match(plan.findings[0]!.message, /outside/);
});

test("a name with nothing storable in it is blocked", { skip }, () => {
  // Otherwise the field is filled with NULs and the pattern silently loses its name.
  const project = corpusImage();
  const device = deviceFor(project);
  const plan = planRename(project, device, new Map([[0, "\u0000\u0007"]]));
  assert.equal(plan.ok, false);
  assert.match(plan.findings[0]!.message, /nothing storable/);
});

test("renaming a pattern to what it is already called is a no-op with a reason", { skip }, () => {
  const project = corpusImage();
  const device = deviceFor(project);
  const current = readPatternName(project, device, 0);
  const plan = planRename(project, device, new Map([[0, current]]));
  assert.equal(plan.ok, true, "a no-op is allowed, it just does nothing");
  assert.equal(plan.changes.length, 0);
  assert.match(plan.findings.map((f) => f.message).join(" "), /already called/);
});

test("a duplicate name is allowed but warned about", { skip }, () => {
  // The device permits it. The pattern hardware session learned what it costs: two slots with
  // one name make a swap unfalsifiable, and by the time you notice the evidence is gone.
  const project = corpusImage();
  const device = deviceFor(project);

  // Both slots must be occupied — `duplicates` only counts patterns that hold something — and
  // the target must not already carry the name, or this measures the no-op path instead. The
  // first cut picked slots 0 and 1, which in this project are already called the same thing,
  // so it went green on the wrong finding.
  const occupied = [...Array(device.patternCount).keys()].filter(
    (i) => device.summarise(project, i).occupied,
  );
  if (occupied.length === 0) throw new Error("the corpus project has no occupied pattern");

  const name = readPatternName(project, device, occupied[0]!);
  const target = occupied.find((i) => readPatternName(project, device, i) !== name);
  if (target === undefined) {
    throw new Error(`every occupied pattern is called "${name}", so none can be made a duplicate`);
  }

  const plan = planRename(project, device, new Map([[target, name]]));
  assert.equal(plan.ok, true);
  assert.match(plan.findings.map((f) => f.message).join(" "), /cannot be told apart/);
});

// --- applying and verifying --------------------------------------------------------------------

test("a rename writes the name and reads back", { skip }, () => {
  const project = corpusImage();
  const device = deviceFor(project);
  const { image, plan } = applyRename(project, device, new Map([[5, "INTRO 01"]]));
  assert.equal(plan.changes.length, 1);
  assert.equal(readPatternName(image, device, 5), "INTRO 01");
  assert.equal(verifyRename(project, image, device, plan).ok, true);
});

test("a rename touches sixteen bytes and nothing else", { skip }, () => {
  // The check worth having. Re-reading the name is our writer agreeing with our reader; this
  // asks whether the offset, the layout and the record slicing all agreed too. A stray byte
  // would be invisible to a name check right up until the device refused the project.
  const project = corpusImage();
  const device = deviceFor(project);
  const { image } = applyRename(project, device, new Map([[5, "INTRO 01"]]));

  let differing = 0;
  for (let i = 0; i < project.length; i++) if (project[i] !== image[i]) differing++;
  assert.ok(differing > 0, "nothing changed at all");
  assert.ok(differing <= NAME_SIZE, `${differing} bytes changed, at most ${NAME_SIZE} should have`);
});

test("a shorter name does not leave the tail of the longer one behind", { skip }, () => {
  // Without a fill the field would read back as the original: "AB" over "ABCDEFGH" leaves
  // "ABCDEFGH", since reading stops at a NUL that is no longer there.
  const project = corpusImage();
  const device = deviceFor(project);
  const long = applyRename(project, device, new Map([[5, "ABCDEFGHIJKLMNOP"]])).image;
  const short = applyRename(long, device, new Map([[5, "AB"]])).image;
  assert.equal(readPatternName(short, device, 5), "AB");
});

test("verify catches a byte written outside the name field", { skip }, () => {
  // Reintroducing the bug this guards against, by hand: the image is corrupted somewhere the
  // rename had no business touching, and verification must refuse it.
  const project = corpusImage();
  const device = deviceFor(project);
  const { image, plan } = applyRename(project, device, new Map([[5, "INTRO 01"]]));

  const stray = Uint8Array.from(image);
  const at = device.layout.headerSize + 5 * device.layout.patternSize;
  stray[at] = stray[at]! ^ 0xff;

  const result = verifyRename(project, stray, device, plan);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /outside the name fields/);
});

test("applying a blocked plan throws rather than writing a partial result", { skip }, () => {
  const project = corpusImage();
  const device = deviceFor(project);
  assert.throws(
    () => applyRename(project, device, new Map([[0, "OK"], [999, "BAD"]])),
    RenameError,
    "one bad slot must stop the whole batch, not rename the good one and give up",
  );
});

test("many slots rename in one pass, which is the seam batch schemes will use", { skip }, () => {
  // The librarian takes a map from the start. A batch scheme — by position, by selection order,
  // from a base name — produces one of these and nothing else, so every scheme lands downstream
  // of the writer that has already been verified.
  const project = corpusImage();
  const device = deviceFor(project);
  const renames = new Map([
    [3, "PART A"],
    [4, "PART B"],
    [5, "PART C"],
  ]);
  const { image, plan } = applyRename(project, device, renames);
  assert.equal(plan.changes.length, 3);
  for (const [slot, name] of renames) assert.equal(readPatternName(image, device, slot), name);
  assert.equal(verifyRename(project, image, device, plan).ok, true);
});
