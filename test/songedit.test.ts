/**
 * Editing songs.
 *
 * The operations are pure and return new images, so these are round-trip tests: change something,
 * read it back, and check both that it took and that **nothing else moved**. That second half is the
 * point — a song lives in a 3,072-byte record inside a 12.9 MB image, and an operation that also
 * disturbed the record next door would be invisible in any test that only asserted its own result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DN2_LAYOUT } from "../src/project/dn2image.js";
import {
  Dn2SongError,
  END_LOOP,
  END_STOP,
  SONG,
  SONG_TABLE,
  SWING_BASE,
  readSong,
  songRecord,
  writeSong,
} from "../src/project/dn2song.js";
import {
  SongEditError,
  blankRow,
  clearSong,
  deleteRow,
  insertRow,
  moveRow,
  renameSong,
  setEndMode,
  setRow,
  setRowPattern,
  toggleRowMute,
} from "../src/librarian/songedit.js";

/** An image holding one song of `n` rows, each identifiable by its pattern. */
function withSong(n: number, index = 0): Uint8Array {
  const image = new Uint8Array(DN2_LAYOUT.imageSize);
  return writeSong(image, index, {
    name: "A",
    rowCount: n,
    endMode: END_LOOP,
    tempo: 120,
    rows: Array.from({ length: n }, (_, i) => ({ ...blankRow(), pattern: i })),
  });
}

const patterns = (image: Uint8Array, index = 0): number[] =>
  readSong(image, index).rows.map((r) => r.pattern);

/** Every byte outside song `index`'s record — what must not move. */
function elsewhere(image: Uint8Array, index: number): string {
  const at = DN2_LAYOUT.tailBase + SONG_TABLE.offset + index * SONG_TABLE.recordSize;
  const before = image.subarray(0, at);
  const after = image.subarray(at + SONG_TABLE.recordSize);
  return `${before.reduce((n, b) => n + b, 0)}:${after.reduce((n, b) => n + b, 0)}`;
}

// --- rows ---------------------------------------------------------------------------------------

test("setting a field leaves the others alone", () => {
  // The failure mode of passing a whole row through a form: one field changes and the rest are
  // blanked by omission.
  const image = setRow(withSong(3), 0, 1, { tempo: 145.5 });
  const row = readSong(image, 0).rows[1]!;
  assert.equal(row.tempo, 145.5);
  assert.equal(row.pattern, 1, "the pattern it already had");
  assert.equal(row.repeats, 1);
  assert.equal(row.swing, SWING_BASE);
});

test("a pattern dropped on a row lands on that row and no other", () => {
  const image = setRowPattern(withSong(4), 0, 2, 47);
  assert.deepEqual(patterns(image), [0, 1, 47, 3]);
});

test("an out-of-range value is refused rather than clamped", () => {
  // A caller asking for a 2,000-step row has a bug, and quietly storing 1,024 hides it inside a
  // project that then plays something nobody asked for.
  const image = withSong(2);
  assert.throws(() => setRow(image, 0, 0, { length: 2000 }), Dn2SongError);
  assert.throws(() => setRow(image, 0, 0, { length: 1 }), Dn2SongError);
  assert.throws(() => setRow(image, 0, 0, { swing: 81 }), Dn2SongError);
  assert.throws(() => setRow(image, 0, 0, { tempo: 500 }), Dn2SongError);
  assert.throws(() => setRowPattern(image, 0, 0, 128), SongEditError);
});

test("a refused edit changes nothing at all", () => {
  // Validation happens before any byte is written, so a rejected row is not half-applied.
  const image = withSong(3);
  const untouched = Uint8Array.from(image);
  assert.throws(() => setRow(image, 0, 0, { length: 9999 }));
  assert.deepEqual(image, untouched);
});

test("a row that does not exist is refused", () => {
  assert.throws(() => setRow(withSong(3), 0, 5, { tempo: 100 }), SongEditError);
  assert.throws(() => setRow(withSong(0), 0, 0, { tempo: 100 }), SongEditError);
});

// --- structure ----------------------------------------------------------------------------------

test("inserting copies the row above it, as the device does", () => {
  // Manual 10.13.2: "the new row is added below the currently selected row and is a copy of it".
  const image = insertRow(withSong(3), 0, 1);
  assert.deepEqual(patterns(image), [0, 1, 1, 2]);
  assert.equal(readSong(image, 0).rowCount, 4);
});

