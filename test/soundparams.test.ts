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
