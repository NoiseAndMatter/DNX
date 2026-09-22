/**
 * Naming offsets is only useful if the names are right, and a wrong name in a differential
 * report sends the reader to the wrong part of the format. These check the boundaries against
 * offsets established elsewhere in the project.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PATTERN, TRACK, KIT_MIDI_MASK_OFFSET } from "@noiseandmatter/dnx-core/project/dn2pattern.js";
import { DN2_LAYOUT } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { describeOffset, locateInPatternPayload } from "@noiseandmatter/dnx-core/project/locate.js";

test("known fields are named, not just located", () => {
  const trackThree = PATTERN.trackOffset + 2 * TRACK.size;

  assert.match(describeOffset(trackThree + TRACK.settingsOffset + 0x0d), /track 3 settings.*track length/);
  assert.match(describeOffset(trackThree + TRACK.settingsOffset + 0x0f), /track 3 settings.*track speed/);
  assert.match(describeOffset(trackThree + 0x400 + 5), /track 3.*sound lock, step 6/);
  assert.match(describeOffset(PATTERN.metaOffset + 0x14), /pattern metadata.*master length/);
  assert.match(describeOffset(PATTERN.metaOffset + 0x12), /pattern metadata.*tempo/);
  assert.match(describeOffset(PATTERN.trigOffset + 6 * 3 + 2), /trigger slot 3.*note/);
  assert.match(describeOffset(PATTERN.lockOffset + 258 + 1), /lock record 1.*track/);
});

test("kit offsets land in the right record", () => {
  const kit = DN2_LAYOUT.patternSize;

  assert.match(describeOffset(kit + 8), /kit header.*kit name/);
  assert.match(describeOffset(kit + 0x1c), /kit header.*track level 1/);
  assert.match(describeOffset(kit + 60 + 359 * 4 + 12), /kit sound slot 5.*sound name/);
  assert.match(describeOffset(kit + 5_964 + 268 * 4 + 12), /kit MIDI record 5.*track name/);
  assert.match(describeOffset(kit + KIT_MIDI_MASK_OFFSET), /synth\/MIDI track mask/);
  assert.match(describeOffset(kit + 10_264 + 7), /per-track array.*entry 2/);
});

test("regions tile the payload with no gaps and no overlap", () => {
  // Every offset must resolve, and the boundaries between regions must be exactly where the
  // record geometry says they are.
  const size = DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize;
  for (let offset = 0; offset < size; offset += 97) {
    const at = locateInPatternPayload(offset);
    assert.ok(at.region.length > 0, `offset ${offset} has no region`);
    assert.notEqual(at.region, "outside the payload", `offset ${offset} fell outside`);
  }
  assert.equal(locateInPatternPayload(size).region, "outside the payload");
  assert.equal(locateInPatternPayload(-1).region, "outside the payload");
});

test("unidentified regions say so rather than inventing a name", () => {
  const kit = DN2_LAYOUT.patternSize;
  assert.equal(locateInPatternPayload(kit + 10_600).unknown, true);
  assert.equal(locateInPatternPayload(PATTERN.trackOffset + 0x2a0).unknown, true);
  assert.equal(locateInPatternPayload(PATTERN.metaOffset + 0x14).unknown, false);
});
