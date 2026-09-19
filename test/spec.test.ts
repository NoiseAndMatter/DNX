/**
 * The device specs, and the facts that used to be written down twice.
 *
 * Most of this is not testing arithmetic — it is testing that **one fact has one home**. Every
 * assertion below pairs the spec against a constant that formerly held the same number in another
 * module, so if anyone reintroduces a second copy and edits one of them, this says so.
 *
 * That is not a hypothetical failure mode here. Two copies of the message-id scheme sat in separate
 * modules for weeks and cost a crossed reply on hardware — a directory request answered by a file
 * open — which is exactly what "they had not drifted yet" buys you.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DN1_SPEC, DN2_SPEC, SPECS, poolBase, poolSlotAt } from "../src/project/spec.js";
import { DN1_DEVICE, DN2_DEVICE } from "../src/librarian/device.js";
import { DN1_KIT, DN1_LAYOUT, DN2_KIT, DN2_LAYOUT } from "../src/project/dn2image.js";
import {
  DN1_POOL_OFFSET,
  DN1_SOUND_SIZE,
  DN2_POOL_OFFSET,
  DN2_SOUND_SIZE,
  POOL_SOUND_COUNT,
} from "../src/project/soundmap.js";
import { SOUND_SIZE as DN1_SOUND_SIZE_FROM_DN1 } from "../src/project/dn1.js";
import { KIT_NAME_OFFSET } from "../src/librarian/kitwrite.js";

test("a device reports the spec it is built from", () => {
  // The fields on `Device` are conveniences read off the spec. If they were ever set independently
  // the two could disagree, and every caller would get whichever one it happened to reach for.
  for (const [device, spec] of [
    [DN1_DEVICE, DN1_SPEC],
    [DN2_DEVICE, DN2_SPEC],
  ] as const) {
    assert.equal(device.spec, spec);
    assert.equal(device.kind, spec.kind);
    assert.equal(device.name, spec.name);
    assert.equal(device.layout, spec.layout);
    assert.equal(device.patternVersion, spec.pattern.version);
    assert.equal(device.slotIndexOffset, spec.pattern.slotIndexOffset);
    assert.equal(device.patternNameOffset, spec.pattern.nameOffset);
    assert.equal(device.patternCount, spec.layout.patternCount);
    assert.equal(device.synthTrackCount, spec.synthTrackCount);
    assert.equal(device.stepCount, spec.stepCount);
    assert.equal(device.hasKits, spec.hasKits);
  }
});

test("the sound size agrees wherever it is named", () => {
  // Three names for one number before the spec: `SOUND_SIZE` in dn1.ts, `DN1_SOUND_SIZE` in
  // soundmap.ts, and the size a pool slot is measured in.
  assert.equal(DN1_SPEC.sound.size, DN1_SOUND_SIZE);
  assert.equal(DN1_SPEC.sound.size, DN1_SOUND_SIZE_FROM_DN1);
  assert.equal(DN2_SPEC.sound.size, DN2_SOUND_SIZE);
  assert.equal(DN1_SPEC.sound.size, 302);
  assert.equal(DN2_SPEC.sound.size, 359);
});

test("a kit's name has one address", () => {
  // This is the one that was written in two *shapes*: a bare 8 in kitwrite.ts and a record keyed by
  // device kind in blank.ts. Two shapes is worse than two copies — they do not even look alike.
  assert.equal(KIT_NAME_OFFSET, DN2_SPEC.kit.nameOffset);
  assert.equal(DN2_SPEC.kit.nameOffset, 8, "BEEFBACE + u32be version");
  assert.equal(DN1_SPEC.kit.nameOffset, 4, "u32be version, no magic");
  assert.equal(DN1_SPEC.kit.nameSize, DN2_SPEC.kit.nameSize);
});

test("the pool arithmetic is the one both librarians use", () => {
  // `poolBase` and `poolSlotAt` replaced a `geometryFor` that existed byte-for-byte identically in
  // poolwrite.ts and poolaudit.ts. An audit and a write disagreeing about where the pool is would
  // be a corrupted project.
  assert.equal(poolBase(DN1_SPEC), DN1_LAYOUT.tailBase + DN1_POOL_OFFSET);
  assert.equal(poolBase(DN2_SPEC), DN2_LAYOUT.tailBase + DN2_POOL_OFFSET);

  assert.equal(poolSlotAt(DN2_SPEC, 0), poolBase(DN2_SPEC));
  assert.equal(poolSlotAt(DN2_SPEC, 3), poolBase(DN2_SPEC) + 3 * DN2_SOUND_SIZE);
  // The last slot has to fit inside the image, or a write past it corrupts whatever follows.
  const last = poolSlotAt(DN2_SPEC, POOL_SOUND_COUNT - 1) + DN2_SPEC.sound.size;
  assert.ok(last <= DN2_LAYOUT.imageSize, `the pool ends at ${last}, past the image`);
});

test("the synth track count comes from the kit that holds them", () => {
  // Four sound slots in a DN1 kit and sixteen in a DN2's — the count was a literal on `Device`
  // beside a kit record that already said so.
  assert.equal(DN1_SPEC.synthTrackCount, DN1_KIT.soundCount);
  assert.equal(DN2_SPEC.synthTrackCount, DN2_KIT.soundCount);
  assert.equal(DN1_SPEC.synthTrackCount, 4);
  assert.equal(DN2_SPEC.synthTrackCount, 16);
});

test("only the Digitone II has kits", () => {
  // Not a naming difference: it is why the DN1's +Drive has no /kits directory, and why several
  // operations refuse it outright rather than producing an empty result.
  assert.equal(DN1_SPEC.hasKits, false);
  assert.equal(DN2_SPEC.hasKits, true);
});

test("there are two specs, and they describe different machines", () => {
  // DNX is for Digitones. This is not a plug-in point for a third device — the Digitakt II shares a
  // storage family with the DN2 and is deliberately out of scope.
  assert.equal(SPECS.length, 2);
  assert.deepEqual(SPECS.map((s) => s.kind), ["dn1", "dn2"]);

  // And nothing in one spec is accidentally the other's: every number below differs.
  assert.notEqual(DN1_SPEC.sound.size, DN2_SPEC.sound.size);
  assert.notEqual(DN1_SPEC.sound.poolOffset, DN2_SPEC.sound.poolOffset);
  assert.notEqual(DN1_SPEC.layout.kitSize, DN2_SPEC.layout.kitSize);
  assert.notEqual(DN1_SPEC.stepCount, DN2_SPEC.stepCount);
});
