/**
 * DN2 image and kit geometry.
 *
 * **Written because the numbers had six homes and two of them disagreed.** The track level is a
 * u16le container, and `sheet/collect.ts` read the pair while `librarian/tracksummary.ts` read the
 * low byte. Levels are 0-127, so the high byte is always zero and both answers matched — the
 * divergence was invisible and would have stayed invisible until a value above 255.
 *
 * These tests do two jobs: hold the geometry against the corpus, and hold the accessors against
 * each other. Neither can drift now without a red test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DN2_KIT,
  DN2_LAYOUT,
  kitRecord,
  setTrackLevel,
  trackLevel,
} from "../src/project/dn2image.js";
import { DN2_SOUND_SIZE } from "../src/project/soundmap.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/project/projectfile.js";
import { blankDn2ProjectFile } from "../src/librarian/blankproject.js";
import { NO_CORPUS, SKIP_REASON, corpusFiles } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;

/** The one project every clone has, so the geometry tests never depend on the corpus. */
function blank(): Uint8Array {
  return decodeProjectImage(parseProject(blankDn2ProjectFile()).payload.raw).image;
}

test("the kit's regions fit inside a kit record, in order", () => {
  assert.equal(DN2_KIT.soundOffset, DN2_KIT.headerSize, "sounds must start where the header ends");
  assert.ok(DN2_KIT.levelOffset + DN2_KIT.levelCount * DN2_KIT.levelSize <= DN2_KIT.headerSize,
    "the levels do not fit in the kit header");
  assert.equal(
    DN2_KIT.soundOffset + DN2_KIT.soundCount * DN2_KIT.soundSize,
    5964 - 160,
    "the 160 unidentified bytes before the MIDI records changed size",
  );
  assert.ok(
    DN2_KIT.midiOffset + DN2_KIT.midiCount * DN2_KIT.midiSize <= DN2_LAYOUT.kitSize,
    "the MIDI records run past the end of a kit",
  );
  assert.equal(DN2_KIT.trailingOffset, DN2_KIT.midiOffset + DN2_KIT.midiCount * DN2_KIT.midiSize);
});

test("one sound size, not two", () => {
  // `soundmap.ts` owns the sound object; `dn2image.ts` owns the kit that holds sixteen of them.
  // Two homes for the number is how the six re-declarations started.
  assert.equal(DN2_KIT.soundSize, DN2_SOUND_SIZE);
});

test("a level round-trips through the accessors", () => {
  const kit = new Uint8Array(DN2_LAYOUT.kitSize);
  setTrackLevel(kit, 0, 127);
  setTrackLevel(kit, 15, 100);
  assert.equal(trackLevel(kit, 0), 127);
  assert.equal(trackLevel(kit, 15), 100);
  // Writing one track must not touch its neighbour — the levels are adjacent u16s.
  assert.equal(trackLevel(kit, 1), 0);
});

test("the accessor reads both bytes, which is what settled the disagreement", () => {
  // The low-byte reader would answer 0x34 here. No corpus project reaches this value, which is
  // exactly why the two implementations agreed for as long as they did.
  const kit = new Uint8Array(DN2_LAYOUT.kitSize);
  kit[DN2_KIT.levelOffset] = 0x34;
  kit[DN2_KIT.levelOffset + 1] = 0x12;
  assert.equal(trackLevel(kit, 0), 0x1234);
});

test("a track outside the kit is refused, not read", () => {
  const kit = new Uint8Array(DN2_LAYOUT.kitSize);
  assert.throws(() => trackLevel(kit, DN2_KIT.levelCount), /track/);
  assert.throws(() => setTrackLevel(kit, -1, 0), /track/);
});

test("the blank project's levels read as sane values", () => {
  // No corpus needed: the embedded blank is the one project a fresh clone always has.
  const kit = kitRecord(blank(), 0, DN2_LAYOUT);
  for (let track = 0; track < DN2_KIT.levelCount; track++) {
    const level = trackLevel(kit, track);
    assert.ok(level >= 0 && level <= 127, `track ${track + 1} reads ${level}, outside 0-127`);
  }
});

test("every level in the corpus fits in one byte, and none of it needs two", { skip }, () => {
  // The evidence behind `DN2_KIT.levelSize`. The field is two bytes wide and the device has never
  // filled the second one — both facts matter, and only the first is visible in the format.
  let read = 0;
  let highByteSet = 0;
  let max = 0;

  for (const path of corpusFiles("02_DN2/01_Projects", ".dn2prj")) {
    const image = decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
    for (let pattern = 0; pattern < DN2_LAYOUT.patternCount; pattern++) {
      const kit = kitRecord(image, pattern, DN2_LAYOUT);
      for (let track = 0; track < DN2_KIT.levelCount; track++) {
        const level = trackLevel(kit, track);
        read++;
        if (kit[DN2_KIT.levelOffset + track * DN2_KIT.levelSize + 1] !== 0) highByteSet++;
        if (level > max) max = level;
      }
    }
  }

  assert.ok(read > 0, "no DN2 projects in the corpus — this test proved nothing");
  assert.equal(highByteSet, 0, `${highByteSet} of ${read} levels use the high byte`);
  assert.ok(max <= 127, `a level reads ${max}, above the device's 0-127 range`);
});
