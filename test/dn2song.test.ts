/**
 * Reading the Digitone II's song table.
 *
 * The format was established by differential capture on hardware — every field stated by a person
 * before it was read, and each one matched. These tests cannot re-run that; what they pin is the
 * **arithmetic**, which is where a transcription slip would hide, and the **guard**, which is what
 * the rest of the codebase relies on.
 *
 * The fixtures are built by hand from the measured offsets rather than copied from a capture. A
 * capture-derived fixture would agree with the reader by construction and prove nothing about it.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, NO_CORPUS } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN1_LAYOUT, DN2_LAYOUT } from "../src/project/dn2image.js";
import { DN2_DEVICE } from "../src/librarian/device.js";
import {
  Dn2SongError,
  END_LOOP,
  END_STOP,
  LABELS,
  ROW,
  SONG,
  SONG_TABLE,
  TEMPO_SCALE,
  isSongTableEmpty,
  mutedTracks,
  readSong,
  readSongs,
  selectedSong,
  songTableBase,
} from "../src/project/dn2song.js";

function emptyImage(): Uint8Array {
  return new Uint8Array(DN2_LAYOUT.imageSize);
}

/** Write one row into an image, using the constants rather than literals. */
function putRow(
  image: Uint8Array,
  song: number,
  row: number,
  f: { pattern: number; repeats: number; label: number; bpm: number; mute: number; length: number },
): void {
  const at = songTableBase() + song * SONG_TABLE.recordSize + SONG.rowOffset + row * SONG.rowSize;
  const u16 = (o: number, v: number): void => { image[at + o] = (v >> 8) & 0xff; image[at + o + 1] = v & 0xff; };
  image[at + ROW.pattern] = f.pattern;
  image[at + ROW.repeatsLessOne] = f.repeats - 1;
  image[at + ROW.label] = f.label;
  u16(ROW.tempo, f.bpm * TEMPO_SCALE);
  u16(ROW.mute, f.mute);
  u16(ROW.length, f.length);
}

function putSongHeader(image: Uint8Array, song: number, name: string, rowCount: number, endMode: number): void {
  const at = songTableBase() + song * SONG_TABLE.recordSize;
  for (let i = 0; i < name.length && i < SONG.nameSize; i++) image[at + i] = name.charCodeAt(i);
  image[at + SONG.rowCountOffset] = rowCount;
  image[at + SONG.endModeOffset] = endMode;
  image[at + SONG.tempoOffset] = (120 * TEMPO_SCALE) >> 8;
  image[at + SONG.tempoOffset + 1] = (120 * TEMPO_SCALE) & 0xff;
}

// --- the arithmetic, which is where a slip would hide ------------------------------------------------

test("the table ends exactly at the end of the image", () => {
  // The strongest evidence the geometry is right: 16 x 3,072 lands on the last byte with nothing
  // left over and nothing overrunning. If any of the three numbers were wrong this would not close.
  const end = songTableBase() + SONG_TABLE.count * SONG_TABLE.recordSize;
  assert.equal(end, DN2_LAYOUT.imageSize);
  assert.equal(SONG_TABLE.count * SONG_TABLE.recordSize, 49_152);
});

test("the row array abuts the trailer with no slack", () => {
  // 0x10 + 99 x 29 = 0xb47, and the row count sits at 0xb48. One byte either way and the last row
  // would overlap the trailer or leave an unexplained hole.
  assert.equal(SONG.rowOffset + SONG.rowCount * SONG.rowSize, 0xb47);
  assert.equal(SONG.rowCountOffset, 0xb47 + 1);
  assert.ok(SONG.tempoOffset + 2 <= SONG_TABLE.recordSize);
});

test("every label the device offers has a name, and none is a gap", () => {
  // 21 values, 0..20, all measured. A gap here was recorded once as "reserved" and turned out to be
  // FADE — a label the hand-walk had missed — so the count is asserted rather than assumed.
  assert.equal(LABELS.length, 21);
  assert.equal(LABELS[0], "(EMPTY)");
  assert.equal(LABELS[1], "(PTN NAME)");
  assert.equal(LABELS[15], "FX");
  assert.equal(LABELS[16], "FADE");
  assert.equal(LABELS[17], "MISC");
  assert.equal(LABELS[20], "OTHER");
  assert.equal(new Set(LABELS).size, LABELS.length, "no label appears twice");
});

// --- reading ------------------------------------------------------------------------------------

test("a song reads back the fields that were written into it", () => {
  const image = emptyImage();
  putSongHeader(image, 0, "A", 3, END_LOOP);
  putRow(image, 0, 0, { pattern: 0, repeats: 1, label: 2, bpm: 90, mute: 0x8000, length: 128 });
  putRow(image, 0, 1, { pattern: 1, repeats: 2, label: 3, bpm: 130, mute: 0x0000, length: 63 });
  putRow(image, 0, 2, { pattern: 3, repeats: 3, label: 16, bpm: 60, mute: 0x0001, length: 2 });

  const song = readSong(image, 0);
  assert.equal(song.name, "A");
  assert.equal(song.rowCount, 3);
  assert.equal(song.loops, true);
  assert.equal(song.tempo, 120);

  assert.deepEqual(song.rows[0], {
    pattern: 0, repeats: 1, label: 2, labelName: "INTRO", tempo: 90, mute: 0x8000, length: 128,
  });
  assert.equal(song.rows[1]!.repeats, 2);
  assert.equal(song.rows[2]!.labelName, "FADE");
  assert.equal(song.rows[2]!.tempo, 60);
});

