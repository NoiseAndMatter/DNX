/**
 * The parameter-lock slot encoding, pinned against the hardware sweep of 2026-07-26.
 *
 * The table below is the device's own output: an LFO depth was set to each value on a
 * separate step and the pattern read back. It is the evidence that a slot is two bytes
 * rather than one integer, so it is worth having as a test and not only as prose.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCK_UNSET,
  isLockSet,
  lockBipolar,
  lockCoarse,
  lockFine,
  lockFineValue,
  lockRaw,
} from "@noiseandmatter/dnx-core/project/lockvalue.js";

/**
 * The lock record for the LFO depth sweep in pattern A3 of `DATA_CAPTURE.dn2prj`
 * (record 1, track 3, parameter 29), and the value each step was set to.
 *
 * Four points land on the scale exactly, which is what pins it. The two at +/-1.00 sit one
 * fine tick out; see the anomaly test below.
 */
const SWEEP: readonly { asked: number; coarse: number; fine: number }[] = [
  { asked: -128.0, coarse: 0x00, fine: 0x00 },
  { asked: -64.0, coarse: 0x20, fine: 0x00 },
  { asked: -1.0, coarse: 0x3f, fine: 0x7f },
  { asked: -0.01, coarse: 0x3f, fine: 0xff },
  { asked: 0.01, coarse: 0x40, fine: 0x01 },
  { asked: 1.0, coarse: 0x40, fine: 0x81 },
  { asked: 60.0, coarse: 0x5e, fine: 0x00 },
  { asked: 127.98, coarse: 0x7f, fine: 0xfe },
];

/** The steps whose fine byte is zero, so the device chose the value with no rounding at all. */
const EXACT = SWEEP.filter((point) => point.fine === 0);

test("the sweep points with no fine part decode exactly", () => {
  assert.equal(EXACT.length, 3, "three of the sweep points are whole coarse steps");
  for (const point of EXACT) {
    assert.equal(lockFineValue(lockRaw(point.coarse, point.fine)), point.asked, `${point.asked}`);
  }
});

test("every sweep point decodes to within one quantum of the value asked for", () => {
  for (const point of SWEEP) {
    const raw = lockRaw(point.coarse, point.fine);
    assert.equal(lockCoarse(raw), point.coarse, `coarse byte of ${point.asked}`);
    assert.equal(lockFine(raw), point.fine, `fine byte of ${point.asked}`);
    const off = Math.abs(lockFineValue(raw) - point.asked);
    assert.ok(off <= 1 / 128 + 1e-9, `${point.asked} decoded ${off.toFixed(4)} away, over one quantum`);
  }
});

test("the range endpoints are the full span of the two bytes", () => {
  assert.equal(lockFineValue(lockRaw(0x00, 0x00)), -128, "minimum is both bytes zero");
  // 0xFFFF is the unlocked sentinel, so the largest storable value is one below it.
  assert.equal(lockFineValue(lockRaw(0x7f, 0xfe)).toFixed(2), "127.98", "device-reported maximum");
});

test("the quantum is 1/128 and adjacent fine bytes are one quantum apart", () => {
  const a = lockRaw(0x40, 0x01);
  const b = lockRaw(0x40, 0x02);
  assert.equal(lockFineValue(b) - lockFineValue(a), 1 / 128);
});

test("a plain 0-127 parameter is the coarse byte alone", () => {
  // What every ordinary lock looks like: value in the first byte, second byte zero.
  for (const value of [0, 1, 64, 127]) {
    const raw = lockRaw(value, 0);
    assert.equal(lockCoarse(raw), value);
    assert.equal(lockFine(raw), 0);
  }
});

/**
 * The +/-1.00 steps of the sweep are one fine tick further from zero than asked for.
 *
 * Recorded rather than accommodated. The scale itself is not in doubt — three other points
 * land exactly — and one tick is 0.008, well inside what a manual capture can miss on an
 * encoder. The same capture has step 8 reading +60.00 where the sheet asked for +64.00, so
 * entry slips are known to have happened. Re-check on hardware before treating it as a
 * property of the format.
 */
test("the +/-1.00 sweep steps sit exactly one fine tick outward", () => {
  assert.equal(lockRaw(0x40, 0x81) - lockRaw(0x40, 0x80), 1, "+1.00 is one tick above +1");
  assert.equal(lockRaw(0x3f, 0x80) - lockRaw(0x3f, 0x7f), 1, "-1.00 is one tick below -1");
});

/**
 * The bipolar sweep from the same capture: A3 record 0, track 3, parameter 29's neighbour.
 * Every fine byte is zero, and the seven coarse bytes are exactly the values asked for
 * plus 64 — which is the offset encoding demonstrated on real data rather than asserted.
 */
test("the captured bipolar sweep is the asked-for value plus 64", () => {
  const captured: readonly [number, number][] = [
    [-64, 0x00],
    [-63, 0x01],
    [-32, 0x20],
    [-1, 0x3f],
    [1, 0x41],
    [32, 0x60],
    [63, 0x7f],
  ];
  for (const [asked, coarse] of captured) {
    assert.equal(lockBipolar(lockRaw(coarse, 0)), asked, `bipolar ${asked}`);
  }
});

test("bipolar parameters are offset by +64, never two's complement", () => {
  assert.equal(lockBipolar(lockRaw(0x00, 0)), -64, "minimum");
  assert.equal(lockBipolar(lockRaw(0x40, 0)), 0, "centre");
  assert.equal(lockBipolar(lockRaw(0x7f, 0)), 63, "maximum");

  // Why it matters: two's complement would put -1 at 0xFFFF, which is the sentinel.
  for (let value = -64; value <= 63; value++) {
    assert.ok(isLockSet(lockRaw(value + 64, 0)), `bipolar ${value} must not read as unlocked`);
  }
});

test("the unset sentinel is the only unlocked marker", () => {
  assert.equal(isLockSet(LOCK_UNSET), false);
  assert.equal(isLockSet(lockRaw(0xff, 0xfe)), true, "0xFFFE is a real value, not a sentinel");
});
