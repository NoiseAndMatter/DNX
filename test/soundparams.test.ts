/**
 * The sound object's parameter map, and the rule that generates a third of it.
 *
 * The LFO block is arithmetic, so the test asserts the formula rather than the 24 offsets it
 * produces. The rest is asserted against the values the capture actually returned.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LFO_BASE,
  LFO_PARAMETER_STRIDE,
  LFO_STRIDE,
  SOUND_PARAMETERS,
  UNRESOLVED_SOUND_CONTROLS,
  decodeSoundValue,
  soundParameterAt,
} from "../src/project/soundparams.js";
import { DN2_SOUND_SIZE } from "../src/project/soundmap.js";

test("offsets are unique and inside the sound object", () => {
  const offsets = SOUND_PARAMETERS.map((p) => p.offset);
  assert.equal(new Set(offsets).size, offsets.length, "no offset is claimed twice");
  for (const o of offsets) assert.ok(o >= 0 && o < DN2_SOUND_SIZE, `${o} is outside the object`);
});

test("the LFO block is a regular grid", () => {
  const params = ["SPD", "MULT", "FADE", "DEST", "WAVE", "SPH", "MODE", "DEP"];
  for (let p = 0; p < params.length; p++) {
    for (let lfo = 0; lfo < 3; lfo++) {
      const at = soundParameterAt(LFO_BASE + LFO_PARAMETER_STRIDE * p + LFO_STRIDE * lfo);
      assert.ok(at, `nothing at parameter ${p} lfo ${lfo}`);
      assert.equal(at.name, params[p]);
      assert.equal(at.page, `MOD ${lfo + 1}`);
    }
  }
});

test("the fourth slot of each LFO group is unused", () => {
  // Three LFOs at stride 2 fill six of the eight bytes; the last pair belongs to nothing.
  for (let p = 0; p < 8; p++) {
    const spare = LFO_BASE + LFO_PARAMETER_STRIDE * p + LFO_STRIDE * 3;
    assert.equal(soundParameterAt(spare), undefined, `${spare} should be unclaimed`);
  }
});

test("HOLD has its own byte, so the object is parameter-addressed", () => {
  const hold = soundParameterAt(204);
  assert.equal(hold?.name, "HOLD");
  // The neighbours are ATK and DEC. If HOLD shared a byte with DEC, an editor would have needed
  // the AMP MODE before it could read any envelope.
  assert.equal(soundParameterAt(202)?.name, "ATK");
  assert.equal(soundParameterAt(206)?.name, "DEC");
});

test("fine-resolution controls decode as value / 2 + 64", () => {
  const dep = soundParameterAt(LFO_BASE + LFO_PARAMETER_STRIDE * 7)!;
  assert.equal(dep.name, "DEP");
  assert.equal(dep.encoding, "fine");
  // The capture set LFO depths to 32 and 56 and read back 80 and 92.
  assert.equal(decodeSoundValue(dep, 80), 32);
  assert.equal(decodeSoundValue(dep, 92), 56);
});

test("bipolar controls decode as value + 64", () => {
  const pan = soundParameterAt(218)!;
  assert.equal(pan.name, "PAN");
  // PAN was set to +40 and stored 104.
  assert.equal(decodeSoundValue(pan, 104), 40);
});

test("what the capture failed to place is recorded, not guessed", () => {
  assert.deepEqual([...UNRESOLVED_SOUND_CONTROLS], ["FX BR"]);
  // Nothing claims to be FX BR.
  assert.ok(!SOUND_PARAMETERS.some((p) => p.page === "FX" && p.name === "BR"));
});

test("the per-sound FX sends are separate from the kit FX block", () => {
  // These three say how much of this sound is sent; kitfx.ts configures the effects themselves.
  for (const [offset, name] of [[212, "CHR"], [214, "DEL"], [216, "REV"]] as const) {
    const p = soundParameterAt(offset)!;
    assert.equal(p.name, name);
    assert.equal(p.page, "FX");
  }
});

test("SYN 1 runs in knob order across consecutive even offsets", () => {
  const expected = ["ALGO", "RATIO C", "RATIO A", "RATIO B", "HARM", "DTUN", "FDBK", "MIX"];
  expected.forEach((name, i) => {
    const p = soundParameterAt(94 + i * 2);
    assert.equal(p?.name, name, `offset ${94 + i * 2}`);
    assert.equal(p?.page, "SYN 1");
  });
});

test("HARM centres on 63, not 64", () => {
  const harm = soundParameterAt(102)!;
  assert.equal(harm.name, "HARM");
  assert.equal(harm.centre, 63);
  // The untouched baseline read 63 for a value of 0, and +23 stored 86. Two points, slope 1.
  assert.equal(decodeSoundValue(harm, 63), 0);
  assert.equal(decodeSoundValue(harm, 86), 23);
  // Its -26..+26 range then occupies 37..89.
  assert.equal(decodeSoundValue(harm, 37), -26);
  assert.equal(decodeSoundValue(harm, 89), 26);
});

test("HARM is the only control that does not centre on 64", () => {
  const odd = SOUND_PARAMETERS.filter((p) => p.centre !== undefined && p.centre !== 64);
  assert.deepEqual(odd.map((p) => p.name), ["HARM"]);
});

test("the operator fine tunes decode as value * 64 + 64", () => {
  // Set to -0.500, +0.250, -0.750, +0.875 and stored as 32, 80, 16, 120 -- all four exact.
  const cases: [number, number, number][] = [[160, 32, -0.5], [162, 80, 0.25], [164, 16, -0.75], [166, 120, 0.875]];
  for (const [offset, stored, want] of cases) {
    const p = soundParameterAt(offset)!;
    assert.equal(p.encoding, "fraction");
    assert.equal(decodeSoundValue(p, stored), want, `${p.name}`);
  }
});

test("SYN 3 is in knob order, with PHRT stored apart", () => {
  const inOrder = [[130, "ADEL"], [132, "ATRG"], [134, "ARST"], [136, "BDEL"], [138, "BTRG"], [140, "BRST"]] as const;
  for (const [offset, name] of inOrder) assert.equal(soundParameterAt(offset)?.name, name);
  // PHRT is knob D but lives at 110, away from the per-operator block -- it is a shared setting.
  assert.equal(soundParameterAt(110)?.name, "PHRT");
});

test("the four SYN 3 switches are marked as inferred, not observed", () => {
  // The set of four bytes is certain: all four moved together when all four switches were set.
  // Which byte is which is knob order alone -- nothing observed separates them, so none of the
  // four may claim to be measured.
  for (const offset of [132, 134, 138, 140]) {
    const p = soundParameterAt(offset)!;
    assert.equal(p.page, "SYN 3");
    assert.equal(p.inferred, true, `${p.name} at ${offset} must not claim to be observed`);
  }
  // The two delays either side are measured, and they are what fix the ordering's plausibility.
  assert.equal(soundParameterAt(130)?.inferred, undefined);
  assert.equal(soundParameterAt(136)?.inferred, undefined);
});
