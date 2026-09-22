import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import { applyRearrange } from "@noiseandmatter/dnx-core/librarian/rearrange.js";
import { keepOnly } from "@noiseandmatter/dnx-core/librarian/shuffle.js";
import { readSavedPosition } from "@noiseandmatter/dnx-core/project/position.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

/**
 * These tests do not prove the field is the saved position — only a device can do that. They
 * pin the two corpus properties the hypothesis rests on, so that if a future capture or a
 * layout change quietly breaks either one, it is a failing test rather than a claim in a doc
 * that nobody rechecks.
 */
const skip = NO_CORPUS && SKIP_REASON;
const DIR = `${CORPUS}02_DN2/01_Projects`;

interface Project {
  file: string;
  image: Uint8Array;
  mtime: number;
}

/** Decoding 26 projects takes seconds; every test here wants the same set. */
let cached: Project[] | undefined;

function dn2Projects(): Project[] {
  if (cached) return cached;
  const out: Project[] = [];
  for (const file of readdirSync(DIR).filter((f) => /\.dn2prj$/i.test(f))) {
    const path = join(DIR, file);
    let image: Uint8Array;
    try {
      image = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
    } catch {
      continue;
    }
    if (deviceFor(image).kind !== "dn2") continue;
    out.push({ file, image, mtime: statSync(path).mtimeMs });
  }
  if (out.length === 0) throw new Error(`no readable DN2 projects in ${DIR}`);
  cached = out;
  return out;
}

test("the saved-pattern byte usually names an occupied pattern", { skip }, () => {
  // The first of the two arguments the hypothesis rests on. A byte that pointed at empty slots
  // as often as full ones would be evidence against, and this is where that would show up.
  const projects = dn2Projects();
  let occupied = 0;

  for (const { image } of projects) {
    const device = deviceFor(image);
    const { pattern } = readSavedPosition(image);
    if (pattern === undefined) continue;
    const summary = device.summarise(image, pattern);
    if (summary.supported && summary.occupied) occupied++;
  }

  const ratio = occupied / projects.length;
  assert.ok(
    ratio >= 0.7,
    `only ${occupied}/${projects.length} projects point at an occupied pattern (${(ratio * 100).toFixed(0)}%). ` +
      `The offset may be wrong, or the corpus may have gained files we generated ourselves — ` +
      `those inherit their source's value and legitimately point anywhere.`,
  );
});

test("the saved-pattern byte walks forward through a capture session", { skip }, () => {
  // The stronger argument, and the one no coincidence explains. Six MORNING_JAM variants were
  // exported over one evening while stepping through patterns; in timestamp order the byte
  // reads H1, H2, H3, H3, H4, H4. Nothing else in a project has a reason to be non-decreasing
  // across successive saves.
  const family = dn2Projects()
    .filter((p) => /^MORNING_JA(M)? 1640/.test(p.file))
    .sort((a, b) => a.mtime - b.mtime);

  if (family.length < 4) {
    throw new Error(
      `the MORNING_JAM 1640 capture family is missing from the corpus (found ${family.length}); ` +
        `this test cannot check anything without it`,
    );
  }

  const walk = family.map((p) => readSavedPosition(p.image).pattern);
  assert.ok(
    walk.every((v) => v !== undefined),
    `every capture should name a possible pattern, got ${walk.join(", ")}`,
  );

  for (let i = 1; i < walk.length; i++) {
    assert.ok(
      walk[i]! >= walk[i - 1]!,
      `capture ${i} went backwards: ${walk.join(" -> ")} (${family.map((f) => f.file).join(", ")})`,
    );
  }
  assert.ok(
    walk[walk.length - 1]! > walk[0]!,
    `the sequence never advanced: ${walk.join(" -> ")} — a constant would pass a monotonic check ` +
      `while proving nothing`,
  );
});

test("rearranging patterns leaves the saved position pointing at the old slot", { skip }, () => {
  // The observation that started all this: a built test project opened on G2, the slot its seed
  // came from, because our builder copies the source tail verbatim.
  //
  // Built here rather than looked for among the corpus files, which was the first version of this
  // test and broke the moment those derivatives were tidied away. The claim is about our writer,
  // so exercise our writer.
  //
  // This documents a **defect**, not a feature: after `keepOnly` the pattern that was at the
  // saved slot has moved to A1, and the field still names the old slot. See KNOWN-ISSUES.
  const source = dn2Projects().find((p) => readSavedPosition(p.image).pattern! > 0);
  if (!source) throw new Error("no corpus project has a saved position away from A1 to move");

  const before = readSavedPosition(source.image).pattern!;
  const { image: after, verification } = applyRearrange(
    source.image,
    keepOnly([before], deviceFor(source.image).patternCount),
    { confirmOverwrite: true },
  );
  assert.ok(verification.ok, `rearrange failed: ${verification.problems.join("; ")}`);

  assert.equal(
    readSavedPosition(after).pattern,
    before,
    "the saved position should have been carried through untouched — nothing writes it yet",
  );
  assert.notEqual(before, 0, "the pattern is now at A1, so the field is stale by construction");
});

test("the saved track and its mirror agree in every project", { skip }, () => {
  // The device keeps two copies and moved both together in the controlled save pair. They agree
  // in all 24 corpus projects, so a disagreement means something we believe here is wrong —
  // which is why `readSavedPosition` reports it rather than silently preferring one.
  const projects = dn2Projects();
  const disagreeing = projects.filter((p) => readSavedPosition(p.image).trackMirrorDisagrees);
  assert.deepEqual(
    disagreeing.map((p) => p.file),
    [],
    "the two copies of the saved track have diverged, so one of them is not what we think",
  );
});

test("the saved track is not a constant across the corpus", { skip }, () => {
  // The test that would have caught the off-by-one. The first guess landed on +56,840, which
  // reads 5 in every file we hold — and "is 5 a plausible track index?" is a question a constant
  // passes trivially. A field that never varies is not the field you are looking for.
  const values = new Set(dn2Projects().map((p) => readSavedPosition(p.image).track));
  assert.ok(
    values.size > 1,
    `every project reports the same saved track (${[...values]}), which means this offset is a ` +
      `constant and not a position`,
  );
});

test("an implausible byte is reported as unknown rather than as a slot", () => {
  // "The byte says 200" is evidence against the hypothesis. Dressing it up as pattern 200 would
  // hide exactly the signal that would tell us the offset is wrong.
  const image = new Uint8Array(12_889_604);
  const probe = readSavedPosition(image);
  image[probe.at.pattern] = 200;
  image[probe.at.track] = 99;
  image[probe.at.trackMirror] = 99;

  const read = readSavedPosition(image);
  assert.equal(read.pattern, undefined);
  assert.equal(read.track, undefined);
  assert.equal(read.trackMirrorDisagrees, false, "both copies say 99, so they do agree");
});
