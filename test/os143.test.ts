/**
 * Digitone 1 projects and Digitone 1 OS 1.43.
 *
 * 1.43 does two separate things, and DNX had to answer both to stop refusing the projects an
 * owner reported on 2026-09-20.
 *
 * - **It inserts 512 bytes at the song array** for the Outbox 8 CV configuration, taking the
 *   image to 2,782,212, moving the songs and the terminator up and leaving everything above
 *   them where it was.
 * - **Its +Drive read over-reads older projects.** The firmware copies a hardcoded 2,782,212
 *   bytes whatever the stored file's real length, so a project last saved on 1.42A arrives
 *   declaring the newer size with 512 bytes of slack behind its terminator. Projects migrate on
 *   load rather than on update, so that is the common case, not the odd one.
 *
 * Three captures of **one project** carry the whole argument, which is why they are the fixtures:
 * the same music stored on 1.42A, read on 1.43 before re-saving, and saved on 1.43. A synthetic
 * image would be built out of the same understanding these tests exist to check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePayload } from "../src/project/container.js";
import {
  DN1_IMAGE_SIZE,
  DN1_OS143_IMAGE_SIZE,
  decodeProjectImage,
} from "../src/project/dn2codec.js";
import { DN1_LAYOUT, DN2_LAYOUT, fitsLayout, layoutFor } from "../src/project/dn2image.js";
import { PATTERN, RECORD_VERSIONS, checkDn1Image, readPattern } from "../src/project/dn1.js";
import {
  BOB_CONFIG,
  SETTINGS_VERSIONS,
  SONG_VERSION,
  TAIL,
  checkDn1Tail,
  readProjectSettings,
  readSongs,
  tailGeometry,
  tailRegionBase,
} from "../src/project/dn1tail.js";
import { imageFrom } from "../src/device/drive.js";
import { ListingError } from "../src/device/storage.js";
import { deviceFor } from "../src/librarian/device.js";
import { DN1_OS143, NO_CORPUS, SKIP_REASON, requireCorpusFile } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;

/** Object terminator, the last four bytes of a Digitone 1 image at either size. */
const TERMINATOR = [0xba, 0xce, 0xf0, 0x0c];

/** The same project, as 1.42A stored it. A compressed container, so it decodes. */
function stored142(): Uint8Array {
  const raw = new Uint8Array(readFileSync(requireCorpusFile(DN1_OS143, "MORNING_JAM-os142.payload.bin")));
  return decodeProjectImage(raw).image;
}

/** The raw payload of a +Drive read: 31-byte header, uncompressed body, 12-byte trailer. */
function driveRead(name: string): Uint8Array {
  return new Uint8Array(readFileSync(requireCorpusFile(DN1_OS143, name)));
}

const SAVED = "MORNING_JAM-os143-saved.payload.bin";
const UNMIGRATED = "MORNING_JAM-os143-unmigrated-read.payload.bin";

/** The u32be root object version in the image header, which is what the device migrates on. */
function objectVersion(image: Uint8Array): number {
  return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(4, false);
}

function endsWithTerminator(image: Uint8Array): boolean {
  const tail = [...image.subarray(image.length - 4)];
  return TERMINATOR.every((b, i) => tail[i] === b);
}

// --- the sizes, without a device -----------------------------------------------------------------

test("one Digitone 1 layout describes both firmwares, because 1.43 only inserts", () => {
  assert.equal(DN1_OS143_IMAGE_SIZE - DN1_IMAGE_SIZE, BOB_CONFIG.size);
  assert.equal(layoutFor(new Uint8Array(DN1_IMAGE_SIZE)), DN1_LAYOUT);
  assert.equal(layoutFor(new Uint8Array(DN1_OS143_IMAGE_SIZE)), DN1_LAYOUT,
    "a 1.43 image is a Digitone 1 image, at the same offsets up to the song array");
  assert.equal(fitsLayout(new Uint8Array(DN1_OS143_IMAGE_SIZE), DN2_LAYOUT), false);
});

test("a size neither firmware writes is still refused", () => {
  // Accepting a second size is not accepting any size. A read cut short by another application on
  // the port is the likeliest source of an odd length, and it must not decode as a project.
  assert.throws(() => layoutFor(new Uint8Array(DN1_OS143_IMAGE_SIZE + 1)), /Unrecognised/);
  assert.throws(() => layoutFor(new Uint8Array(DN1_IMAGE_SIZE - 512)), /Unrecognised/);
});

