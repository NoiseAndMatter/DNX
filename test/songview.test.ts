/**
 * The song panel's rendering.
 *
 * `songview.ts` draws and decides nothing, so these tests are about **what a person is shown** —
 * particularly the two ways a viewer of decoded data can mislead: presenting a value in units the
 * device does not use, and making "we could not read it" look like "there is nothing there".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Song, type SongRow, SWING_BASE } from "@noiseandmatter/dnx-core/project/dn2song.js";
import {
  LABEL_NAMES,
  describeLabel,
  describeMutes,
  describeSong,
  songTabs,
} from "../web/src/manager/songview.js";

function row(over: Partial<SongRow> = {}): SongRow {
  return {
    pattern: 0, repeats: 1, label: 2, labelName: "INTRO",
    tempo: 120, mute: 0, length: 16, swing: SWING_BASE, ...over,
  };
}

function song(over: Partial<Song> = {}): Song {
  return {
    index: 0, name: "A", rowCount: 1, endMode: 0xff, loops: true, tempo: 120,
    rows: [row()], ...over,
  };
}

test("mutes read as track numbers a person can check on the instrument", () => {
  // `0x0016` is not something anyone can compare against a device's screen; `2, 3, 5` is.
  // T-prefixed to match the manager's own track grid: a bare "1" in a table of numbers reads as a
  // count rather than a track.
  assert.equal(describeMutes(row({ mute: 0b0000_0000_0001_0110 })), "T2, T3, T5");
  assert.equal(describeMutes(row({ mute: 0x8000 })), "T16");
});

test("an unmuted row says so rather than showing nothing", () => {
  // An empty cell reads as "this build could not work it out". "none" is a different claim, and the
  // true one.
  assert.equal(describeMutes(row({ mute: 0 })), "none");
});

test("a label this build does not know shows its number rather than a blank", () => {
  // The enum is complete as measured, but a firmware that added one must not render as an empty
  // cell — that would look like a reading failure and hide a real finding.
  assert.equal(describeLabel(row({ label: 2, labelName: "INTRO" })), "INTRO");
  const unknown = row({ label: 99 });
  delete (unknown as { labelName?: string }).labelName;
  assert.equal(describeLabel(unknown), "? (99)");
});

test("the summary names the end behaviour, which the row table cannot show", () => {
  // A song that loops and one that stops are different pieces of music, and nothing in the rows
  // says which.
  assert.match(describeSong(song({ loops: true })), /ends by looping/);
  assert.match(describeSong(song({ loops: false, endMode: 0xfe })), /ends by stopping/);
});

test("an unnamed song is called unnamed rather than shown as blank", () => {
  assert.match(describeSong(song({ name: "" })), /\(unnamed\)/);
  assert.match(describeSong(song({ name: "  " })), /\(unnamed\)/);
  assert.match(describeSong(song({ name: "VERSE ONE" })), /VERSE ONE/);
});

test("an empty song is described as empty, not as a song with no rows shown", () => {
  const empty = describeSong(song({ rowCount: 0, rows: [] }));
  assert.match(empty, /empty/);
  assert.doesNotMatch(empty, /BPM/, "an empty slot has no meaningful tempo to quote");
});

test("row and song counts read in the device's own numbering", () => {
  // The device calls them 1..16 and 1..99. Everything on disk is zero-based, and showing that
  // would make every number on screen one less than the instrument says.
  const tabs = songTabs([song({ index: 0 }), song({ index: 1, rowCount: 0, rows: [] })], 1);
  assert.equal(tabs[0]!.label, "1");
  assert.equal(tabs[1]!.label, "2");
  assert.equal(tabs[0]!.selected, false);
  assert.equal(tabs[1]!.selected, true);
});

test("a tab carries its row count so an empty slot is visible without clicking", () => {
  const tabs = songTabs([song({ rowCount: 7 }), song({ index: 1, rowCount: 0, rows: [] })], 0);
  assert.equal(tabs[0]!.rowCount, 7);
  assert.equal(tabs[1]!.rowCount, 0);
});

test("the panel uses the device's own label vocabulary, not its own", () => {
  // Sharing the table rather than restating it: a second list would drift, and a label is exactly
  // the sort of thing somebody would "tidy up" into title case.
  assert.equal(LABEL_NAMES.length, 21);
  assert.equal(LABEL_NAMES[16], "FADE");
});

test("swing is shown as a percentage, matching the instrument", () => {
  // Stored as percent minus 50. Showing the stored byte would put "7" on screen where the device
  // says 57%.
  assert.equal(row({ swing: 57 }).swing, 57);
  assert.equal(SWING_BASE, 50);
});
