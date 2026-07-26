/**
 * The one rescaled field map, checked against the rule that explains it.
 *
 * `FX_COMPRESSOR_VOLUME` is deliberately a table and not a formula — see the note on it for
 * why. This test asserts the formula anyway, so that if a future capture adds an entry that
 * breaks it, the disagreement surfaces here rather than silently widening a table nobody
 * re-derives.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FX_COMPRESSOR_VOLUME } from "../src/expand/fieldmap.js";

/** `min(floor(dn1 x 25600 / 127), 25599)` — a 0-127 source on a 0-100 scale in 1/256 steps. */
function rescale(dn1: number): number {
  return Math.min(Math.floor((dn1 * 25_600) / 127), 25_599);
}

test("every entry of the compressor-volume table matches the rescaling rule", () => {
  assert.equal(FX_COMPRESSOR_VOLUME.table.size, 5, "five values appear in the corpus");
  for (const [dn1, [coarse, fine]] of FX_COMPRESSOR_VOLUME.table) {
    const want = rescale(dn1);
    assert.equal(coarse * 256 + fine, want, `DN1 ${dn1} should store ${want >>> 8},${want & 0xff}`);
  }
});

test("the coarse byte alone is what the device would show", () => {
  // The device writes this field as a plain 0-127 integer with a zero fine byte; the
  // importer's fractional part is the only reason the fine byte is ever non-zero.
  for (const [, [coarse]] of FX_COMPRESSOR_VOLUME.table) {
    assert.ok(coarse >= 0 && coarse <= 127, `coarse ${coarse} must be a valid 0-127 value`);
  }
});

test("the two destination offsets are adjacent but distinct", () => {
  assert.equal(FX_COMPRESSOR_VOLUME.fineAt, FX_COMPRESSOR_VOLUME.coarseAt + 1);
  assert.equal(FX_COMPRESSOR_VOLUME.coarseAt, 5_898);
});
