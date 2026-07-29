import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildMessage, parseFile } from "../src/sysex/container.js";
import { ProductId } from "../src/sysex/devices.js";
import { DN1_LAYOUT, DN2_LAYOUT, patternRecord, kitRecord, projectId } from "../src/project/dn2image.js";
import { DN2_POOL_OFFSET, POOL_SOUND_COUNT } from "../src/project/soundmap.js";
import { SAVED_PATTERN_OFFSET, SAVED_TRACK_OFFSET } from "../src/project/position.js";
import {
  PLACEMENTS,
  RebuildError,
  applyRebuild,
  coverage,
  planRebuild,
  verifyRebuild,
} from "../src/project/rebuild.js";

const DN2 = PLACEMENTS[ProductId.DN2]!;
const DN1 = PLACEMENTS[ProductId.DN1]!;

/** A synthetic capture: `count` records of one type, each filled with a recognisable byte. */
function capture(
  dumpType: number,
  count: number,
  size: number,
  fill: (index: number) => number,
  productId: number = ProductId.DN2,
): ReturnType<typeof parseFile> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const payload = new Uint8Array(size).fill(fill(i));
    parts.push(buildMessage({ productId, dumpType, objNr: i & 0x7f, payload }));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return parseFile(all);
}

const donorDn2 = (): Uint8Array => new Uint8Array(DN2_LAYOUT.imageSize).fill(0x5a);

test("a PatternKit is split into its pattern and its kit, at the right offsets", () => {
  const plan = planRebuild(capture(0x50, 128, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, (i) => i));

  assert.equal(plan.patterns.length, 128);
  assert.equal(plan.kits.length, 128);
  assert.equal(plan.patterns[0]!.at, DN2_LAYOUT.headerSize);
  assert.equal(plan.kits[0]!.at, DN2_LAYOUT.kitBase);
  assert.equal(plan.patterns[127]!.at, DN2_LAYOUT.headerSize + 127 * DN2_LAYOUT.patternSize);
  assert.equal(plan.kits[127]!.at, DN2_LAYOUT.kitBase + 127 * DN2_LAYOUT.kitSize);
  assert.equal(plan.patterns[0]!.bytes.length, DN2_LAYOUT.patternSize);
  assert.equal(plan.kits[0]!.bytes.length, DN2_LAYOUT.kitSize);
});

test("what is written comes back out of the image where the readers look for it", () => {
  // Verified through the *project* readers rather than by re-reading our own offsets, so the
  // arithmetic is checked against something that did not compute it.
  const plan = planRebuild(capture(0x50, 128, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, (i) => i));
  const image = applyRebuild(donorDn2(), plan);

  assert.deepEqual(verifyRebuild(image, plan), []);
  for (const i of [0, 63, 127]) {
    assert.ok(patternRecord(image, i).every((b) => b === i), `pattern ${i}`);
    assert.ok(kitRecord(image, i).every((b) => b === i), `kit ${i}`);
  }
});

test("sounds land in the pool the sound-lock resolver reads from", () => {
  const plan = planRebuild(capture(0x53, POOL_SOUND_COUNT, DN2.soundSize, (i) => i));
  const image = applyRebuild(donorDn2(), plan);

  const at = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET;
  assert.equal(image[at], 0);
  assert.equal(image[at + 5 * DN2.soundSize], 5);
  assert.equal(image[at + 127 * DN2.soundSize], 127);
});

test("the settings record covers the saved-position fields", () => {
  // The placement was found by locating a captured payload in real images; this asserts the
  // consequence, which is that position.ts's offsets fall inside the record rather than beside it.
  const plan = planRebuild(capture(0x54, 1, DN2.settingsSize, () => 0x11));
  const image = applyRebuild(donorDn2(), plan);

  for (const offset of [SAVED_TRACK_OFFSET, SAVED_PATTERN_OFFSET]) {
    assert.equal(image[DN2_LAYOUT.tailBase + offset], 0x11, `tail +${offset} should be in the record`);
  }
});

