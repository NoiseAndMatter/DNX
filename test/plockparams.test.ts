/**
 * The p-lock parameter-id table, and the rule that generates a third of it.
 *
 * The LFO block is not a list, it is arithmetic — so the test asserts the formula rather than
 * the 24 ids it produces. If a future capture contradicts it, that is a real finding and this
 * is where it surfaces.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LFO_STRIDE,
  NOT_LOCKABLE,
  PLOCK_PARAMETERS,
  UNMAPPED_IDS,
  describePlock,
  plockParameter,
} from "@noiseandmatter/dnx-core/project/plockparams.js";

test("ids are unique", () => {
  const ids = PLOCK_PARAMETERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the three LFOs are interleaved with a stride of 4", () => {
  const slots = ["SPD", "MULT", "FADE", "DEST", "WAVE", "SPH", "MODE", "DEP"];
  for (let slot = 0; slot < slots.length; slot++) {
    for (let lfo = 1; lfo <= 3; lfo++) {
      const p = plockParameter(LFO_STRIDE * slot + lfo);
      assert.ok(p, `no parameter at slot ${slot} lfo ${lfo}`);
      assert.equal(p.name, slots[slot], `id ${LFO_STRIDE * slot + lfo}`);
      assert.match(p.page, new RegExp(`LFO ${lfo}`));
    }
  }
});

test("the fourth position of every LFO group is unused", () => {
  // 0, 4, 8 ... would be "LFO 0". Nothing claims them, and the gap is the evidence that the
  // layout has room for a fourth LFO rather than being a dense list.
  for (let slot = 0; slot < 8; slot++) {
    assert.equal(plockParameter(LFO_STRIDE * slot), undefined, `id ${LFO_STRIDE * slot}`);
  }
});

test("the AMP envelope is contiguous in page order", () => {
  const envelope = ["ATK", "HOLD", "DEC", "SUS", "REL"];
  envelope.forEach((name, i) => {
    const p = plockParameter(87 + i);
    assert.ok(p, `no parameter at id ${87 + i}`);
    assert.equal(p.name, name);
    assert.equal(p.page, "AMP");
  });
});

test("the two inferred ids are marked as inferred", () => {
  const inferred = PLOCK_PARAMETERS.filter((p) => p.inferred).map((p) => `${p.name}=${p.id}`);
  // HOLD and MODE were skipped during the capture because AMP MODE gates which of them exist.
  // Their ids come from the gaps either side, so they must not read as observed.
  assert.deepEqual(inferred.sort(), ["HOLD=88", "MODE=97"]);
});

test("no observed id is also listed as unmapped", () => {
  const observed = new Set(PLOCK_PARAMETERS.map((p) => p.id));
  for (const id of UNMAPPED_IDS) {
    assert.ok(!observed.has(id), `id ${id} is both observed and listed as unmapped`);
  }
  // 32 and 86 are the odd ones; 57..65 are expected to fall to the two uncaptured SYN machines.
  assert.ok(UNMAPPED_IDS.includes(32) && UNMAPPED_IDS.includes(86));
});

test("controls that are not in the lock table are recorded, not silently absent", () => {
  assert.ok(NOT_LOCKABLE.length >= 12);
  // Nothing may be both named as a lock parameter and listed as not lockable.
  const named = new Set(PLOCK_PARAMETERS.map((p) => `${p.page} ${p.name}`));
  for (const n of NOT_LOCKABLE) {
    assert.ok(!named.has(`${n.page} ${n.name}`), `${n.page} ${n.name} is in both tables`);
  }
});

test("describePlock names a known id and refuses an unknown one", () => {
  assert.equal(describePlock(29), "MOD 1 (LFO 1) DEP");
  assert.equal(describePlock(9), "MOD 1 (LFO 1) FADE");
  assert.equal(describePlock(50), undefined, "an unmapped machine-page id must stay unnamed");
});
