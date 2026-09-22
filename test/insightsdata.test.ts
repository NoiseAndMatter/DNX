/**
 * The numbers behind the Insights page, measured without a browser.
 *
 * These could not be tested before: they were derived inside `renderInsights`, between the cards
 * that printed them. What is asserted here is the part that had two sources and disagreed with
 * itself, plus the handful of figures the page leads with.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN2_PROJECTS, NO_CORPUS, corpusPath } from "./corpus.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN2_DEVICE } from "@noiseandmatter/dnx-core/librarian/device.js";
import { patternSubject } from "@noiseandmatter/dnx-core/analysis/patternsubject.js";
import { insightsData } from "@noiseandmatter/dnx-core/analysis/insights.js";
import { repetitions } from "@noiseandmatter/dnx-core/analysis/model.js";

const FILE = "006 GLITCH_EXPLORE.dn2prj";
const SKIP = !NO_CORPUS && existsSync(join(corpusPath(DN2_PROJECTS), FILE))
  ? false
  : "needs the private corpus";

function image(): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(join(corpusPath(DN2_PROJECTS), FILE))));
  return decodeProjectImage(payload.raw).image;
}

/** A pattern with a track at a speed other than 1x, which is where the two counts diverged. */
function offSpeedPattern(img: Uint8Array): number {
  for (let p = 0; p < DN2_DEVICE.patternCount; p++) {
    let subject;
    try { subject = patternSubject(img, DN2_DEVICE, p); } catch { continue; }
    const data = insightsData(subject);
    if (data.silent) continue;
    const speeds = new Set(data.live.map((t) => t.speed));
    if (speeds.size > 1) return p;
  }
  throw new Error("no mixed-speed pattern in this project");
}

test("repeats are measured against the master period, not the track's own length", { skip: SKIP }, () => {
  /*
   * **The recount this split exists to remove.** The table divided the polymeter by each track's
   * length; the chart beside it asked the model for the same figure against the master period. A
   * track at 3/2x covers its length in fewer master steps than it has steps, so the two printed
   * different numbers for the same track on the same screen.
   */
  const img = image();
  const subject = patternSubject(img, DN2_DEVICE, offSpeedPattern(img));
  const data = insightsData(subject);

  for (const row of data.tracks) {
    assert.equal(row.repeats, repetitions(row.track, data.cycle),
      `${row.track.label} must report what the chart reports`);
  }

  const offSpeed = data.tracks.find((r) => r.track.speed !== 1);
  assert.ok(offSpeed, "this pattern was chosen because a track is not at 1x");
  assert.notEqual(offSpeed.repeats, data.polymeter / offSpeed.track.length,
    "and for that track the old arithmetic gave a different answer, which is the bug");
});

test("the cycle is the polymeter bounded by the reset", { skip: SKIP }, () => {
  const img = image();
  const subject = patternSubject(img, DN2_DEVICE, offSpeedPattern(img));
  const data = insightsData(subject);

  assert.ok(data.cycle <= data.polymeter, "a reset can only shorten what repeats");
  assert.equal(data.cut, data.polymeter > data.cycle);
  if (subject.resetSteps === undefined) {
    assert.equal(data.cycle, data.polymeter, "with no reset the two are the same number");
  }
});

test("a pattern with nothing on it reports silence rather than zeros that look measured",
  { skip: SKIP }, () => {
  const img = image();
  let silent;
  for (let p = 0; p < DN2_DEVICE.patternCount; p++) {
    let subject;
    try { subject = patternSubject(img, DN2_DEVICE, p); } catch { continue; }
    const data = insightsData(subject);
    if (data.silent) { silent = data; break; }
  }
  assert.ok(silent, "this project has at least one empty pattern");
  assert.equal(silent.live.length, 0);
  assert.deepEqual(silent.tracks, [], "no tracks means no per-track figures, not zeroed ones");
});

test("the totals count what the tracks hold", { skip: SKIP }, () => {
  const img = image();
  const subject = patternSubject(img, DN2_DEVICE, offSpeedPattern(img));
  const data = insightsData(subject);

  assert.equal(data.trigs, data.live.reduce((n, t) => n + t.trigs.length, 0));
  assert.ok(data.accents <= data.trigs, "an accent is a trig");
  assert.ok(data.conditional <= data.trigs, "a condition is on a trig");
  assert.ok(data.peakVoices >= 0);
  assert.equal(data.unreachable, data.reach.total - data.reach.reachable);
});
