/**
 * Choosing a geometry for a file, and making the file fit it.
 *
 * Two things these tests are careful about:
 *
 * - **A proposal is not a measurement, and the tests say so.** 131,072 samples is 64 x 2048 and
 *   32 x 4096 and 128 x 1024, all exactly. The assertions pin the *convention* the code follows and
 *   one of them checks that a second shape divides just as well, so nobody later reads `exact` as
 *   proof that the file was that shape.
 * - **The fit is checked against the conversion it feeds.** `fitToGeometry` exists to satisfy
 *   `convertTable`'s refusal, so the last test runs the pair together. A fit that is right on its
 *   own terms and still refused downstream is the failure worth catching.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STAGE3D_BOUNDS,
  STOCK_BOUNDS,
  fitToGeometry,
  proposeGeometry,
  type FitBounds,
} from "@noiseandmatter/dnx-core/waverider/fit.js";
import { convertTable, readTableSamples } from "@noiseandmatter/dnx-core/waverider/convert.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

/** `waves` frames of `points`, each a sine one harmonic higher than the last. */
function sweep(waves: number, points: number): Float32Array {
  const out = new Float32Array(waves * points);
  for (let w = 0; w < waves; w++) {
    for (let i = 0; i < points; i++) {
      out[w * points + i] = Math.sin((2 * Math.PI * (w + 1) * i) / points) * 0.5;
    }
  }
  return out;
}

function peak(a: ArrayLike<number>): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]!));
  return worst;
}

test("the bounds constants say what each build plays", () => {
  // Read out of modinfo.c by the firmware session on 2026-10-13. Bytes from an instrument win.
  assert.deepEqual(STAGE3D_BOUNDS, {
    maxWaves: 64,
    minPoints: 64,
    maxPoints: 4096,
    pointsPowerOfTwo: true,
  });
  assert.equal(STOCK_BOUNDS.minPoints, 512);
  assert.equal(STOCK_BOUNDS.maxPoints, 512);
  assert.equal(STOCK_BOUNDS.maxWaves, 16);
});

test("a Serum-shaped file is proposed as frames of 2048", () => {
  const proposal = proposeGeometry(64 * 2048, STAGE3D_BOUNDS);
  assert.deepEqual(proposal.geometry, { waves: 64, points: 2048 });
  assert.equal(proposal.exact, true);

  // And the reason has to admit that other shapes divide it, because they do.
  assert.equal((64 * 2048) % 4096, 0, "32 x 4096 divides this count too");
  assert.equal((64 * 2048) % 1024, 0, "128 x 1024 divides this count too");
  assert.match(proposal.reason, /convention rather than a measurement/);
});

test("a count whose conventional shape has too many frames falls through to the next", () => {
  /*
   * 204,800 is 100 frames of 2,048, which no build loads, and 50 frames of 4,096, which stage3d
   * does. Taking the first length that divides without checking the frame count against the bounds
   * is the obvious bug here, and it would propose a table that is stored and silent.
   */
  const proposal = proposeGeometry(100 * 2048, STAGE3D_BOUNDS);
  assert.deepEqual(proposal.geometry, { waves: 50, points: 4096 });
  assert.equal(proposal.exact, true);
  assert.ok(proposal.geometry.waves <= STAGE3D_BOUNDS.maxWaves);
});

test("a stock build is only ever proposed 512 points", () => {
  const proposal = proposeGeometry(16 * 512, STOCK_BOUNDS);
  assert.deepEqual(proposal.geometry, { waves: 16, points: 512 });
  assert.equal(proposal.exact, true);

  // 2,048 divides this count and is still not offered, because the bounds exclude it.
  assert.equal((16 * 512) % 2048, 0);
});

test("a recording that divides into nothing is proposed a shape and told it will be resampled", () => {
  const proposal = proposeGeometry(44_100, STAGE3D_BOUNDS);
  assert.equal(proposal.exact, false);
  assert.equal(proposal.geometry.points, 4096);
  assert.equal(proposal.geometry.waves, 11);
  assert.match(proposal.reason, /resampled to fit/);
});

test("a proposal never leaves the bounds it was given", () => {
  const narrow: FitBounds = { maxWaves: 4, minPoints: 128, maxPoints: 256, pointsPowerOfTwo: true };
  for (const count of [1, 999, 8192, 44_100, 131_072, 1_000_003]) {
    const { geometry } = proposeGeometry(count, narrow);
    assert.ok(geometry.waves >= 1 && geometry.waves <= 4, `${count} proposed ${geometry.waves} waves`);
    assert.ok(
      geometry.points >= 128 && geometry.points <= 256,
      `${count} proposed ${geometry.points} points`,
    );
  }
});

test("a sample count has to be a positive whole number", () => {
  assert.throws(() => proposeGeometry(0, STAGE3D_BOUNDS), WaveriderError);
  assert.throws(() => proposeGeometry(-8, STAGE3D_BOUNDS), WaveriderError);
  assert.throws(() => proposeGeometry(1.5, STAGE3D_BOUNDS), WaveriderError);
});

