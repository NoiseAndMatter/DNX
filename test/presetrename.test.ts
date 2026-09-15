/**
 * Renaming a preset stored on the +Drive, without the device.
 *
 * The write itself goes through `safeWriteFile` like every other write. What is tested here is the
 * part only this feature owns: that the file sent back is the file that was read, with sixteen bytes
 * of name changed and nothing else, in a form the instrument accepts.
 *
 * The corpus half uses a real stored preset read off a Digitone II on OS 1.11, so the header, the
 * prefix and the compression are the instrument's rather than this test's idea of them.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PresetRenameError, renamePresetFile, storedPresetName } from "../src/device/presetrename.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { buildPayload } from "../src/project/write.js";
import { parsePayload } from "../src/project/container.js";
import { isCheckValid } from "../src/project/checksum.js";
import { CORPUS } from "./corpus.js";

/** A stored preset built the way the device lays one out: prefix, then a named sound object. */
function syntheticStored(name: string): Uint8Array {
  const object = new Uint8Array(359);
  object.set([0xbe, 0xef, 0xba, 0xce, 0, 0, 0, 2], 0);
  for (let i = 0; i < name.length; i++) object[12 + i] = name.charCodeAt(i);
  for (let i = 28; i < object.length; i++) object[i] = (i * 7) & 0x7f; // parameters, not zero
  const body = new Uint8Array(5 + object.length);
  body.set([0, 0, 0, 2, 0], 0);
  body.set(object, 5);

  const source = new Uint8Array(31 + 12);
  source.set([0xac, 0x11, 0xd3, 0x03, 2, 0, 5, 0, 15, 0x30, 0x30, 0x35, 0x39], 0);
  source[23] = 7; // bank H
  source[24] = 128; // slot 129
  source.set([0, 0, 1, 0x6c], 25); // the uncompressed body length, as the device writes it
  source[30] = 0x0c;
  return buildPayload(source, body);
}

function nameBytes(stored: Uint8Array): number[] {
  return [...decodeProjectImage(stored).image.subarray(5 + 12, 5 + 28)];
}

test("a rename changes the sixteen name bytes and nothing else in the body", () => {
  const stored = syntheticStored("BD 1 BR");
  const renamed = renamePresetFile(stored, "KICK DEEP");

  assert.equal(renamed.from, "BD 1 BR");
  assert.equal(renamed.to, "KICK DEEP");
  assert.equal(renamed.changed, true);

  const before = decodeProjectImage(stored).image;
  const after = decodeProjectImage(renamed.bytes).image;
  assert.equal(after.length, before.length);
  const moved = [...after.keys()].filter((i) => after[i] !== before[i]);
  assert.ok(moved.every((i) => i >= 17 && i < 33), `bytes outside the name moved: ${moved.filter((i) => i < 17 || i >= 33)}`);
  assert.equal(storedPresetName(renamed.bytes), "KICK DEEP");
});

test("the name is zero-padded, as every named sound in the corpus is", () => {
  const renamed = renamePresetFile(syntheticStored("A LONGER NAME 16"), "HAT");
  assert.deepEqual(nameBytes(renamed.bytes), [0x48, 0x41, 0x54, ...new Array(13).fill(0)]);
});

test("the header survives, so the instrument's own bank, slot and length stay true", () => {
  const stored = syntheticStored("PAD");
  const renamed = renamePresetFile(stored, "PAD TWO").bytes;
  assert.deepEqual([...renamed.subarray(0, 31)], [...stored.subarray(0, 31)]);
  assert.equal(renamed[29], 0x01, "stored form, which is the only form a write accepts");
  assert.ok(isCheckValid(renamed), "the trailer's check field covers the new chain");
  assert.equal(parsePayload(renamed).storedLength, renamed.length - 43);
});