test("repeats are one-based on the way out, zero-based on disk", () => {
  // The byte is one less than the number of plays. Reading it literally would report every row as
  // playing one time too few, which is the sort of error that only shows up in an arrangement.
  const image = emptyImage();
  putSongHeader(image, 0, "R", 1, END_LOOP);
  putRow(image, 0, 0, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16 });

  const at = songTableBase() + SONG.rowOffset + ROW.repeatsLessOne;
  assert.equal(image[at], 0, "one play is stored as zero");
  assert.equal(readSong(image, 0).rows[0]!.repeats, 1);
});

test("the mute mask reads as track numbers, bit 0 being track 1", () => {
  const image = emptyImage();
  putSongHeader(image, 0, "M", 2, END_LOOP);
  putRow(image, 0, 0, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0x8000, length: 16 });
  putRow(image, 0, 1, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0b0000_1010_1101_0110, length: 16 });

  const song = readSong(image, 0);
  assert.deepEqual(mutedTracks(song.rows[0]!), [16], "bit 15 is track 16");
  assert.deepEqual(mutedTracks(song.rows[1]!), [2, 3, 5, 7, 8, 10, 12]);
});

test("end mode distinguishes loop from stop", () => {
  const image = emptyImage();
  putSongHeader(image, 0, "L", 1, END_LOOP);
  putSongHeader(image, 1, "S", 1, END_STOP);
  assert.equal(readSong(image, 0).loops, true);
  assert.equal(readSong(image, 1).loops, false);
  assert.equal(readSong(image, 1).endMode, END_STOP);
});

test("only the rows in use are returned, and a wild count cannot read past the array", () => {
  const image = emptyImage();
  putSongHeader(image, 0, "X", 250, END_LOOP);   // more than 99: corrupt
  assert.equal(readSong(image, 0).rowCount, SONG.rowCount, "clamped to what can exist");
  assert.equal(readSong(image, 0).rows.length, SONG.rowCount);
});

test("all sixteen slots are readable and an unused one is empty", () => {
  const image = emptyImage();
  putSongHeader(image, 15, "LAST", 1, END_LOOP);
  const songs = readSongs(image);
  assert.equal(songs.length, 16);
  assert.equal(songs[15]!.name, "LAST");
  assert.equal(songs[0]!.rowCount, 0);
  assert.deepEqual(songs[0]!.rows, []);
});

test("a song index outside the table is refused", () => {
  assert.throws(() => readSong(emptyImage(), 16), Dn2SongError);
  assert.throws(() => readSong(emptyImage(), -1), Dn2SongError);
});

test("a Digitone 1 image is refused rather than read at DN2 offsets", () => {
  // The DN1 keeps songs somewhere else entirely. Reading it here would return plausible nonsense.
  const dn1 = new Uint8Array(DN1_LAYOUT.imageSize);
  assert.throws(() => isSongTableEmpty(dn1, DN1_LAYOUT), Dn2SongError);
  assert.throws(() => songTableBase(DN1_LAYOUT), Dn2SongError);
});

test("the selected song index is read from outside the table", () => {
  const image = emptyImage();
  image[DN2_LAYOUT.tailBase + 0xde12] = 2;
  assert.equal(selectedSong(image), 2);
});

// --- the guard, which is what the rest of the codebase leans on -----------------------------------

test("the rearrange guard is no longer blind on a Digitone II", () => {
  const image = emptyImage();
  assert.equal(isSongTableEmpty(image), true);
  assert.equal(DN2_DEVICE.songState(image), "empty", "was 'unknown' for as long as it existed");

  // One row anywhere in any slot is enough to make a rearrangement unsafe.
  putSongHeader(image, 9, "SOMEWHERE", 1, END_LOOP);
  assert.equal(isSongTableEmpty(image), false);
  assert.equal(DN2_DEVICE.songState(image), "occupied");
});

// --- the corpus, which must agree ----------------------------------------------------------------

function dn2Projects(): string[] {
  if (NO_CORPUS) return [];
  const dir = join(CORPUS ?? "", "02_DN2", "01_Projects");
  if (!existsSync(dir)) throw new Error(`${dir} is not in the corpus — nothing would be checked`);
  const found = readdirSync(dir).filter((f) => /\.dn2prj$/i.test(f));
  if (found.length === 0) throw new Error(`${dir} holds no .dn2prj`);
  return found.map((f) => join(dir, f));
}

const files = dn2Projects();

test("every real project reads without exploding, and none claims impossible rows", { skip: files.length === 0 }, () => {
  // None of these has a song — a scan for printable runs past the pool found nothing in any of them
  // — so this is checking that the reader is well behaved on real bytes rather than finding content.
  let checked = 0;
  for (const path of files) {
    const { payload } = parseProject(new Uint8Array(readFileSync(path)));
    const { image } = decodeProjectImage(payload.raw);
    if (image.length !== DN2_LAYOUT.imageSize) continue;
    checked++;

    for (const song of readSongs(image)) {
      assert.ok(song.rowCount <= SONG.rowCount, `${path}: song ${song.index} claims ${song.rowCount} rows`);
      assert.equal(song.rows.length, song.rowCount);
      for (const row of song.rows) {
        assert.ok(row.pattern < 128, `${path}: pattern ${row.pattern} out of range`);
        assert.ok(row.repeats >= 1);
      }
    }
    assert.ok(selectedSong(image) < SONG_TABLE.count, `${path}: selected song out of range`);
  }
  assert.ok(checked > 0, "no DN2 images were checked");
});
