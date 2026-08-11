/**
 * The expander's planning, now that it can be asked without a browser.
 *
 * **None of this was testable before.** `planWhole` and `planMerge` assigned a module global on
 * their way past and called `window.confirm` in the middle of a refusal, so the only way to learn
 * what a plan produced was to run the page and read a panel. The bug that cost the most here — a
 * merge planned against 128 patterns of competition instead of the four selected — was found by
 * noticing that a panel disagreed with the result, which is not a way to find bugs.
 *
 * So these tests are the point of the extraction, not a bonus on top of it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, SKIP_REASON, requireCorpusFile } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import {
  type ExpanderOptions,
  PlanningRefused,
  planFor,
  planSelected,
  planWhole,
  renderDescribed,
  renderNotes,
  reportScope,
} from "../web/src/expander/planning.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

const OPTIONS: ExpanderOptions = {
  compactPerPattern: false,
  useFreedMidiTracks: false,
  aggregateByName: false,
};

function image(dir: string, name: string): Uint8Array {
  return decodeProjectImage(
    parseProject(new Uint8Array(readFileSync(requireCorpusFile(dir, name)))).payload.raw,
  ).image;
}

const dn1 = () => image(DN1_PROJECTS, "002 MORNING_JAM.dnprj");
const dn2 = () => image(DN2_PROJECTS, "EMPTY.dn2prj");

// --- the scope decision, which is where a real bug lived -----------------------------------------

test("the whole-project mode reports the whole project", () => {
  const { patterns, heading } = reportScope({ merging: false, merged: [], selection: [7] });
  // No pattern list at all: whole-project mode plans every live pattern, and narrowing it to a
  // selection would describe a layout that mode does not produce.
  assert.equal(patterns, undefined);
  assert.match(heading, /the whole project/);
});

test("merging reports what the project is becoming, not what is already in it", () => {
  // The distinction the panel exists for: between choosing and applying, the interesting question
  // is the union — what has landed plus what is about to.
  const { patterns, heading } = reportScope({ merging: true, merged: [3, 1], selection: [9, 1] });

  assert.deepEqual(patterns, [1, 3, 9], "sorted, de-duplicated, merged and selected together");
  assert.match(heading, /not applied yet/, "some of the scope has not landed, and it says so");
});

test("a scope that is entirely applied says so instead of counting nothing", () => {
  const { patterns, heading } = reportScope({ merging: true, merged: [2, 5], selection: [] });
  assert.deepEqual(patterns, [2, 5]);
  assert.match(heading, /2 pattern\(s\) merged/);
  assert.doesNotMatch(heading, /not applied/);
});

test("nothing chosen yet is a blank heading, not a zero", () => {
  const { patterns, heading } = reportScope({ merging: true, merged: [], selection: [] });
  assert.equal(patterns, undefined);
  assert.equal(heading, "");
});

// --- planning ------------------------------------------------------------------------------------

test("a plan for four patterns is planned for four patterns", { skip }, () => {
  // The bug this guards: handing the merge a whole-project plan made it allocate tracks against
  // 128 patterns of competition, so the layout it produced was not the one the panel described.
  const source = dn1();
  const four = planFor(source, [3, 1, 9, 2], OPTIONS);
  const all = planFor(source, [...Array(128).keys()], OPTIONS);

  assert.deepEqual(four.livePatterns.slice().sort((a, b) => a - b), four.livePatterns);
  assert.ok(
    four.livePatterns.every((p) => [1, 2, 3, 9].includes(p)),
    `a four-pattern plan must only consider those four, saw ${four.livePatterns}`,
  );
  assert.ok(
    all.livePatterns.length > four.livePatterns.length,
    "the whole-project plan should see more patterns than a four-pattern one",
  );
});

test("planning the whole project onto a blank says what would change", { skip }, () => {
  const outcome = planWhole({ source: dn1(), destination: dn2() });

  assert.ok(outcome.image, "a blank destination must have something to write");
  assert.match(outcome.message, /pattern slot\(s\) would change/);
  assert.ok(outcome.described.lines.length > 0);
});

test("planning onto a destination that already holds it offers nothing to write", { skip }, () => {
  // `image: undefined` is how the apply button knows to stay disabled, so "nothing to send" has to
  // be a real state rather than an empty diff nobody notices.
  const source = dn1();
  const first = planWhole({ source, destination: dn2() });
  assert.ok(first.image);

  const again = planWhole({ source, destination: first.image });
  assert.equal(again.image, undefined, "the second pass has nothing left to change");
  assert.match(again.message, /already holds this conversion/);
});

test("merging with nothing selected is refused, not planned", { skip }, () => {
  assert.throws(
    () =>
      planSelected({
        source: dn1(),
        destination: dn2(),
        selection: [],
        landing: 0,
        landingMode: "relative",
        options: OPTIONS,
        ask: () => true,
      }),
    PlanningRefused,
  );
});

test("consent is asked for, and declining plans nothing", { skip }, () => {
  // Two passes over an occupied slot: the first refuses, the caller is asked, and a "no" must
  // leave `image` undefined rather than writing anyway.
  const source = dn1();
  const occupied = planWhole({ source, destination: dn2() }).image!;

  const asked: string[] = [];
  const outcome = planSelected({
    source,
    destination: occupied,
    selection: [0],
    landing: 0,
    landingMode: "relative",
    options: OPTIONS,
    ask: (question) => {
      asked.push(question);
      return false;
    },
  });

  assert.equal(asked.length, 1, "an occupied landing slot has to be asked about exactly once");
  assert.match(asked[0]!, /Go ahead anyway\?/);
  assert.equal(outcome.image, undefined, "declining must not produce bytes to write");
  assert.match(outcome.message, /Not planned/);
});

test("agreeing plans it", { skip }, () => {
  const source = dn1();
  const occupied = planWhole({ source, destination: dn2() }).image!;

  const outcome = planSelected({
    source,
    destination: occupied,
    selection: [0],
    landing: 0,
    landingMode: "relative",
    options: OPTIONS,
    ask: () => true,
  });

  assert.ok(outcome.image, "consent given, so there must be bytes");
  assert.match(outcome.message, /press Apply/);
});

// --- rendering -----------------------------------------------------------------------------------

test("conversion notes fold away, with their counts", () => {
  const html = renderNotes([
    { message: "inferred at DN1+173", count: 40 },
    { message: "dropped DN1+284", count: 2 },
  ]);
  assert.match(html, /<details/, "they belong behind a disclosure, not in the strip");
  assert.match(html, /42 conversion note\(s\), 2 distinct/);
  assert.match(html, /× 40/);
});

test("a single note does not get a multiplier", () => {
  assert.doesNotMatch(renderNotes([{ message: "one thing", count: 1 }]), /×/);
});

test("no notes render nothing at all", () => {
  assert.equal(renderNotes(undefined), "");
  assert.equal(renderNotes([]), "");
});

test("a described plan escapes what it renders", () => {
  // The lines carry project and pattern names, which are whatever somebody typed on a Digitone.
  const html = renderDescribed({ lines: ['<img src=x onerror="alert(1)">'] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
