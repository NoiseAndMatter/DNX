/**
 * Reading the Digitone II's song table.
 *
 * The format was established by differential capture on hardware — every field stated by a person
 * before it was read, and each one matched. These tests cannot re-run that; what they pin is the
 * **arithmetic**, which is where a transcription slip would hide, and the **guard**, which is what
 * the rest of the codebase relies on.
 *
 * The hand-built fixtures write their offsets as **literals**, not through the constants under test.
 * A fixture that imported `SONG` would land wherever the reader looked and pass whatever the number
 * was, which is how a wrong offset survives a green suite — and one did, for six weeks.
 *
 * ## Why two real projects are in here
 *
 * Not one project under `01_Projects` holds a song row, so every claim a synthetic fixture makes
 * about *where* a field lives is untested against hardware. That is how this module came to read the
 * module came to read the low half of a word and to call a sixteen-record array complete.
 * `DN2_SONGS` holds the one corpus project with a real arrangement, and `DN2_OS111` holds what OS
 * 1.11 writes. Between them they are the whole evidence base for the parts a synthetic image cannot
 * test.
 *
 * `DN2_OS111` carries three files on purpose, and the third is the one that matters most:
 * `GLITCH_EXP slot7 overread.bin` declares **storage version 3 at the 1.11 image length**, because
 * a pre-1.11 project read off an updated instrument arrives with 512 bytes of slack. Its song array
 * is at the version-3 base. Any check that placed the array by image length would read the wrong
 * half of every one of its records, and would do so silently.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CORPUS,
  DN2_OS111,
  DN2_PROJECTS,
  DN2_SONGS,
  NO_CORPUS,
  requireCorpusFile,
  requireCorpusFiles,
} from "./corpus.js";
import { parsePayload } from "@noiseandmatter/dnx-core/project/container.js";
import { imageFrom } from "@noiseandmatter/dnx-core/device/drive.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { DN1_LAYOUT, DN2_LAYOUT, projectObjectVersion } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { DN2_DEVICE } from "@noiseandmatter/dnx-core/librarian/device.js";
import {
  Dn2SongError,
  END_LOOP,
  END_STOP,
  LABELS,
  ROW,
  SONG,
  SONG_TABLE,
  SWING_BASE,
  TEMPO_SCALE,
  SONG_LAYOUT_VERSIONS,
  SONG_RECORD_ZERO_OFFSET,
  SONG_TABLE_SHIFT_1_11,
  isSongTableEmpty,
  mutedTracks,
  readSong,
  readSongs,
  requireKnownSongLayout,
  selectedSong,
  songRecordZeroBase,
  songTableBase,
  writeSong,
} from "@noiseandmatter/dnx-core/project/dn2song.js";

/**
 * The row count's offset as a literal, so a fixture never borrows the reader's own idea of it.
 *
 * `0x10 + 99 x 29 = 0xb47`, a `u16be`. The module said `0xb48` and one byte until 2026-10-03.
 */
const ROW_COUNT_AT = 0xb47;

/**
 * A blank image that **declares a storage version**, because the reader refuses one that does not.
 *
 * 3 is OS 1.10E, the version most of the corpus carries. Versions this build cannot place are what
 * the refusal tests pass instead.
 */
function emptyImage(projectVersion = 3): Uint8Array {
  const image = new Uint8Array(DN2_LAYOUT.imageSize);
  image.set([0xbe, 0xef, 0xba, 0xce], 0);
  image[4] = (projectVersion >>> 24) & 0xff;
  image[5] = (projectVersion >>> 16) & 0xff;
  image[6] = (projectVersion >>> 8) & 0xff;
  image[7] = projectVersion & 0xff;
  return image;
}