test("the tail geometry is derived from the image's own length, not copied", () => {
  const older = tailGeometry(new Uint8Array(DN1_IMAGE_SIZE));
  const newer = tailGeometry(new Uint8Array(DN1_OS143_IMAGE_SIZE));

  assert.equal(older.songOffset, TAIL.songOffset);
  assert.equal(older.terminatorOffset, TAIL.terminatorOffset);
  assert.equal(older.bobConfigOffset, undefined, "1.42A has no Outbox block");

  assert.equal(newer.songOffset, TAIL.songOffset + BOB_CONFIG.size);
  assert.equal(newer.terminatorOffset, TAIL.terminatorOffset + BOB_CONFIG.size);
  assert.equal(newer.size, TAIL.size + BOB_CONFIG.size);
  assert.equal(newer.bobConfigOffset, TAIL.songOffset,
    "the Outbox block took the place the songs used to start at");

  // The absolute offsets the findings were measured at, so a change to the base arithmetic shows
  // up here rather than in a project that reads plausible nonsense.
  assert.equal(tailRegionBase() + older.songOffset, 0x29c800);
  assert.equal(tailRegionBase() + newer.songOffset, 0x29ca00);
  assert.equal(tailRegionBase() + newer.terminatorOffset + 4, DN1_OS143_IMAGE_SIZE);
});

// --- a real 1.43 save ------------------------------------------------------------------------------

test("a project saved on 1.43 is format 0104, 512 bytes longer, and object version 14", { skip }, () => {
  const payload = parsePayload(driveRead(SAVED));
  assert.equal(payload.kind, 9, "a Digitone 1 project");
  assert.equal(payload.formatVersion, "0104");
  assert.equal(payload.storedLength, DN1_OS143_IMAGE_SIZE);

  const image = imageFrom(payload);
  assert.equal(image.length, DN1_OS143_IMAGE_SIZE);
  assert.equal(objectVersion(image), 14);
  assert.ok(endsWithTerminator(image), "the terminator is the last four bytes, at 2,782,208");
  assert.equal(layoutFor(image), DN1_LAYOUT);
});

test("a 1.43 image passes both whole-image checks", { skip }, () => {
  const image = imageFrom(parsePayload(driveRead(SAVED)));
  assert.deepEqual(checkDn1Image(image).problems, []);
  assert.deepEqual(checkDn1Tail(image).problems, []);
});

test("1.43 bumps the record versions and moves nothing", { skip }, () => {
  const image = imageFrom(parsePayload(driveRead(SAVED)));

  const versions = new Set<number>();
  for (let i = 0; i < DN1_LAYOUT.patternCount; i++) versions.add(readPattern(image, i).version);
  assert.deepEqual([...versions], [11], "every pattern record is version 11");
  assert.ok(RECORD_VERSIONS.includes(11), "and 11 is a version DNX reads");

  const settings = readProjectSettings(image);
  assert.equal(settings.version, 8);
  assert.ok(SETTINGS_VERSIONS.includes(settings.version));
});

test("the 1.43 patterns are the 1.42A patterns apart from the version byte", { skip }, () => {
  /*
   * **The claim the record readers rest on.** If 1.43 had moved a field inside a pattern record,
   * widening the accepted versions would be reading the wrong bytes with a straight face. It did
   * not: across 2,359,296 bytes of pattern array the two saves differ in exactly 128 bytes, one
   * per record, all of them the low byte of the version field.
   */
  const older = stored142();
  const newer = imageFrom(parsePayload(driveRead(SAVED)));

  const differing: number[] = [];
  for (let i = 0; i < DN1_LAYOUT.patternCount; i++) {
    const at = DN1_LAYOUT.headerSize + i * DN1_LAYOUT.patternSize;
    for (let b = 0; b < DN1_LAYOUT.patternSize; b++) {
      if (older[at + b] !== newer[at + b]) differing.push(b);
    }
  }
  assert.equal(differing.length, DN1_LAYOUT.patternCount);
  assert.deepEqual([...new Set(differing)], [PATTERN.versionOffset + 3]);

  // And the decoded patterns agree on everything the version is not.
  for (let i = 0; i < DN1_LAYOUT.patternCount; i++) {
    const a = readPattern(older, i);
    const b = readPattern(newer, i);
    assert.equal(a.version, 10);
    assert.equal(b.version, 11);
    assert.deepEqual({ ...a, version: 0 }, { ...b, version: 0 }, `pattern ${i} decodes differently`);
  }
});

test("the songs read from the right offset on both firmwares", { skip }, () => {
  const older = stored142();
  const newer = imageFrom(parsePayload(driveRead(SAVED)));

  for (const image of [older, newer]) {
    const songs = readSongs(image);
    assert.equal(songs.length, TAIL.songCount);
    for (const song of songs) {
      assert.equal(song.version, SONG_VERSION, `song ${song.index} read from the wrong place`);
      assert.equal(song.tempo, 120);
    }
  }

  // Read at the older offset a 1.43 image would hand back the tail of the Outbox block, so the
  // 512-byte shift is what these records prove.
  assert.equal(readSongs(newer)[0]!.offset - readSongs(older)[0]!.offset, BOB_CONFIG.size);
});