test("a corrupt record is refused and the donor's bytes are left alone", () => {
  // The whole reason this module refuses rather than warns: a Digitone II sent one pattern with a
  // bad checksum and 6,433 wrong bytes, and returned it perfectly the next night.
  const messages = capture(0x50, 3, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, (i) => i + 1);
  messages[1] = { ...messages[1]!, storedChecksum: messages[1]!.storedChecksum ^ 0x3fff };

  const plan = planRebuild(messages);

  assert.equal(plan.patterns.length, 2, "the corrupt pattern is not placed");
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0]!.reason, /bad checksum/);
  assert.equal(plan.rejected[0]!.label, "PatternKit A2");

  const image = applyRebuild(donorDn2(), plan);
  assert.ok(patternRecord(image, 1).every((b) => b === 0x5a), "A2 still holds the donor's bytes");
});

test("a Digitone 1's sound records are not placed until the caller says what they are", () => {
  // A DN1 sends kit track sounds and pool sounds under the same dump type, and the bytes do not
  // say which. Placing the four a *request* returns would overwrite pool slots 0..3 — the sound
  // lock targets — with whatever the tracks happened to be using.
  const messages = capture(0x53, 4, DN1.soundSize, (i) => i, ProductId.DN1);

  const unsure = planRebuild(messages);
  assert.equal(unsure.sounds.length, 0, "nothing is placed on a guess");
  assert.equal(unsure.rejected.length, 4);
  assert.match(unsure.rejected[0]!.reason, /say which these are/);

  const asKit = planRebuild(messages, { dn1Sounds: "kit" });
  assert.equal(asKit.sounds.length, 0, "kit sounds are already inside their patternKit");

  const asPool = planRebuild(messages, { dn1Sounds: "pool" });
  assert.equal(asPool.sounds.length, 4);
  assert.equal(
    asPool.sounds[0]!.at,
    DN1_LAYOUT.tailBase + DN1.poolOffset,
    "a pool capture does go to the pool",
  );
});

test("a Digitone II has no such ambiguity", () => {
  // 0x63 is the project pool there, whether requested or dumped, so no option is needed.
  const plan = planRebuild(capture(0x53, 8, DN2.soundSize, (i) => i));
  assert.equal(plan.sounds.length, 8);
});

test("more records than slots is refused, not placed by guess", () => {
  // A 182-sound +Drive bank. Placed by object number it would write 128 sounds and then overwrite
  // all of them with the 54 that report 0.
  assert.throws(
    () => planRebuild(capture(0x53, 182, DN2.soundSize, (i) => i & 0xff)),
    (error: unknown) => error instanceof RebuildError && /saturates/.test(String(error)),
  );
});

test("a record of the wrong size is refused rather than written short", () => {
  const plan = planRebuild(capture(0x53, 4, DN1.soundSize, (i) => i));
  assert.equal(plan.sounds.length, 0);
  assert.equal(plan.rejected.length, 4);
  assert.match(plan.rejected[0]!.reason, /302 bytes, expected 359/);
});

test("a donor from the other family is refused", () => {
  const plan = planRebuild(capture(0x53, 2, DN2.soundSize, (i) => i));
  assert.throws(
    () => applyRebuild(new Uint8Array(DN1_LAYOUT.imageSize), plan),
    /other family/,
  );
});

test("a repeated record supersedes the earlier one, and says it did", () => {
  const messages = [
    ...capture(0x53, 1, DN2.soundSize, () => 0x01),
    ...capture(0x53, 1, DN2.soundSize, () => 0x02),
  ];
  const plan = planRebuild(messages);

  assert.equal(plan.sounds.length, 1);
  assert.equal(plan.superseded, 1);
  assert.equal(plan.sounds[0]!.bytes[0], 0x02, "later wins — the earlier answer was the bad one");
});

test("a capture mixing two products is refused", () => {
  const messages = [
    ...capture(0x54, 1, DN2.settingsSize, () => 1, ProductId.DN2),
    ...capture(0x54, 1, DN1.settingsSize, () => 2, ProductId.DN1),
  ];
  assert.throws(() => planRebuild(messages), /mixes products/);
});

test("the donor's contribution is named, not just counted", () => {
  const plan = planRebuild(capture(0x50, 128, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, () => 7));

  // No sounds in this capture — the Digitone 1 front-panel case, and the reason readplan.ts asks
  // for the pool object by object.
  assert.ok(plan.fromDonor.some((r) => /whole sound pool/.test(r)));
  assert.ok(plan.fromDonor.some((r) => /song table/.test(r)));
  assert.ok(plan.fromDonor.some((r) => /identity token/.test(r)));
});