/** Write one row into an image, using the constants rather than literals. */
function putRow(
  image: Uint8Array,
  song: number,
  row: number,
  f: { pattern: number; repeats: number; label: number; bpm: number; mute: number; length: number; swing?: number },
): void {
  const at = songTableBase(image) + song * SONG_TABLE.recordSize + SONG.rowOffset + row * SONG.rowSize;
  const u16 = (o: number, v: number): void => { image[at + o] = (v >> 8) & 0xff; image[at + o + 1] = v & 0xff; };
  image[at + ROW.pattern] = f.pattern;
  image[at + ROW.repeatsLessOne] = f.repeats - 1;
  image[at + ROW.label] = f.label;
  // **Rounded, not truncated.** 135.2 x 120 is 16223.999... in binary, and truncating stores a
  // tempo 1/120 BPM low. The device stores integers; anything that writes songs must round.
  u16(ROW.tempo, Math.round(f.bpm * TEMPO_SCALE));
  u16(ROW.mute, f.mute);
  u16(ROW.length, f.length);
  image[at + ROW.swing] = (f.swing ?? SWING_BASE) - SWING_BASE;
}

function putSongHeader(image: Uint8Array, song: number, name: string, rowCount: number, endMode: number): void {
  const at = songTableBase(image) + song * SONG_TABLE.recordSize;
  for (let i = 0; i < name.length && i < SONG.nameSize; i++) image[at + i] = name.charCodeAt(i);
  // A word, as the firmware's own loader reads it. The byte this used to write was its low half.
  image[at + ROW_COUNT_AT] = (rowCount >> 8) & 0xff;
  image[at + ROW_COUNT_AT + 1] = rowCount & 0xff;
  image[at + SONG.endModeOffset] = endMode;
  image[at + SONG.tempoOffset] = (120 * TEMPO_SCALE) >> 8;
  image[at + SONG.tempoOffset + 1] = (120 * TEMPO_SCALE) & 0xff;
}

// --- the arithmetic, which is where a slip would hide ------------------------------------------------

test("the array ends exactly at the end of the image, and there are seventeen records", () => {
  const image = emptyImage();
  // 16 x 3,072 from song 0 lands on the last byte with nothing left over — which is why the
  // sixteen-record reading survived for six weeks. **It is one record short.** A clean project has
  // seventeen tempo words at a stride of 3,072, the first one record before song 0, and seventeen
  // records from there also land on the last byte. The sixteen-record reading has to call that
  // seventeenth word a coincidence sitting exactly one stride before the array.
  const end = songTableBase(image) + SONG_TABLE.count * SONG_TABLE.recordSize;
  assert.equal(end, DN2_LAYOUT.imageSize);
  assert.equal(SONG_TABLE.count * SONG_TABLE.recordSize, 49_152);

  assert.equal(SONG_RECORD_ZERO_OFFSET, 0xe004, "the array begins one record before song 0");
  assert.equal(songRecordZeroBase(image), DN2_LAYOUT.tailBase + SONG_RECORD_ZERO_OFFSET);
  const arrayBytes = end - songRecordZeroBase(image);
  assert.equal(arrayBytes, 17 * SONG_TABLE.recordSize, "seventeen records, no slack");
});

test("the row array abuts the meta block, and the row count is a word", () => {
  // 0x10 + 99 x 29 = 0xb47, and the row count starts there. One byte either way and the last row
  // would overlap the count or leave an unexplained hole.
  //
  // **It said 0xb48 and called that the whole field.** 0xb48 is the low half, which is the entire
  // answer for any count a song can hold, so reading it was right by accident. 0xb47 had been
  // recorded as "zero in every record seen" — which is what the high byte of 0..99 always looks
  // like, and no song in any of the seven captures had more than 18 rows.
  assert.equal(SONG.rowOffset + SONG.rowCount * SONG.rowSize, ROW_COUNT_AT);
  assert.equal(SONG.rowCountOffset, ROW_COUNT_AT);
  assert.ok(SONG.tempoOffset + 2 <= SONG_TABLE.recordSize);

  // A count whose high byte is set must be seen, which is the whole point of the width.
  const image = emptyImage();
  putSongHeader(image, 0, "BIG", 0x0100, END_LOOP);
  assert.equal(readSong(image, 0).rowCount, SONG.rowCount, "0x0100 is 256, clamped to 99");
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
    swing: 50,
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

  const at = songTableBase(image) + SONG.rowOffset + ROW.repeatsLessOne;
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


test("swing is stored as an offset from 50%", () => {
  // Measured: a row set to 57% reads 7, a row set to the maximum 80% reads 30. The manual's 50-80
  // range closes exactly onto one byte of 0..30, which is why the offset is not a guess.
  const image = emptyImage();
  putSongHeader(image, 0, "SW", 3, END_LOOP);
  putRow(image, 0, 0, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16, swing: 57 });
  putRow(image, 0, 1, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16, swing: 80 });
  putRow(image, 0, 2, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16 });

  const at = songTableBase(image) + SONG.rowOffset + ROW.swing;
  assert.equal(image[at], 7, "57% is stored as 7");
  assert.equal(image[at + SONG.rowSize], 30, "80% is stored as 30");

  const song = readSong(image, 0);
  assert.equal(song.rows[0]!.swing, 57);
  assert.equal(song.rows[1]!.swing, 80);
  assert.equal(song.rows[2]!.swing, 50, "an untouched row is 50%, not 0");
  assert.equal(SWING_BASE, 50);
});

