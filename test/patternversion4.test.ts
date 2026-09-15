/**
 * Pattern records OS 1.11 sends as storage version 4.
 *
 * Found by the release test run: Open device showed every pattern of the loaded project as
 * "v4 unreadable version". The record is the version-3 size and parses as version 3, so it is now
 * read with that layout and kept out of every operation that writes.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PATTERN, RECORD_VERSION, TRACK_SIZE_BY_VERSION, asVersion3, recordVersion } from "../src/project/dn2pattern.js";
import { DN2_LAYOUT } from "../src/project/dn2image.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { deviceFor } from "../src/librarian/device.js";
import { CORPUS } from "./corpus.js";

test("version 4 is read with the version-3 track size", () => {
  assert.equal(TRACK_SIZE_BY_VERSION[4], TRACK_SIZE_BY_VERSION[RECORD_VERSION]);
});

test("normalising a version-4 record changes only its version field", () => {
  /*
   * **The trap this guards.** The re-pack for narrower versions writes four settings bytes at the end
   * of each track's shorter block. At equal width that position is the start of the next track, so a
   * version-4 record run through the version-2 path came back with every later track's first four
   * bytes overwritten.
   */
  const record = new Uint8Array(DN2_LAYOUT.patternSize);
  for (let i = 0; i < record.length; i++) record[i] = (i * 31 + 7) & 0xff;
  new DataView(record.buffer).setUint32(PATTERN.versionOffset, 4, false);

  const normalised = asVersion3(record);
  assert.equal(recordVersion(normalised), RECORD_VERSION);
  assert.equal(recordVersion(record), 4, "the caller's record still says what was sent");
  const moved = [...normalised.keys()].filter((i) => normalised[i] !== record[i]);
  assert.ok(moved.every((i) => i < 4), `bytes outside the version field changed: ${moved.filter((i) => i >= 4).slice(0, 8)}`);
});

// --- the record captured off the instrument -------------------------------------------------------------

const DUMP = CORPUS && join(CORPUS, "..", "99_HardwareTest", "dump_A1_patternkit_os1.11_factory.bin");
const TEMPLATE = CORPUS && join(CORPUS, "02_DN2", "01_Projects", "004 SKETCHPAD.dn2prj");
const skip = !(DUMP && TEMPLATE && existsSync(DUMP) && existsSync(TEMPLATE)) &&
  "needs the version-4 A1 captured from factory OS 1.11 in the private corpus";

test("A1 of factory PRESETS, as OS 1.11 sends it, reads and stays unwritable", { skip }, () => {
  const dump = new Uint8Array(readFileSync(DUMP!));
  assert.equal(dump.length, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize);
  assert.equal(recordVersion(dump.subarray(0, DN2_LAYOUT.patternSize)), 4);

  const image = decodeProjectImage(parseProject(new Uint8Array(readFileSync(TEMPLATE!))).payload.raw).image;
  image.set(dump.subarray(0, DN2_LAYOUT.patternSize), DN2_LAYOUT.headerSize);
  image.set(dump.subarray(DN2_LAYOUT.patternSize), DN2_LAYOUT.kitBase);

  const summary = deviceFor(image).summarise(image, 0);
  assert.equal(summary.readable, true);
  assert.equal(summary.supported, false, "read, never written");
  assert.equal(summary.name, "LIGHTHOUSE");
  assert.equal(summary.trigCount, 199);
});
