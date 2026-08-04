import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN2_LAYOUT } from "../src/project/dn2image.js";
import { readMidiTrackMask } from "../src/project/dn2pattern.js";
import { deviceFor } from "../src/librarian/device.js";
import { applyTrackMove, trigCounts } from "../src/librarian/trackmove.js";
import { swap } from "../src/librarian/shuffle.js";
import { summariseTracks, trackIndex, trackName } from "../src/librarian/tracksummary.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;

function image(): Uint8Array {
  const path = `${CORPUS}02_DN2/01_Projects/MORNING_JAM.dn2prj`;
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

// --- naming, which the CLI and the UI both go through --------------------------------------

test("tracks are named the way the device numbers them", () => {
  assert.equal(trackName(0), "T1");
  assert.equal(trackName(15), "T16");
});

test("a track can be typed with or without its T", () => {
  // People type "7". Rejecting a form with exactly one meaning is pedantry, not safety.
  assert.equal(trackIndex("T7"), 6);
  assert.equal(trackIndex("t7"), 6);
  assert.equal(trackIndex("7"), 6);
  assert.equal(trackIndex(" 7 "), 6);
});

test("anything outside 1..16 is not a track", () => {
  // 0 especially: it is the one off-by-one a 0-based codebase invites, and "T0" resolving to
  // track 1 would be silently wrong rather than loudly rejected.
  for (const bad of ["T0", "0", "17", "T17", "", "A1", "1.5", "-1", "seven"]) {
    assert.equal(trackIndex(bad), undefined, `"${bad}" should not resolve to a track`);
  }
});

// --- the summary itself --------------------------------------------------------------------

test("a pattern always summarises all sixteen tracks", { skip }, () => {
  const tracks = summariseTracks(image(), 0);
  assert.equal(tracks.length, 16);
  assert.deepEqual(
    tracks.map((t) => t.index),
    [...Array(16).keys()],
    "indices should be dense and 0-based so they index a shuffle directly",
  );
});

test("a DN1 conversion shows four synth tracks then four MIDI", { skip }, () => {
  // The shape Elektron's importer produces, and the clearest end-to-end check that the summary
  // reads the MIDI mask rather than guessing from the sound slot's presence.
  const tracks = summariseTracks(image(), 0);
  assert.deepEqual(
    tracks.map((t) => t.midi),
    [false, false, false, false, true, true, true, true, ...Array(8).fill(false)],
  );
});

test("trig counts agree with the librarian's own", { skip }, () => {
  // The whole point of this module is that the CLI and the UI cannot disagree with each other
  // or with `trackmove`. A second counter would be a second answer.
  const img = image();
  assert.deepEqual(
    summariseTracks(img, 0).map((t) => t.trigCount),
    trigCounts(img, 0),
  );
});

test("empty means the sequencer has nothing to play", { skip }, () => {
  for (const t of summariseTracks(image(), 0)) {
    assert.equal(t.empty, t.trigCount === 0 && t.lockCount === 0, `${t.label} disagrees`);
  }
});

test("the summary follows a track when it moves", { skip }, () => {
  // Reading stale bytes would make the UI show the old arrangement after an operation, which
  // looks like the operation failing.
  const img = image();
  const device = deviceFor(img);
  const before = summariseTracks(img, 0);
  const a = before.findIndex((t) => !t.empty);
  const b = before.findIndex((t) => t.empty && t.midi !== before[a]!.midi);
  if (b < 0) return;

  const { image: after } = applyTrackMove(img, device, 0, swap(a, b), { confirmOverwrite: true });
  const now = summariseTracks(after, 0);

  assert.equal(now[b]!.presetName, before[a]!.presetName);
  assert.equal(now[b]!.trigCount, before[a]!.trigCount);
  assert.equal(now[b]!.midi, before[a]!.midi, "the MIDI flag should travel with the preset");
  assert.equal(now[a]!.midi, before[b]!.midi);
});

test("the MIDI flag is the kit's mask, not a re-derivation", { skip }, () => {
  const img = image();
  for (let p = 0; p < 8; p++) {
    const mask = readMidiTrackMask(img, p, DN2_LAYOUT);
    assert.deepEqual(
      summariseTracks(img, p).map((t) => t.midi),
      [...Array(16).keys()].map((t) => ((mask >> t) & 1) === 1),
      `pattern ${p + 1} disagrees with its own kit mask`,
    );
  }
});

test("an unnamed preset reports an empty name rather than inventing one", { skip }, () => {
  // The device fills preset names in lazily, so blank is a real state and must survive as one.
  // A summary that substituted "INIT" would put a name on screen the device never wrote.
  const tracks = summariseTracks(image(), 0);
  assert.ok(
    tracks.some((t) => t.presetName === ""),
    "the corpus pattern should have at least one unnamed preset",
  );
});
