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

import { FX_COMPRESSOR_VOLUME, KIT_FX_MAP } from "../src/expand/fieldmap.js";
import { KIT_FX_PARAMETERS, kitFxAt } from "../src/project/kitfx.js";

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

/**
 * Audit the copy table against the named FX block.
 *
 * The two were derived independently — the copy table by correlating 602 kit pairs, the names
 * by a capture the device wrote — so where they overlap they are a check on each other.
 */
test("every copy landing in the FX block hits a byte a capture named", () => {
  const unnamed = KIT_FX_MAP.filter((c) => c.to >= 5_810 && c.to <= 5_899 && !kitFxAt(c.to))
    .map((c) => c.to)
    .sort((a, b) => a - b);
  assert.deepEqual(unnamed, [], "an FX copy with no named destination means a page is unmapped");
});

/**
 * The reverse audit, and the more useful one now: named parameters the converter never writes.
 *
 * A named parameter with no copy targeting it inherits the template's value, which is this
 * project's signature bug. Whether each one is a defect depends on whether the DN1 has the
 * parameter at all — the compressor page may simply have no source — but every one of them is
 * a byte a non-default template can leak through, so the set is pinned. Closing one should be
 * a deliberate act, and the rest stay visible.
 */
test("the FX parameters the converter does not transfer are the known set", () => {
  const copied = new Set<number>(KIT_FX_MAP.map((c) => c.to));
  copied.add(FX_COMPRESSOR_VOLUME.coarseAt);
  const missed = KIT_FX_PARAMETERS.filter((p) => !copied.has(p.offset)).map(
    (p) => `${p.page} ${p.name}`,
  );

  assert.deepEqual(missed.sort(), [
    "chorus HPF",
    "compressor ATK",
    "compressor DRY/CMP",
    "compressor MUP",
    "compressor RAT",
    "compressor REL",
    "compressor SCF",
    "compressor SCS",
    "compressor THR",
    "input DUAL",
    "input IN L level",
    "input IN R level",
    "input IN R reverb send",
  ]);
});

test("the FX block is a stride-2 array of coarse/fine slots", () => {
  for (const parameter of KIT_FX_PARAMETERS) {
    assert.equal(parameter.offset % 2, 0, `${parameter.name} coarse byte must be even`);
    assert.equal(kitFxAt(parameter.offset)?.isFine, false);
    assert.equal(kitFxAt(parameter.offset + 1)?.isFine, true);
  }
});
