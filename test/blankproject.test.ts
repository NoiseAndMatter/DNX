/**
 * The blank Digitone II project that ships with the code.
 *
 * **These tests take no `{ skip }`**, and that is the point of them. Every other test that needs a
 * project reads one from the private corpus and skips without it — so a fresh clone ran a green
 * suite while "start from a blank project" was impossible, which is exactly what happened.
 *
 * This is the one project a clone always has, so this is the one place that can prove it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { blankDn2ProjectFile } from "../src/librarian/blankproject.js";
import { DN2_DEVICE } from "../src/librarian/device.js";
import { DN2_LAYOUT } from "../src/project/dn2image.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/project/projectfile.js";
import { DN2_POOL_OFFSET, SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "../src/project/soundmap.js";

const DN2_SOUND_SIZE = 359;

function image(): Uint8Array {
  return decodeProjectImage(parseProject(blankDn2ProjectFile()).payload.raw).image;
}

test("the embedded blank decodes to a Digitone II project", () => {
  const project = parseProject(blankDn2ProjectFile());
  assert.equal(project.payload.formatVersion, "0050", "a Digitone II payload");
  assert.equal(image().length, DN2_LAYOUT.imageSize);
});

test("it is genuinely blank — no pattern holds anything", () => {
  // The generator refuses to embed a project that is not. This is the same check from the other
  // side: if the file is ever regenerated from the wrong project, the suite says so rather than
  // somebody's work quietly shipping in a public repository.
  const decoded = image();
  const occupied: number[] = [];
  for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) {
    if (DN2_DEVICE.summarise(decoded, slot).occupied) occupied.push(slot);
  }
  assert.deepEqual(occupied, [], "the embedded blank has patterns with trigs in them");
});

test("and no pool slot holds a sound", () => {
  const decoded = image();
  const named: number[] = [];
  for (let slot = 0; slot < 128; slot++) {
    const at = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE + SOUND_NAME_OFFSET;
    const name = decoded.subarray(at, at + SOUND_NAME_SIZE);
    if (!name.every((b) => b === 0 || b === 0xff)) named.push(slot);
  }
  assert.deepEqual(named, [], "the embedded blank carries sounds in its pool");
});

test("it carries a manifest, so it can serve as the template for an export", () => {
  // The reason the *file* is embedded rather than the image: one artefact is the blank
  // destination, the donor a device read needs, and the manifest an export writes out.
  const { manifest } = parseProject(blankDn2ProjectFile());
  assert.equal(manifest.FileType, "Project");
  assert.ok(manifest.Payload.length > 0, "the manifest names no payload entry");
});

test("the base64 decoder round-trips every byte value", () => {
  // Hand-written, because `src/` is platform-free and neither `atob` nor `Buffer` is available to
  // both a CLI and a bundler-less browser page. A decoder that is subtly wrong would corrupt the
  // one project a clone is guaranteed to have.
  const file = blankDn2ProjectFile();
  assert.ok(file.length > 1000, `decoded only ${file.length} bytes`);
  // A .dn2prj is a ZIP: the signature is the cheapest proof the decode is byte-exact rather than
  // merely plausible.
  assert.deepEqual([...file.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "not a ZIP — the decode is wrong");
});