test("bounds that admit no conventional cycle length are refused, not worked around", () => {
  const impossible: FitBounds = { maxWaves: 16, minPoints: 300, maxPoints: 400, pointsPowerOfTwo: true };
  assert.throws(() => proposeGeometry(8192, impossible), WaveriderError);
});

test("a count that already matches is copied, not resampled", () => {
  const source = sweep(16, 512);
  const result = fitToGeometry(source, { waves: 16, points: 512 });
  assert.equal(result.method, "exact");
  assert.equal(result.samples.length, 16 * 512);
  assert.deepEqual([...result.samples], [...source]);
  assert.notEqual(result.samples, source, "the result must not alias the caller's array");
});

test("power-of-two frames go through the transform, and keep their shape", () => {
  const result = fitToGeometry(sweep(16, 1024), { waves: 16, points: 512 });
  assert.equal(result.method, "spectral");
  assert.equal(result.sourceFramePoints, 1024);
  assert.equal(result.samples.length, 16 * 512);

  /*
   * Every frame of the source is a sine of harmonic w+1, all far below the new Nyquist of 256, so
   * each must come out as the same sine at the new length. This is what distinguishes the spectral
   * path from a decimation that would keep the amplitude and move the harmonic.
   */
  for (let w = 0; w < 16; w++) {
    for (let i = 0; i < 512; i++) {
      const want = Math.sin((2 * Math.PI * (w + 1) * i) / 512) * 0.5;
      const got = result.samples[w * 512 + i]!;
      assert.ok(Math.abs(got - want) < 1e-5, `frame ${w} point ${i}: ${got} want ${want}`);
    }
  }
});

test("frames that are not power-of-two cycles are interpolated, and say so", () => {
  // An integer frame length that is not a power of two still cannot go through radix-2.
  const integral = fitToGeometry(sweep(16, 1000), { waves: 16, points: 512 });
  assert.equal(integral.method, "interpolated");
  assert.equal(integral.sourceFramePoints, 1000);
  assert.equal(integral.samples.length, 16 * 512);

  // And a count that does not divide by the frame count at all.
  const ragged = fitToGeometry(new Float32Array(44_100).fill(0.2), { waves: 16, points: 512 });
  assert.equal(ragged.method, "interpolated");
  assert.ok(Math.abs(ragged.sourceFramePoints - 44_100 / 16) < 1e-9);
  assert.equal(ragged.samples.length, 16 * 512);
  // A constant source stays constant whichever path it took.
  assert.ok(Math.abs(peak(ragged.samples) - 0.2) < 1e-6, "a flat source changed level");
});

test("downsampling a recording averages rather than picking every nth sample", () => {
  /*
   * A source alternating +1 and -1 is the worst case: every other sample. Decimating it by an even
   * step returns a constant at full scale, which is the loudest possible wrong answer. Averaging
   * returns something near zero, which is what a band-limited reading of it is.
   */
  const alternating = new Float32Array(16 * 512 * 4);
  for (let i = 0; i < alternating.length; i++) alternating[i] = i % 2 === 0 ? 1 : -1;
  const result = fitToGeometry(alternating, { waves: 16, points: 500 });
  assert.equal(result.method, "interpolated");
  assert.ok(peak(result.samples) < 0.2, `alternating source decimated to ${peak(result.samples)}`);
});

test("an empty or impossible request is refused", () => {
  assert.throws(() => fitToGeometry(new Float32Array(0), { waves: 16, points: 512 }), WaveriderError);
  assert.throws(() => fitToGeometry(sweep(4, 64), { waves: 0, points: 512 }), WaveriderError);
  assert.throws(() => fitToGeometry(sweep(4, 64), { waves: 16, points: 1.5 }), WaveriderError);
});

test("the fit satisfies the conversion it exists to feed", () => {
  /*
   * `convertTable` refuses a count that does not match the geometry, and that refusal is the whole
   * reason this module exists. Run the pair rather than trusting the lengths separately.
   */
  const bounds = STAGE3D_BOUNDS;
  for (const count of [44_100, 131_072, 16 * 1000, 8192]) {
    const source = new Float32Array(count);
    for (let i = 0; i < count; i++) source[i] = Math.sin(i * 0.05) * 0.4;

    const { geometry } = proposeGeometry(count, bounds);
    const fitted = fitToGeometry(source, geometry);
    const converted = convertTable(fitted.samples, geometry.waves, geometry.points);

    assert.equal(
      converted.payload.length,
      2 * geometry.waves * geometry.points,
      `${count} samples produced the wrong payload size`,
    );
    // Peak-normalised, so the loudest sample is full scale. The device does not undo this.
    assert.equal(peak(readTableSamples(converted.payload)), 32_767);
  }
});
