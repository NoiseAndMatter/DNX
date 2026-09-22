/**
 * Digitone II projects written by OS 1.11.
 *
 * 1.11 appended 512 bytes to the project image and moved nothing before them, and it upgraded
 * every stored project on the instrument it was installed on. DNX recognised an image by one exact
 * size per family, so on that instrument it opened nothing: every read ended in "this looks
 * compressed". These tests are the second size, accepted everywhere the first one was.
 *
 * The corpus half reads a real 1.11 project and the 1.10E copy of the same project, because a
 * synthetic 1.11 image would be built from the same understanding it was meant to check.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN2_IMAGE_SIZE, DN2_OS111_IMAGE_SIZE, decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { DN1_LAYOUT, DN2_LAYOUT, fitsLayout, layoutFor } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { parsePayload } from "@noiseandmatter/dnx-core/project/container.js";
import { parseProject } from "../src/node/projectfile.js";
import { buildPayload } from "@noiseandmatter/dnx-core/project/write.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import { planChangedRecords } from "@noiseandmatter/dnx-core/device/deviceproject.js";
import { imageFrom } from "@noiseandmatter/dnx-core/device/drive.js";
import { CORPUS } from "./corpus.js";

// --- the sizes, without a device ----------------------------------------------------------------------

test("one Digitone II layout describes both firmwares, because 1.11 only appends", () => {
  assert.equal(DN2_OS111_IMAGE_SIZE - DN2_IMAGE_SIZE, 512);
  assert.equal(layoutFor(new Uint8Array(DN2_IMAGE_SIZE)), DN2_LAYOUT);
  assert.equal(layoutFor(new Uint8Array(DN2_OS111_IMAGE_SIZE)), DN2_LAYOUT,
    "a 1.11 image is a Digitone II image, at the same offsets");
});

test("a size neither firmware writes is still refused", () => {
  // Accepting a second size is not accepting any size. A read cut short by another application on
  // the port is the likeliest source of an odd length, and it must not decode as a project.
  assert.throws(() => layoutFor(new Uint8Array(DN2_OS111_IMAGE_SIZE + 1)), /Unrecognised/);
  assert.throws(() => layoutFor(new Uint8Array(DN2_IMAGE_SIZE - 512)), /Unrecognised/);
  assert.equal(fitsLayout(new Uint8Array(DN2_OS111_IMAGE_SIZE), DN1_LAYOUT), false);
});

test("the device write's diff accepts two readings of a 1.11 project", () => {
  // It used to compare against the one size and refuse, which would have stopped every write-back
  // to a 1.11 instrument before it began.
  const before = new Uint8Array(DN2_OS111_IMAGE_SIZE);
  const after = Uint8Array.from(before);
  const plan = planChangedRecords(before, after, DN2_LAYOUT);
  assert.deepEqual(plan.changed, [], "nothing edited, nothing to send");
});

// --- a real 1.11 project against the 1.10E copy of itself ------------------------------------------------

const EVIDENCE = CORPUS && join(CORPUS, "..", "99_HardwareTest", "projects_4_SKETCHPAD_os1.11_stored_139736B.bin");
const OLDER = CORPUS && join(CORPUS, "..", "01_Backup", "01_Projects", "DN2", "004 SKETCHPAD.dn2prj");
const skip = !(EVIDENCE && OLDER && existsSync(EVIDENCE) && existsSync(OLDER)) &&
  "needs the 1.11 SKETCHPAD read and its 1.10E copy in the private corpus";

function os111(): { bytes: Uint8Array; image: Uint8Array } {
  const bytes = new Uint8Array(readFileSync(EVIDENCE!));
  return { bytes, image: decodeProjectImage(bytes).image };
}

function os110e(): Uint8Array {
  const project = parseProject(new Uint8Array(readFileSync(OLDER!)));
  return decodeProjectImage(project.payload.raw).image;
}

test("a project read off a 1.11 instrument is format 0059 and 512 bytes longer", { skip }, () => {
  const { bytes, image } = os111();
  assert.equal(parsePayload(bytes).formatVersion, "0059");
  assert.equal(image.length, DN2_OS111_IMAGE_SIZE);
  assert.equal(layoutFor(image), DN2_LAYOUT);
});

test("everything before the appended 512 bytes is the 1.10E project, byte for byte", { skip }, () => {
  /*
   * **The claim the whole change rests on.** If 1.11 had moved anything, one layout could not
   * describe both and every offset in this codebase would be wrong for half the instruments. It
   * did not: header, patterns, kits and tail all match the older copy of the same project.
   */
  const newer = os111().image;
  const older = os110e();
  assert.equal(older.length, DN2_IMAGE_SIZE);

  let first = -1;
  for (let i = 0; i < older.length; i++) {
    if (older[i] !== newer[i]) { first = i; break; }
  }
  assert.equal(first, -1, `the images differ at 0x${first.toString(16)}, inside the part 1.11 kept`);
});

test("the appended block holds two new version-2 objects, where they were measured", { skip }, () => {
  const image = os111().image;
  const found: string[] = [];
  for (let i = DN2_IMAGE_SIZE; i + 8 <= image.length; i++) {
    if (image[i] === 0xbe && image[i + 1] === 0xef && image[i + 2] === 0xba && image[i + 3] === 0xce) {
      const version = ((image[i + 4]! << 24) | (image[i + 5]! << 16) | (image[i + 6]! << 8) | image[i + 7]!) >>> 0;
      found.push(`0x${i.toString(16)} v${version}`);
    }
  }
  assert.deepEqual(found, ["0xc4ae6f v2", "0xc4afd6 v2"]);
});

test("the 512 bytes survive being written back out", { skip }, () => {
  /*
   * A reader that accepts 1.11 and a writer that drops what it does not understand would be worse
   * than refusing: the project would open, save, and lose its Outbox settings without a word.
   */
  const { bytes, image } = os111();
  const rebuilt = decodeProjectImage(buildPayload(bytes, image)).image;
  assert.equal(rebuilt.length, DN2_OS111_IMAGE_SIZE);
  assert.ok(rebuilt.every((b, i) => b === image[i]), "the rebuilt image is the image");
});

test("a 1.11 project is summarised like any other Digitone II project", { skip }, () => {
  const image = os111().image;
  const device = deviceFor(image);
  assert.equal(device.kind, "dn2");
  assert.equal(device.summarise(image, 0).readable, true, "pattern A1 reads");
});

test("a +Drive read is told apart from a compressed file by either size", { skip }, () => {
  // The raw form of a +Drive read declares the image size in its header. Build that shape from the
  // real image so `imageFrom` sees a 1.11 declaration, then check it hands the image straight back.
  const { bytes, image } = os111();
  const header = bytes.subarray(0, 31);
  const raw = new Uint8Array(31 + image.length + 12);
  raw.set(header, 0);
  raw.set(image, 31);
  raw[29] = 0x00; // uncompressed, as a +Drive raw read says
  const view = new DataView(raw.buffer);
  view.setUint32(raw.length - 8, image.length, false);
  raw.set(bytes.subarray(bytes.length - 4), raw.length - 4);

  const payload = parsePayload(raw);
  if (payload.storedLength !== DN2_OS111_IMAGE_SIZE) {
    // The header's length field is not where this test assumed. Say so rather than pass vacuously.
    assert.fail(`built a raw payload declaring ${payload.storedLength}, not ${DN2_OS111_IMAGE_SIZE}`);
  }
  assert.equal(imageFrom(payload).length, DN2_OS111_IMAGE_SIZE);
});