test("swing sits in what used to be the unexplained tail of a row", () => {
  // +27 was among the bytes recorded as "zero in every capture" until one varied swing. The point
  // of keeping that list honest is that its members fall one at a time; this asserts the field is
  // inside the row rather than past it.
  assert.ok(ROW.swing < SONG.rowSize);
  assert.ok(ROW.swing > ROW.length + 1, "after the fields already decoded");
});


test("tempo is exact at the device's 0.1 BPM resolution", () => {
  // 135.1 was set on hardware precisely because every other tempo in the capture was a round
  // number, and a round number cannot tell a x120 scale from a x100 or a x10 one. It read 16,212,
  // which is 135.1 x 120 exactly — and one 0.1 BPM step moves the raw value by 12.
  const image = emptyImage();
  putSongHeader(image, 0, "T", 2, END_LOOP);
  putRow(image, 0, 0, { pattern: 0, repeats: 1, label: 0, bpm: 135.1, mute: 0, length: 16 });
  putRow(image, 0, 1, { pattern: 0, repeats: 1, label: 0, bpm: 135.2, mute: 0, length: 16 });

  const at = songTableBase(image) + SONG.rowOffset + ROW.tempo;
  const raw = (image[at]! << 8) | image[at + 1]!;
  assert.equal(raw, 16_212);
  assert.equal(raw, 135.1 * TEMPO_SCALE);

  const next = songTableBase(image) + SONG.rowOffset + SONG.rowSize + ROW.tempo;
  assert.equal(((image[next]! << 8) | image[next + 1]!) - raw, 12, "0.1 BPM is 12 raw units");

  const song = readSong(image, 0);
  assert.ok(Math.abs(song.rows[0]!.tempo - 135.1) < 1e-9);
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
  assert.throws(() => songTableBase(dn1, DN1_LAYOUT), Dn2SongError);
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

test("the guard also counts the record before song 0", () => {
  // Nothing else reads that record and nothing knows what it is for, so a row in it is a row this
  // build cannot explain. The guard is the one place where that should count against the operation.
  const image = emptyImage();
  assert.equal(isSongTableEmpty(image), true);

  const zero = songRecordZeroBase(image);
  image[zero + ROW_COUNT_AT + 1] = 1;
  assert.equal(isSongTableEmpty(image), false, "a row in the seventeenth record is still a row");
  assert.equal(DN2_DEVICE.songState(image), "occupied");

  // And it is genuinely outside the sixteen this module numbers, so nothing else saw it.
  assert.ok(readSongs(image).every((song) => song.rowCount === 0));
});

// --- which firmwares this can place, and what it refuses ----------------------------------------

test("the array's position follows the project object's storage version", () => {
  // Keyed off the version, never the image length. A pre-1.11 project read off a 1.11 instrument
  // comes back at the 1.11 length with its array still at the version-3 base, so a length check
  // would move it 512 bytes and read the wrong half of every record. `GLITCH_EXP slot7` is that
  // file, and it is in the corpus.
  assert.deepEqual([...SONG_LAYOUT_VERSIONS], [2, 3, 5], "2 pre-1.10E, 3 is 1.10E, 5 is 1.11");
  assert.equal(SONG_TABLE_SHIFT_1_11, 0x200);

  for (const version of [2, 3]) {
    const image = emptyImage(version);
    assert.equal(songTableBase(image), DN2_LAYOUT.tailBase + 0xec04, `version ${version}`);
  }
  const os111 = emptyImage(5);
  assert.equal(songTableBase(os111), DN2_LAYOUT.tailBase + 0xee04, "OS 1.11 is 512 later");
  assert.equal(readSongs(os111).length, SONG_TABLE.count);
});

test("an unplaced storage version is refused, not sorted onto the nearer side", () => {
  // 4 has never been seen on a Digitone II: the family went 3 to 5. Guessing would be worse than
  // refusing, because `writeSong` uses the same answer and the wrong side lands inside a record.
  for (const version of [4, 6, 12]) {
    const image = emptyImage(version);
    assert.throws(() => requireKnownSongLayout(image), Dn2SongError, `version ${version}`);
    assert.throws(() => readSongs(image), Dn2SongError);
    assert.throws(() => isSongTableEmpty(image), Dn2SongError);
    assert.equal(DN2_DEVICE.songState(image), "unknown");
  }
});

test("a version-5 song round-trips through the shifted array", () => {
  const image = emptyImage(5);
  const written = writeSong(image, 0, {
    name: "AFTER",
    rowCount: 1,
    endMode: END_STOP,
    tempo: 96,
    rows: [{ pattern: 7, repeats: 2, label: 5, tempo: 128, mute: 0, length: 64, swing: 50 }],
  });

  // Written 512 bytes on from where a version-3 project keeps song 0, and nothing left behind at
  // the old place — which is what distinguishes the array moving from the array being copied.
  const at = DN2_LAYOUT.tailBase + 0xee04;
  assert.equal((written[at + ROW_COUNT_AT]! << 8) | written[at + ROW_COUNT_AT + 1]!, 1);
  const old = DN2_LAYOUT.tailBase + 0xec04;
  assert.equal((written[old + ROW_COUNT_AT]! << 8) | written[old + ROW_COUNT_AT + 1]!, 0);

  const song = readSong(written, 0);
  assert.equal(song.name, "AFTER");
  assert.equal(song.rowCount, 1);
  assert.equal(song.tempo, 96);
  assert.equal(song.rows[0]!.pattern, 7);
});

test("a project with no object at offset 0 is refused, not read as version 0", () => {
  // One real file in the author's backups has `DN1P` there and object versions of 254 and 3,335
  // further in. Reading it as version 0 would have handled a damaged file as a known layout.
  const noMagic = new Uint8Array(DN2_LAYOUT.imageSize);
  assert.equal(projectObjectVersion(noMagic), undefined);
  assert.throws(() => readSongs(noMagic), Dn2SongError);
  assert.equal(DN2_DEVICE.songState(noMagic), "unknown");
});

// --- the two real projects that have anything to say about offsets ------------------------------

function imageOf(path: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  return decodeProjectImage(payload.raw).image;
}

/** A whole project read off the +Drive, as `drive.ts` hands it back. */
function driveCapture(path: string): Uint8Array {
  return imageFrom(parsePayload(new Uint8Array(readFileSync(path))));
}

test("a real project's song reads exactly what the device stored", { skip: NO_CORPUS }, () => {
  // `002 COREVAULT` is the only project in the corpus with a song, and this is the only test that
  // checks these offsets against bytes a Digitone II actually wrote. Every number below was read off
  // the file before being asserted; none came from the reader.
  const image = imageOf(requireCorpusFiles(DN2_SONGS, ".dn2prj")[0]!);
  assert.equal(projectObjectVersion(image), 3);

  const song = readSong(image, 0);
  assert.equal(song.rowCount, 23);
  assert.equal(song.rows.length, 23);
  assert.equal(song.endMode, END_STOP);
  assert.equal(song.loops, false);
  assert.equal(song.tempo, 120);

  assert.deepEqual(song.rows[0], {
    pattern: 75,
    repeats: 4,
    label: 2,
    labelName: "INTRO",
    tempo: 138,
    mute: 0xffcf,
    length: 32,
    swing: 50,
  });
  assert.equal(song.rows[1]!.labelName, "VERSE");

  for (const row of song.rows) {
    assert.ok(row.pattern < 128, `pattern ${row.pattern} out of range`);
    assert.ok(row.length >= 2 && row.length <= 1024, `length ${row.length} outside the manual's range`);
    assert.ok(row.tempo >= 30 && row.tempo <= 300, `tempo ${row.tempo} implausible`);
  }

  assert.equal(isSongTableEmpty(image), false);
  assert.equal(DN2_DEVICE.songState(image), "occupied");

  // The seventeenth record reads as untouched here, which is what makes checking it free.
  const zero = DN2_LAYOUT.tailBase + SONG_RECORD_ZERO_OFFSET;
  assert.equal((image[zero + ROW_COUNT_AT]! << 8) | image[zero + ROW_COUNT_AT + 1]!, 0);
});

test("the array's seventeen records are what a clean project actually holds", { skip: NO_CORPUS }, () => {
  // An untouched song record reads 0x3840 at +0xb4c — 14,400, which is 120 BPM at the x120 scale.
  // Counting those words is what found the seventeenth record, so the count is asserted against
  // real bytes rather than against the constant that was derived from them.
  const image = imageOf(requireCorpusFiles(DN2_PROJECTS, ".dn2prj").find((f) => /008 JAM/.test(f))!);
  assert.equal(projectObjectVersion(image), 3);

  const base = DN2_LAYOUT.tailBase + SONG_RECORD_ZERO_OFFSET;
  for (let r = 0; r < 17; r++) {
    const rec = base + r * SONG_TABLE.recordSize;
    assert.equal(
      (image[rec + SONG.tempoOffset]! << 8) | image[rec + SONG.tempoOffset + 1]!,
      120 * TEMPO_SCALE,
      `record ${r} should read as an untouched song`,
    );
    assert.ok(
      image.subarray(rec, rec + SONG.nameSize).every((b) => b === 0),
      `record ${r} should have no name`,
    );
  }
  assert.equal(base + 17 * SONG_TABLE.recordSize, image.length, "and the array ends with the image");

  // There is no eighteenth: one stride earlier is not another untouched record.
  const before = base - SONG_TABLE.recordSize;
  assert.notEqual(
    (image[before + SONG.tempoOffset]! << 8) | image[before + SONG.tempoOffset + 1]!,
    120 * TEMPO_SCALE,
  );
});

test("every record of a clean OS 1.11 project reads as an untouched song", { skip: NO_CORPUS }, () => {
  // **The measurement that placed the version-5 array.** `TEST_FX_LOCK` is a 1.11 project with no
  // songs, read whole off the +Drive. At `tail + 0xee04` all sixteen records read as untouched
  // songs in every field at once — no name, no rows, count 0, end mode 0, 120 BPM. A base that was
  // 512 bytes out could not produce that in sixteen consecutive records.
  //
  // It is asserted field by field rather than through `readSong`, because `readSong` would answer
  // from the same constant the test is trying to check.
  const image = driveCapture(requireCorpusFile(DN2_OS111, "TEST_FX_LOCK slot9 os111.bin"));
  assert.equal(projectObjectVersion(image), 5);
  assert.equal(image.length, DN2_LAYOUT.imageSize + 512);

  const base = DN2_LAYOUT.tailBase + 0xee04;
  assert.equal(songTableBase(image), base);
  for (let r = 0; r < SONG_TABLE.count; r++) {
    const rec = base + r * SONG_TABLE.recordSize;
    const where = `record ${r}`;
    assert.ok(image.subarray(rec, rec + SONG.nameSize).every((b) => b === 0), `${where}: name`);
    assert.equal((image[rec + ROW_COUNT_AT]! << 8) | image[rec + ROW_COUNT_AT + 1]!, 0, `${where}: count`);
    assert.equal(image[rec + SONG.endModeOffset], 0, `${where}: end mode`);
    assert.equal(
      (image[rec + SONG.tempoOffset]! << 8) | image[rec + SONG.tempoOffset + 1]!,
      120 * TEMPO_SCALE,
      `${where}: tempo`,
    );
    assert.ok(
      image.subarray(rec + SONG.rowOffset, rec + ROW_COUNT_AT).every((b) => b === 0),
      `${where}: rows`,
    );
  }
  assert.equal(base + SONG_TABLE.count * SONG_TABLE.recordSize, image.length, "ends with the image");

  // The seventeenth record survives the migration as all zeros, tempo included, where a pre-1.11
  // project reads it as an untouched song at 120 BPM. Nothing explains that, and the guard does not
  // need it to: zero rows is zero rows.
  const zero = songRecordZeroBase(image);
  assert.ok(image.subarray(zero, zero + SONG_TABLE.recordSize).every((b) => b === 0));

  assert.equal(isSongTableEmpty(image), true);
  assert.equal(DN2_DEVICE.songState(image), "empty");
});

test("a pre-1.11 project read off a 1.11 instrument keeps the old base", { skip: NO_CORPUS }, () => {
  // **Why the version and not the length.** `GLITCH_EXP slot7` was read off an updated instrument
  // and arrives at the 1.11 length with 512 bytes of slack: the object terminator sits at the 1.10E
  // end, not at the end of the buffer. Its project object still says version 3 and its array is
  // still at `tail + 0xec04`. Placing the array by image length would move it 512 bytes, and every
  // record would be read from the middle of its neighbour.
  const image = driveCapture(requireCorpusFile(DN2_OS111, "GLITCH_EXP slot7 overread.bin"));
  assert.equal(projectObjectVersion(image), 3);
  assert.equal(image.length, DN2_LAYOUT.imageSize + 512, "the length alone would say 1.11");

  assert.deepEqual(
    [...image.subarray(DN2_LAYOUT.imageSize - 4, DN2_LAYOUT.imageSize)],
    [0xba, 0xce, 0xf0, 0x0c],
    "the real image ends at the 1.10E length",
  );
  assert.equal(songTableBase(image), DN2_LAYOUT.tailBase + 0xec04, "version 3, so the old base");

  // And the array is really there: seventeen untouched records from the version-3 base.
  const zero = songRecordZeroBase(image);
  for (let r = 0; r < 17; r++) {
    const rec = zero + r * SONG_TABLE.recordSize;
    assert.equal(
      (image[rec + SONG.tempoOffset]! << 8) | image[rec + SONG.tempoOffset + 1]!,
      120 * TEMPO_SCALE,
      `record ${r}`,
    );
  }
  assert.equal(DN2_DEVICE.songState(image), "empty");
});

test("the damaged 1.11 project reads, and the guard says it cannot tell", { skip: NO_CORPUS }, () => {
  // `004 SKETCHPAD OS111` is the project whose song area the instrument itself damaged. Its
  // seventeenth record declares 21,503 rows, **at the exact address the firmware's own loader reads
  // before it crashes** — which is a third confirmation of the array's base, the record's size and
  // the count's offset, arrived at from a disassembly rather than from these files.
  const image = imageOf(requireCorpusFile(DN2_OS111, "004 SKETCHPAD OS111.dn2prj"));
  assert.equal(projectObjectVersion(image), 5);

  const wild = songRecordZeroBase(image) + ROW_COUNT_AT;
  assert.equal((image[wild]! << 8) | image[wild + 1]!, 21_503);
  assert.equal(wild, 0xc3ef4b, "the address the firmware session reported");

  // The sixteen songs read fine and all declare nothing, so the panel still opens.
  for (const song of readSongs(image)) {
    assert.equal(song.rowCount, 0);
    assert.deepEqual(song.rows, []);
  }

  // But the verdict is "cannot tell", not "this project has songs". There is no arrangement to
  // warn about, and calling it empty would be just as much of a claim.
  assert.throws(() => isSongTableEmpty(image), Dn2SongError);
  assert.equal(DN2_DEVICE.songState(image), "unknown");
});

test("a count no song can have is refused by the guard, not reported as an arrangement", () => {
  const image = emptyImage();
  const at = songTableBase(image) + 3 * SONG_TABLE.recordSize + ROW_COUNT_AT;
  image[at] = 0x53;
  image[at + 1] = 0xff;
  assert.throws(() => isSongTableEmpty(image), Dn2SongError);
  assert.equal(DN2_DEVICE.songState(image), "unknown");

  // 99 is the most a song can hold, and that is an arrangement rather than damage.
  image[at] = 0;
  image[at + 1] = SONG.rowCount;
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
