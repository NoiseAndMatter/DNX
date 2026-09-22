/**
 * Diffing two readings of the same project.
 *
 * The tool for locating the Digitone II's song table, which has never been found. The tests below
 * are mostly about the two ways a diff lies: **splitting one change into many** when a record has
 * unchanged bytes in the middle, and **reporting save bookkeeping as a discovery** when nobody took
 * a null-save control.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DN2_LAYOUT } from "@noiseandmatter/dnx-core/project/dn2image.js";
import {
  DiffError,
  changedRuns,
  diffImages,
  locate,
  subtractNoise,
  summarise,
} from "@noiseandmatter/dnx-core/project/imagediff.js";

function image(fill = 0): Uint8Array {
  return new Uint8Array(DN2_LAYOUT.imageSize).fill(fill);
}

test("identical images produce nothing", () => {
  const a = image();
  assert.deepEqual(changedRuns(a, Uint8Array.from(a)), []);
  assert.deepEqual(summarise([], DN2_LAYOUT), ["No bytes differ. The two images are identical."]);
});

test("two images of different sizes are refused rather than compared", () => {
  // Comparing a DN1 image against a DN2 one would produce a vast, meaningless diff.
  assert.throws(() => changedRuns(new Uint8Array(10), new Uint8Array(11)), DiffError);
});

test("a changed record is one region, not one per differing byte", () => {
  const a = image();
  const b = Uint8Array.from(a);
  const at = DN2_LAYOUT.tailBase + 0x2efc;
  for (let i = 0; i < 200; i++) b[at + i] = 0xab;

  const runs = changedRuns(a, b);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.from, at);
  assert.equal(runs[0]!.length, 200);
});

test("a short stretch of unchanged bytes does not split a region", () => {
  // A record whose middle field kept its value. Without a gap tolerance this reports as two
  // findings and reads as two structures.
  const a = image();
  const b = Uint8Array.from(a);
  const at = DN2_LAYOUT.tailBase + 1000;
  for (let i = 0; i < 40; i++) b[at + i] = 1;
  for (let i = 48; i < 90; i++) b[at + i] = 1; // an 8-byte hole

  assert.equal(changedRuns(a, b, 16).length, 1, "an 8-byte hole is inside the tolerance");
  assert.equal(changedRuns(a, b, 4).length, 2, "and outside a tighter one it is two");
});

test("a wide gap really is two regions", () => {
  const a = image();
  const b = Uint8Array.from(a);
  b[DN2_LAYOUT.tailBase + 100] = 1;
  b[DN2_LAYOUT.tailBase + 9000] = 1;
  assert.equal(changedRuns(a, b).length, 2);
});

test("noise from a null save is discounted", () => {
  const a = image();
  const b = Uint8Array.from(a);
  // A save counter somewhere in the header, and a song somewhere in the tail.
  b[12] = 9;
  const songAt = DN2_LAYOUT.tailBase + 0x3000;
  for (let i = 0; i < 64; i++) b[songAt + i] = 7;

  const noise = changedRuns(a, (() => { const n = Uint8Array.from(a); n[12] = 5; return n; })());
  const kept = subtractNoise(changedRuns(a, b), noise);

  assert.equal(kept.length, 1, "the counter is gone, the song is not");
  assert.equal(kept[0]!.from, songAt);
});

test("a change that merely overlaps noise is kept, not swallowed", () => {
  // The worst failure this tool could have: a real finding that begins inside a region the save
  // also touches, silently dropped. Overlap is not containment.
  const a = image();
  const b = Uint8Array.from(a);
  for (let i = 0; i < 400; i++) b[DN2_LAYOUT.tailBase + 100 + i] = 3;

  const noisy = Uint8Array.from(a);
  for (let i = 0; i < 50; i++) noisy[DN2_LAYOUT.tailBase + 100 + i] = 4;
  const noise = changedRuns(a, noisy);

  const kept = subtractNoise(changedRuns(a, b), noise);
  assert.equal(kept.length, 1, "a 400-byte change overlapping 50 bytes of noise must survive");
});

test("an offset is reported in the words the format documents use", () => {
  assert.deepEqual(locate(4, DN2_LAYOUT), { where: "image header", offsetInRegion: 4 });

  const pattern3 = DN2_LAYOUT.headerSize + 3 * DN2_LAYOUT.patternSize + 17;
  assert.deepEqual(locate(pattern3, DN2_LAYOUT), { where: "pattern 3", offsetInRegion: 17 });

  const kit5 = DN2_LAYOUT.kitBase + 5 * DN2_LAYOUT.kitSize + 8;
  assert.deepEqual(locate(kit5, DN2_LAYOUT), { where: "kit 5", offsetInRegion: 8 });

  // The tail's interior is only partly identified, so it is reported as an offset rather than
  // dressed up as a structure we have not established.
  assert.deepEqual(locate(DN2_LAYOUT.tailBase + 0x2efc, DN2_LAYOUT), {
    where: "tail +0x2efc",
    offsetInRegion: 0x2efc,
  });
});

test("the summary says out loud when the experiment was not clean", () => {
  // A change in a pattern means the instrument was touched somewhere else too, and a tail hunt
  // reading that diff would be reading two experiments at once.
  const a = image();
  const b = Uint8Array.from(a);
  b[DN2_LAYOUT.headerSize + 2 * DN2_LAYOUT.patternSize] = 1;
  b[DN2_LAYOUT.tailBase + 500] = 1;

  const lines = summarise(diffImages(a, b), DN2_LAYOUT).join(" ");
  assert.match(lines, /NOT a clean experiment/);
  assert.match(lines, /pattern 2/);
});

test("a tail-only diff reports its span, which is what a table hunt needs", () => {
  const a = image();
  const b = Uint8Array.from(a);
  b[DN2_LAYOUT.tailBase + 0x1000] = 1;
  b[DN2_LAYOUT.tailBase + 0x4000] = 1;

  const lines = summarise(diffImages(a, b), DN2_LAYOUT).join(" ");
  assert.doesNotMatch(lines, /NOT a clean experiment/);
  assert.match(lines, /\+0x1000 to \+0x4001/);
});