test("a rebuild mints a new identity rather than inheriting the donor's", () => {
  // Every project built from EMPTY.dn2prj once claimed to be EMPTY. A rebuild authors a project.
  const donor = donorDn2();
  const plan = planRebuild(capture(0x54, 1, DN2.settingsSize, () => 3));
  const a = applyRebuild(donor, plan);
  const b = applyRebuild(donor, plan);

  assert.notEqual(projectId(a), projectId(donor));
  assert.notEqual(projectId(a), projectId(b));
});

test("the donor is not modified", () => {
  const donor = donorDn2();
  const before = donor.slice(0, 64);
  applyRebuild(donor, planRebuild(capture(0x50, 1, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, () => 9)));
  assert.deepEqual(donor.slice(0, 64), before);
});

test("verify catches a record that did not land where the plan said", () => {
  const plan = planRebuild(capture(0x50, 2, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, (i) => i + 1));
  const image = applyRebuild(donorDn2(), plan);
  const at = plan.patterns[1]!.at + 10;
  image[at] = image[at]! ^ 0xff;

  const problems = verifyRebuild(image, plan);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /Pattern A2 differs/);
});

test("coverage says how much of the image the capture really supplied", () => {
  const plan = planRebuild([
    ...capture(0x50, 128, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize, () => 1),
    ...capture(0x53, 128, DN2.soundSize, () => 2),
    ...capture(0x54, 1, DN2.settingsSize, () => 3),
  ]);

  const { supplied, total } = coverage(plan);
  assert.equal(total, DN2_LAYOUT.imageSize);
  assert.equal(supplied, 12_825_984);
  assert.equal(total - supplied, 63_620, "the donor supplies 63,620 bytes, 0.49%");
});

// --- against the real capture -------------------------------------------------------------------

/**
 * The hardware capture, if it is on this machine.
 *
 * Not in the repository — it is a read of the author's own project. Skipped rather than failed
 * when absent, the same rule the corpus tests follow, but it **throws rather than passes quietly**
 * if the file is there and unreadable: a test that can pass by finding nothing is not a test.
 */
const HARDWARE_CAPTURE =
  process.env.DN_CAPTURE ??
  "../dn_sysex/99_HardwareTest/DigitoneII_Project_257msg_2200.syx";

test("a real Digitone 1 project read keeps its four kit sounds out of the pool", (t) => {
  // The capture that found the bug. 128 patternKits, 4 sounds and settings — and those 4 sounds
  // are kit track sounds, which must not land in pool slots 0..3.
  const path =
    process.env.DN1_CAPTURE ??
    "../dn_sysex/99_HardwareTest/Digitone_Project_133msg_2231.syx";
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(readFileSync(path));
  } catch {
    t.skip(`no capture at ${path}`);
    return;
  }

  const messages = parseFile(raw);
  const plan = planRebuild(messages);

  assert.equal(plan.productId, ProductId.DN1);
  assert.equal(plan.patterns.length, 128);
  assert.equal(plan.kits.length, 128);
  assert.equal(plan.settings.length, 1);
  assert.equal(plan.sounds.length, 0, "the four kit sounds are not placed in the pool");
  assert.equal(plan.rejected.length, 4);
  assert.ok(
    plan.fromDonor.some((r) => /128-slot sound pool/.test(r)),
    "and the report says the pool has to come from somewhere else",
  );
});

test("a real 257-message device read rebuilds into a complete image", (t) => {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(readFileSync(HARDWARE_CAPTURE));
  } catch {
    t.skip(`no capture at ${HARDWARE_CAPTURE}`);
    return;
  }

  const plan = planRebuild(parseFile(raw));

  assert.equal(plan.productId, ProductId.DN2);
  assert.equal(plan.patterns.length, 128);
  assert.equal(plan.kits.length, 128);
  assert.equal(plan.sounds.length, 128);
  assert.equal(plan.settings.length, 1);
  assert.deepEqual(plan.rejected, [], "a clean read rejects nothing");
  assert.equal(plan.superseded, 0);

  const image = applyRebuild(donorDn2(), plan);
  assert.deepEqual(verifyRebuild(image, plan), []);

  // Everything except the 0.49% the wire cannot carry is now the device's own bytes.
  const { supplied, total } = coverage(plan);
  assert.equal(supplied, 12_825_984);
  assert.ok(supplied / total > 0.995);
});