// --- the over-read ----------------------------------------------------------------------------------

test("an unmigrated project read on 1.43 is sliced back to its real length", { skip }, () => {
  /*
   * The refusal the owner hit. The payload declares the newer size and the header says format
   * 0104, and the project inside is the one 1.42A saved. Trusting the declaration hands every
   * reader 512 bytes of another project's leftovers and a tail whose songs are 512 bytes early.
   */
  const payload = parsePayload(driveRead(UNMIGRATED));
  assert.equal(payload.formatVersion, "0104", "the instrument stamps its own build string");
  assert.equal(payload.storedLength, DN1_OS143_IMAGE_SIZE, "and over-reads by 512 bytes");

  const image = imageFrom(payload);
  assert.equal(image.length, DN1_IMAGE_SIZE, "sliced to where the terminator actually is");
  assert.equal(objectVersion(image), 12, "it is still the project 1.42A saved");
  assert.ok(endsWithTerminator(image));
  assert.deepEqual(checkDn1Image(image).problems, []);
  assert.deepEqual(checkDn1Tail(image).problems, []);
});

test("the over-read is byte for byte the project 1.42A stored", { skip }, () => {
  const older = stored142();
  const fromDevice = imageFrom(parsePayload(driveRead(UNMIGRATED)));
  assert.equal(fromDevice.length, older.length);

  let first = -1;
  for (let i = 0; i < older.length; i++) {
    if (older[i] !== fromDevice[i]) { first = i; break; }
  }
  assert.equal(first, -1, `the images differ at 0x${first.toString(16)}`);
});

test("an over-read project is summarised like any other Digitone 1 project", { skip }, () => {
  const image = imageFrom(parsePayload(driveRead(UNMIGRATED)));
  const device = deviceFor(image);
  assert.equal(device.kind, "dn1");
  assert.equal(device.summarise(image, 0).readable, true);
});

test("a 1.43 save is summarised like any other Digitone 1 project", { skip }, () => {
  const image = imageFrom(parsePayload(driveRead(SAVED)));
  const device = deviceFor(image);
  assert.equal(device.kind, "dn1");
  const summary = device.summarise(image, 0);
  assert.equal(summary.version, 11);
  assert.equal(summary.readable, true);
  assert.equal(summary.supported, true, "the layout is unchanged, so the record is rewritable");
});

// --- what is still refused --------------------------------------------------------------------------

test("a body with no terminator at either candidate is refused", { skip }, () => {
  // The read that stops early looks exactly like the read that was padded, apart from this.
  const raw = driveRead(SAVED);
  const body = raw.subarray(31, 31 + DN1_OS143_IMAGE_SIZE);
  const broken = Uint8Array.from(raw);
  broken.fill(0, 31 + body.length - 4, 31 + body.length);

  assert.throws(
    () => imageFrom(parsePayload(broken)),
    (error: unknown) => error instanceof ListingError && /BA CE F0 0C/.test((error as Error).message),
  );
});

test("a payload declaring a length neither firmware writes is refused", { skip }, () => {
  const raw = Uint8Array.from(driveRead(SAVED));
  new DataView(raw.buffer).setUint32(raw.length - 8, DN1_OS143_IMAGE_SIZE - 1, false);

  assert.throws(
    () => imageFrom(parsePayload(raw)),
    (error: unknown) =>
      error instanceof ListingError && /uncompressed image of this family/.test((error as Error).message),
  );
});

test("a truncated read is refused, and by whichever check sees it first", { skip }, () => {
  // Cut short at the end and the container catches it: there is no footer magic where one has to
  // be. That refusal is older than this change and stays where it is.
  assert.throws(() => parsePayload(driveRead(SAVED).subarray(0, 4096)), /footer magic/);

  // Cut short in the middle and the container is intact, so the body-length check is the one that
  // has to fire. Without it the read would be handed back 1,024 bytes short of what it declares.
  const raw = driveRead(SAVED);
  const short = new Uint8Array(raw.length - 1024);
  short.set(raw.subarray(0, 31 + 1_000_000), 0);
  short.set(raw.subarray(31 + 1_000_000 + 1024), 31 + 1_000_000);

  const payload = parsePayload(short);
  assert.equal(payload.storedLength, DN1_OS143_IMAGE_SIZE, "it still claims the full length");
  assert.throws(
    () => imageFrom(payload),
    (error: unknown) =>
      error instanceof ListingError && /bytes of image, expected/.test((error as Error).message),
  );
});