test("the first row of an empty song is blank, because there is nothing to copy", () => {
  const image = insertRow(withSong(0), 0, -1);
  const song = readSong(image, 0);
  assert.equal(song.rowCount, 1);
  assert.deepEqual(song.rows[0], blankRow());
});

test("deleting closes the gap and drops the count", () => {
  const image = deleteRow(withSong(4), 0, 1);
  assert.deepEqual(patterns(image), [0, 2, 3]);
  assert.equal(readSong(image, 0).rowCount, 3);
});

test("rows past the end are cleared, not left behind", () => {
  // A song shortened from four rows to three would otherwise keep the fourth just past the end:
  // invisible in the device's editor and very visible in a byte diff.
  const image = deleteRow(withSong(4), 0, 3);
  const record = songRecord(image, 0);
  const stale = record.subarray(SONG.rowOffset + 3 * SONG.rowSize, SONG.rowOffset + 4 * SONG.rowSize);
  assert.ok(stale.every((b) => b === 0), "the vacated row is zeroed");
});

test("moving a row puts it where it was dropped", () => {
  // `to` is the position after lifting, which is what a drag means: "it should end up fifth".
  assert.deepEqual(patterns(moveRow(withSong(5), 0, 0, 3)), [1, 2, 3, 0, 4]);
  assert.deepEqual(patterns(moveRow(withSong(5), 0, 4, 0)), [4, 0, 1, 2, 3]);
  assert.deepEqual(patterns(moveRow(withSong(5), 0, 2, 2)), [0, 1, 2, 3, 4], "a move to itself");
});

test("a song cannot grow past 99 rows", () => {
  const full = withSong(SONG.rowCount);
  assert.throws(() => insertRow(full, 0, 0), SongEditError);
});

// --- the song itself ------------------------------------------------------------------------------

test("renaming keeps the rows", () => {
  const image = renameSong(withSong(3), 0, "VERSE TWO");
  assert.equal(readSong(image, 0).name, "VERSE TWO");
  assert.deepEqual(patterns(image), [0, 1, 2]);
});

test("end mode survives a round trip", () => {
  const image = setEndMode(withSong(2), 0, END_STOP);
  assert.equal(readSong(image, 0).loops, false);
  assert.equal(readSong(image, 0).endMode, END_STOP);
});

test("clearing empties the slot, name and all", () => {
  // A cleared slot that kept its name would draw as a song that exists and has nothing in it, which
  // is two states rendered the same way.
  const image = clearSong(withSong(6), 0);
  const song = readSong(image, 0);
  assert.equal(song.rowCount, 0);
  assert.equal(song.name, "");
  assert.deepEqual(song.rows, []);
});

test("a mute toggles one track and leaves the rest", () => {
  let image = toggleRowMute(withSong(2), 0, 0, 16);
  assert.equal(readSong(image, 0).rows[0]!.mute, 0x8000);
  image = toggleRowMute(image, 0, 0, 1);
  assert.equal(readSong(image, 0).rows[0]!.mute, 0x8001);
  image = toggleRowMute(image, 0, 0, 16);
  assert.equal(readSong(image, 0).rows[0]!.mute, 0x0001, "toggling again clears just that bit");
});

test("a track outside 1..16 is refused", () => {
  assert.throws(() => toggleRowMute(withSong(1), 0, 0, 0), SongEditError);
  assert.throws(() => toggleRowMute(withSong(1), 0, 0, 17), SongEditError);
});

// --- the blast radius -----------------------------------------------------------------------------

test("editing one song touches nothing outside its record", () => {
  // A song is 3,072 bytes inside a 12.9 MB image. An operation that also disturbed the record next
  // door, or a pattern, would pass every test above.
  const image = withSong(4, 3);
  const outside = elsewhere(image, 3);

  for (const edited of [
    setRow(image, 3, 0, { tempo: 99 }),
    insertRow(image, 3, 0),
    deleteRow(image, 3, 0),
    moveRow(image, 3, 0, 2),
    renameSong(image, 3, "ZZ"),
    clearSong(image, 3),
    toggleRowMute(image, 3, 0, 4),
  ]) {
    assert.equal(elsewhere(edited, 3), outside);
    assert.equal(edited.length, image.length);
  }
});

test("editing one song leaves its neighbours readable and empty", () => {
  const image = insertRow(withSong(2, 5), 5, 0);
  for (const other of [4, 6]) {
    const song = readSong(image, other);
    assert.equal(song.rowCount, 0);
    assert.deepEqual(song.rows, []);
  }
});