test("what is typed is normalised the way a pattern name is, and the page is told", () => {
  const renamed = renamePresetFile(syntheticStored("OLD"), "  a much too long preset name ");
  assert.equal(renamed.to, "A MUCH TOO LONG");
  assert.ok(renamed.notes.some((n) => /upper-cased/.test(n)));
  assert.ok(renamed.notes.some((n) => /truncated/.test(n)));
});

test("the same name is not a write", () => {
  const stored = syntheticStored("SAME");
  const renamed = renamePresetFile(stored, "same");
  assert.equal(renamed.changed, false);
  assert.equal(renamed.bytes, stored, "nothing rebuilt, nothing to send");
});

test("an empty name is refused, because an empty name is how a free pool slot is recognised", () => {
  assert.throws(() => renamePresetFile(syntheticStored("KEEP"), "   "), PresetRenameError);
});

test("a raw-form read is refused before anything is built", () => {
  const raw = Uint8Array.from(syntheticStored("RAW"));
  raw[29] = 0x00;
  assert.throws(() => renamePresetFile(raw, "X"), /not a stored-form preset/);
});

// --- a real stored preset off a Digitone II -----------------------------------------------------------

const REAL = CORPUS && join(CORPUS, "..", "99_HardwareTest", "soundbanks_H_1_stored_267B.bin");
const skip = !(REAL && existsSync(REAL)) && "needs the stored /soundbanks/H/1 read in the private corpus";

test("a real stored preset renames, and decodes to its own body with only the name changed", { skip }, () => {
  const stored = new Uint8Array(readFileSync(REAL!));
  assert.equal(stored.length, 267);
  assert.equal(storedPresetName(stored), "BD 1 BR");

  const renamed = renamePresetFile(stored, "BD 1 RENAMED");
  const before = decodeProjectImage(stored).image;
  const after = decodeProjectImage(renamed.bytes).image;
  assert.equal(before.length, 364);
  const moved = [...after.keys()].filter((i) => after[i] !== before[i]);
  assert.ok(moved.length > 0 && moved.every((i) => i >= 17 && i < 33), `moved outside the name: ${moved}`);
  assert.deepEqual([...renamed.bytes.subarray(0, 29)], [...stored.subarray(0, 29)], "bank, slot and length kept");
  assert.ok(isCheckValid(renamed.bytes));
});

// --- a real stored preset off a Digitone 1 --------------------------------------------------------------

const DN1_REAL = CORPUS && join(CORPUS, "..", "99_HardwareTest", "soundbanks_A_1_dn1_stored_266B.bin");
const skipDn1 = !(DN1_REAL && existsSync(DN1_REAL)) &&
  "needs the stored Digitone 1 /soundbanks/A/1 from the 2026-09-15 backup in the private corpus";

test("a Digitone 1 stored preset renames the same way, with no prefix in front of its sound", { skip: skipDn1 }, () => {
  /*
   * **The library connected to a Digitone II only**, so this had never run on a Digitone 1 file. Its
   * body is the 302-byte sound object with nothing in front, so the name is at +12 of the body where a
   * Digitone II's is at +17, and the rename must move bytes there and nowhere else.
   */
  const stored = new Uint8Array(readFileSync(DN1_REAL!));
  assert.equal(stored.length, 266);
  assert.equal(storedPresetName(stored), "DIGIT-ONE");

  const renamed = renamePresetFile(stored, "DNX DN1 TEST");
  const before = decodeProjectImage(stored).image;
  const after = decodeProjectImage(renamed.bytes).image;
  assert.equal(before.length, 302);
  const moved = [...after.keys()].filter((i) => after[i] !== before[i]);
  assert.ok(moved.length > 0 && moved.every((i) => i >= 12 && i < 28), `moved outside the name: ${moved}`);
  assert.deepEqual([...renamed.bytes.subarray(0, 29)], [...stored.subarray(0, 29)], "bank, slot and length kept");
  assert.ok(isCheckValid(renamed.bytes));
});
