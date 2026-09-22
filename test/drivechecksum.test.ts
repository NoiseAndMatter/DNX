/**
 * The +Drive write checksum.
 *
 * ## What was blocking, and what unblocked it
 *
 * Writing anything to a +Drive requires a checksum over the content, and the device validates it —
 * proved on hardware by flipping one bit and being told `Invalid package checksum; corrupt
 * transfer`. Until the algorithm was known we could write back only bytes the device had already
 * checksummed for us, which excludes every edited project and therefore every useful save.
 *
 * It is `crc32ZeroInit`: ordinary CRC-32 seeded with **zero** rather than all-ones. The same
 * function this repository already used for the project payload's check field — which is why the
 * answer was here the whole time and went unrecognised. The eleven forms previously tried were
 * tried as *whole algorithms*; the one that fits differs from `zlib.crc32` in a single parameter.
 *
 * ## What this test does and does not establish
 *
 * It establishes that we reproduce the device's arithmetic, against a capture: `/soundbanks/A/1`
 * read 345 bytes and the instrument reported `e48ff54e`.
 *
 * **It does not establish that the device accepts a checksum we computed for bytes it has never
 * seen** — which is the entire point of having the algorithm. That is a different kind of claim and
 * only the instrument can answer it. Until it does, treat this as verified against a capture and
 * not against a write.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";
import { driveChecksum } from "@noiseandmatter/dnx-core/device/storage.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

/** The captured read: 345 bytes off the author's Digitone 1, and the checksum it reported. */
const FIXTURE = "soundbank_A1_345B_e48ff54e.bin";
const REPORTED = 0xe48ff54e;

function captured(): Uint8Array {
  const path = join(CORPUS!, "..", "99_HardwareTest", FIXTURE);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — this test asserts nothing without the captured pair`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  // Named for its length, so a replaced or truncated file cannot pass by finding something else.
  assert.equal(bytes.length, 345, "the capture is not the one this test was written against");
  return bytes;
}

test("the checksum matches the one the instrument reported for the same bytes", { skip }, () => {
  assert.equal(driveChecksum(captured()), REPORTED);
});

test("it is sensitive to every byte, which is what makes it worth sending", { skip }, () => {
  // A checksum that missed a byte would still match the capture and silently pass corrupt content.
  const bytes = captured();
  for (const at of [0, 1, 172, 343, 344]) {
    const edited = Uint8Array.from(bytes);
    edited[at] = edited[at]! ^ 0x01;
    assert.notEqual(driveChecksum(edited), REPORTED, `flipping byte ${at} must change the checksum`);
  }
});

test("it is not zlib's CRC-32, which is why it took so long to find", () => {
  // The distinction in one line: same polynomial and final inversion, different seed. Anyone
  // reaching for a CRC-32 here should see immediately that the ordinary one does not fit.
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff);
  assert.notEqual(driveChecksum(bytes), 0xffffffff);
  // Empty input is where the seed shows plainly: zlib gives 0, this gives the inversion of zero.
  assert.equal(driveChecksum(new Uint8Array(0)), 0xffffffff);
});
