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
 * low half of a word and to call a sixteen-record array complete. `DN2_SONGS` holds the one corpus
 * project with a real arrangement and `DN2_OS111` the one saved by OS 1.11; between them they are
 * the whole evidence base for the parts a synthetic image cannot test.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, DN2_OS111, DN2_PROJECTS, DN2_SONGS, NO_CORPUS, requireCorpusFiles } from "./corpus.js";
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
  isSongTableEmpty,
  mutedTracks,
  readSong,
  readSongs,
  requireKnownSongLayout,
  selectedSong,
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
  const at = songTableBase() + song * SONG_TABLE.recordSize + SONG.rowOffset + row * SONG.rowSize;
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
  const at = songTableBase() + song * SONG_TABLE.recordSize;
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
  // 16 x 3,072 from song 0 lands on the last byte with nothing left over — which is why the
  // sixteen-record reading survived for six weeks. **It is one record short.** A clean project has
  // seventeen tempo words at a stride of 3,072, the first one record before song 0, and seventeen
  // records from there also land on the last byte. The sixteen-record reading has to call that
  // seventeenth word a coincidence sitting exactly one stride before the array.
  const end = songTableBase() + SONG_TABLE.count * SONG_TABLE.recordSize;
  assert.equal(end, DN2_LAYOUT.imageSize);
  assert.equal(SONG_TABLE.count * SONG_TABLE.recordSize, 49_152);

  assert.equal(SONG_RECORD_ZERO_OFFSET, 0xe004, "the array begins one record before song 0");
  const arrayBytes = end - (DN2_LAYOUT.tailBase + SONG_RECORD_ZERO_OFFSET);
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


test("swing is stored as an offset from 50%", () => {
  // Measured: a row set to 57% reads 7, a row set to the maximum 80% reads 30. The manual's 50-80
  // range closes exactly onto one byte of 0..30, which is why the offset is not a guess.
  const image = emptyImage();
  putSongHeader(image, 0, "SW", 3, END_LOOP);
  putRow(image, 0, 0, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16, swing: 57 });
  putRow(image, 0, 1, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16, swing: 80 });
  putRow(image, 0, 2, { pattern: 0, repeats: 1, label: 0, bpm: 120, mute: 0, length: 16 });

  const at = songTableBase() + SONG.rowOffset + ROW.swing;
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

  const at = songTableBase() + SONG.rowOffset + ROW.tempo;
  const raw = (image[at]! << 8) | image[at + 1]!;
  assert.equal(raw, 16_212);
  assert.equal(raw, 135.1 * TEMPO_SCALE);

  const next = songTableBase() + SONG.rowOffset + SONG.rowSize + ROW.tempo;
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

test("the guard also counts the record before song 0", () => {
  // Nothing else reads that record and nothing knows what it is for, so a row in it is a row this
  // build cannot explain. The guard is the one place where that should count against the operation.
  const image = emptyImage();
  assert.equal(isSongTableEmpty(image), true);

  const zero = DN2_LAYOUT.tailBase + SONG_RECORD_ZERO_OFFSET;
  image[zero + ROW_COUNT_AT + 1] = 1;
  assert.equal(isSongTableEmpty(image), false, "a row in the seventeenth record is still a row");
  assert.equal(DN2_DEVICE.songState(image), "occupied");

  // And it is genuinely outside the sixteen this module numbers, so nothing else saw it.
  assert.ok(readSongs(image).every((song) => song.rowCount === 0));
});

// --- which firmwares this can place, and what it refuses ----------------------------------------

test("the storage versions with a located song array are the only ones read", () => {
  assert.deepEqual([...SONG_LAYOUT_VERSIONS], [2, 3], "2 is pre-1.10E, 3 is OS 1.10E");
  for (const version of SONG_LAYOUT_VERSIONS) {
    requireKnownSongLayout(emptyImage(version));
    assert.equal(readSongs(emptyImage(version)).length, SONG_TABLE.count);
  }
});

test("an OS 1.11 project is refused rather than read at the pre-1.11 offsets", () => {
  // **The bug this change exists for.** OS 1.11 writes version 5 and moves the whole array; read at
  // the old offsets it reported all sixteen songs empty, every time, so the rearrange guard called a
  // project with an arrangement safe to shuffle. Refusing turns a confident wrong answer into
  // "unknown", which is what the guard's third state is for.
  const os111 = emptyImage(5);
  assert.throws(() => requireKnownSongLayout(os111), Dn2SongError);
  assert.throws(() => readSongs(os111), Dn2SongError);
  assert.throws(() => isSongTableEmpty(os111), Dn2SongError);
  assert.equal(DN2_DEVICE.songState(os111), "unknown");
});

test("writing refuses the same projects reading refuses, before copying anything", () => {
  // A write that refused after the copy would still be correct, but the point of checking first is
  // that `writeSong` is reached from the manager's song panel on every edit.
  assert.throws(
    () =>
      writeSong(emptyImage(5), 0, {
        name: "NO",
        rowCount: 1,
        endMode: END_STOP,
        tempo: 120,
        rows: [{ pattern: 0, repeats: 1, label: 0, tempo: 120, mute: 0, length: 16, swing: 50 }],
      }),
    Dn2SongError,
  );
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

test("an OS 1.11 project's array is somewhere this build will not guess", { skip: NO_CORPUS }, () => {
  // The obvious answer is 512 later, because the Outbox 8 block was inserted ahead of the array just
  // as OS 1.43 did on the Digitone 1. It is not good enough: at that base a clean 1.11 project holds
  // float-shaped bytes where a song's name would be, so 1.11 did more than slide the array.
  //
  // This test pins the *evidence for refusing*, so that a later build which does place the array has
  // to confront the same bytes rather than quietly assume them away.
  const image = imageOf(requireCorpusFiles(DN2_OS111, ".dn2prj")[0]!);
  assert.equal(projectObjectVersion(image), 5);
  assert.throws(() => readSongs(image), Dn2SongError);
  assert.equal(DN2_DEVICE.songState(image), "unknown");

  // 512 longer than a pre-1.11 image, and the terminator still sits in the last four bytes.
  assert.equal(image.length - DN2_LAYOUT.imageSize, 512);
  assert.deepEqual([...image.subarray(image.length - 4)], [0xba, 0xce, 0xf0, 0x0c]);

  // Sixteen untouched records end on the last byte, so the arithmetic alone would say the array
  // slid 512 — and then the seventeenth slot's name field is not a name.
  const slid = image.length - 17 * SONG_TABLE.recordSize;
  assert.ok(
    !image.subarray(slid + SONG_TABLE.recordSize, slid + SONG_TABLE.recordSize + SONG.nameSize)
      .every((b) => b === 0),
    "if this ever reads as sixteen zeros, the array has been located and the refusal can go",
  );
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
