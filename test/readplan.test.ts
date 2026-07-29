import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductId } from "../src/sysex/devices.js";
import { DN1_LAYOUT, DN2_LAYOUT, DN1_KIT, DN2_KIT } from "../src/project/dn2image.js";
import { POOL_SOUND_COUNT } from "../src/project/soundmap.js";
import { RequestCode } from "../src/device/dumprequest.js";
import { PATTERN_COUNT, RESPONSE_SIZES, planBytes, planProjectRead, wireBytes } from "../src/device/readplan.js";

test("a whole project is 128 patterns, 128 pool sounds and one settings record", () => {
  const plan = planProjectRead(ProductId.DN2);
  assert.equal(plan.length, PATTERN_COUNT + POOL_SOUND_COUNT + 1);

  const counted = (code: number): number => plan.filter((s) => s.code === code).length;
  assert.equal(counted(RequestCode.PatternKit), 128);
  assert.equal(counted(RequestCode.Sound), 128);
  assert.equal(counted(RequestCode.ProjectSettings), 1);
});

test("the plan follows the order a device dumps itself in", () => {
  // Patterns, then sounds, then settings — docs/dn2-format.md 5c. Nothing depends on it, but a
  // capture made by requesting and one made from the front panel then line up message for message.
  const codes = planProjectRead(ProductId.DN2).map((s) => s.code);
  const firstSound = codes.indexOf(RequestCode.Sound);
  assert.equal(codes.lastIndexOf(RequestCode.PatternKit), firstSound - 1);
  assert.equal(codes.at(-1), RequestCode.ProjectSettings);
});

test("every pattern slot is asked for exactly once, by device-style name", () => {
  const patterns = planProjectRead(ProductId.DN1, { patterns: true });
  assert.deepEqual(
    patterns.map((s) => s.objNr),
    [...Array(128).keys()],
  );
  assert.equal(patterns[0]!.label, "Pattern A1");
  assert.equal(patterns[127]!.label, "Pattern H16");
});

test("a step expects the response its request pairs with", () => {
  for (const step of planProjectRead(ProductId.DN2)) {
    assert.equal(step.expect, step.code - 0x10, `${step.label} should expect ${step.code} - 0x10`);
  }
});

test("the predicted PatternKit size is the pattern record plus the kit record", () => {
  // The claim that made the whole feature tractable: a PatternKit on the wire is exactly the two
  // records a project file stores. Asserted against the *layout constants* rather than against
  // literals copied out of the documentation, so a change to either side has to face the other.
  assert.equal(
    RESPONSE_SIZES[ProductId.DN2]!.patternKit,
    DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize,
  );
  assert.equal(
    RESPONSE_SIZES[ProductId.DN1]!.patternKit,
    DN1_LAYOUT.patternSize + DN1_LAYOUT.kitSize,
  );
});

test("the predicted sound size is one kit sound slot", () => {
  assert.equal(RESPONSE_SIZES[ProductId.DN2]!.sound, DN2_KIT.soundSize);
  assert.equal(RESPONSE_SIZES[ProductId.DN1]!.sound, DN1_KIT.soundSize);
});

test("a device whose record sizes we have not measured is refused, not guessed at", () => {
  // 0x14 is a Digitakt II — same storage family, and we still have no measured payload for it.
  // Guessing would produce timeouts sized from a number nobody checked.
  assert.throws(() => planProjectRead(0x14), /no response sizes recorded/);
});

test("a plan can be a subset, which is what transfer mode needs", () => {
  assert.equal(planProjectRead(ProductId.DN2, { settings: true }).length, 1);
  assert.equal(planProjectRead(ProductId.DN2, { patterns: true }).length, 128);
  assert.equal(planProjectRead(ProductId.DN2, {}).length, 0);
});

test("wire size accounts for 8-in-7 and the container", () => {
  // Seven payload bytes become eight on the wire, plus ten header and five trailer.
  assert.equal(wireBytes(7), 8 + 15);
  assert.equal(wireBytes(0), 15);
});

test("a Digitone II project is the 14.6 MB the device was measured sending", () => {
  // The front-panel dump was 248 messages and about 14.6 MB. This plan asks for 257 — nine more,
  // because it asks for all 128 pool slots rather than only the 119 in use — so the estimate
  // should land in the same place rather than somewhere surprising.
  const bytes = planBytes(planProjectRead(ProductId.DN2));
  assert.ok(bytes > 14_000_000 && bytes < 16_000_000, `${bytes} should be about 14.6 MB`);
});

test("a Digitone 1 project is two orders of magnitude smaller", () => {
  const bytes = planBytes(planProjectRead(ProductId.DN1));
  assert.ok(bytes > 3_000_000 && bytes < 3_500_000, `${bytes} bytes`);
});
