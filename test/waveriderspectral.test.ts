/**
 * Band-limited cycle resizing, checked against values that are not this code's own output.
 *
 * Every fixture here is either analytic (a sine evaluated from `Math.sin`, a constant) or a
 * property that would fail if the transform were wrong (a round trip, a harmonic that must
 * disappear). **No assertion compares the resampler against a previous run of the resampler**,
 * which is the way a test like this passes while the arithmetic drifts.
 *
 * The one that earns its place is the folding test. Linear interpolation passes a round trip and
 * passes an amplitude check, and fails that one, because aliasing is exactly the error that keeps
 * the waveform's size and moves its frequency.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fft, isPowerOfTwo, resampleCycle } from "@noiseandmatter/dnx-core/waverider/spectral.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

/** One cycle of `harmonic` over `points`, amplitude `amplitude`. */
function sine(points: number, harmonic: number, amplitude = 1): Float32Array {
  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * harmonic * i) / points);
  }
  return out;
}

/** The largest absolute difference between two runs of samples. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length, "comparing runs of different lengths");
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

/** The largest absolute value, which is how a harmonic is shown to have gone. */
function peak(a: ArrayLike<number>): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]!));
  return worst;
}

test("isPowerOfTwo accepts only positive powers of two", () => {
  for (const n of [1, 2, 4, 64, 512, 2048, 4096]) assert.ok(isPowerOfTwo(n), `${n} is a power of two`);
  for (const n of [0, -2, 3, 6, 100, 1000, 2047, 1.5, NaN]) {
    assert.ok(!isPowerOfTwo(n), `${n} is not a power of two`);
  }
});

test("the forward transform puts a known signal in the bin it belongs to", () => {
  // A constant is all DC: bin 0 holds the sum and nothing else holds anything.
  const n = 64;
  const re = new Float64Array(n).fill(0.25);
  const im = new Float64Array(n);
  fft(re, im);
  assert.ok(Math.abs(re[0]! - 0.25 * n) < 1e-9, `bin 0 should be ${0.25 * n}, got ${re[0]}`);
  for (let k = 1; k < n; k++) {
    assert.ok(Math.abs(re[k]!) < 1e-9 && Math.abs(im[k]!) < 1e-9, `bin ${k} should be empty`);
  }

  /*
   * A sine at harmonic 5 puts half the length in bins 5 and n-5, on the imaginary axis.
   *
   * Built at double precision rather than through the Float32 helper: rounding the input to
   * float32 leaves about 1e-7 in every other bin, which would force a tolerance loose enough to
   * hide a real leak between bins. The resampler's own tests use float32 because that is what it
   * takes; this one is about the transform.
   */
  const sr = new Float64Array(n);
  for (let i = 0; i < n; i++) sr[i] = Math.sin((2 * Math.PI * 5 * i) / n);
  const si = new Float64Array(n);
  fft(sr, si);
  for (let k = 0; k < n; k++) {
    const magnitude = Math.hypot(sr[k]!, si[k]!);
    const expected = k === 5 || k === n - 5 ? n / 2 : 0;
    assert.ok(Math.abs(magnitude - expected) < 1e-9, `bin ${k} magnitude ${magnitude}, want ${expected}`);
  }
});

test("forward then inverse returns the input", () => {
  const n = 256;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Deterministic, and not a sine, so a bug that happens to preserve sines cannot hide.
  for (let i = 0; i < n; i++) re[i] = Math.sin(i * 1.7) * 0.6 + (i % 7) / 10 - 0.3;
  const original = Float64Array.from(re);

  fft(re, im);
  fft(re, im, true);

  assert.ok(maxDiff(re, original) < 1e-12, `round trip drifted by ${maxDiff(re, original)}`);
  assert.ok(peak(im) < 1e-12, "a real input should come back with no imaginary part");
});

test("the transform refuses a length it cannot do", () => {
  assert.throws(() => fft(new Float64Array(100), new Float64Array(100)), WaveriderError);
  assert.throws(() => fft(new Float64Array(64), new Float64Array(32)), WaveriderError);
});

test("an equal-length resample is the identity, not a round trip", () => {
  const cycle = sine(512, 3, 0.8);
  const out = resampleCycle(cycle, 512);
  assert.equal(maxDiff(out, cycle), 0, "equal lengths must be exact, not exact to within rounding");
  assert.notEqual(out, cycle, "the result must be a copy, so the caller's array is not aliased");
});

test("a constant keeps its level in both directions", () => {
  // DC is the one bin whose scaling is unambiguous, so this pins the output scale by itself.
  for (const [from, to] of [[64, 512], [2048, 512], [512, 4096]] as const) {
    const flat = new Float32Array(from).fill(0.3);
    const out = resampleCycle(flat, to);
    assert.equal(out.length, to);
    assert.ok(maxDiff(out, new Float32Array(to).fill(0.3)) < 1e-6, `${from} to ${to} changed the level`);
  }
});

test("a sine survives resizing at the same amplitude and the same harmonic", () => {
  // Upsampling: band-limited interpolation has an exact answer here, and it is the analytic sine.
  const up = resampleCycle(sine(64, 3, 0.75), 512);
  assert.ok(maxDiff(up, sine(512, 3, 0.75)) < 1e-5, `upsampled sine differs by ${maxDiff(up, sine(512, 3, 0.75))}`);

  // Downsampling: harmonic 3 is well below the new Nyquist of 32, so it must come through whole.
  const down = resampleCycle(sine(2048, 3, 0.75), 64);
  assert.ok(maxDiff(down, sine(64, 3, 0.75)) < 1e-5, `downsampled sine differs by ${maxDiff(down, sine(64, 3, 0.75))}`);
});

test("a harmonic above the new Nyquist disappears instead of folding back", () => {
  /*
   * **This is the test linear interpolation fails.** Harmonic 20 cannot exist in 32 points, whose
   * Nyquist is 16. The right answer is silence. Decimation would return harmonic 12 at nearly full
   * amplitude, which keeps the peak and moves the pitch, and sounds like a worse oscillator rather
   * than like a fault.
   */
  const aliased = resampleCycle(sine(64, 20, 1), 32);
  assert.ok(peak(aliased) < 1e-6, `harmonic 20 folded back into 32 points at ${peak(aliased)}`);

  // And the harmonics that do fit are untouched by its removal.
  const mixed = new Float32Array(64);
  const low = sine(64, 5, 0.5);
  const high = sine(64, 20, 0.5);
  for (let i = 0; i < 64; i++) mixed[i] = low[i]! + high[i]!;
  const kept = resampleCycle(mixed, 32);
  assert.ok(maxDiff(kept, sine(32, 5, 0.5)) < 1e-5, "removing the high harmonic disturbed the low one");
});

test("resizing refuses a length that is not a power of two", () => {
  assert.throws(() => resampleCycle(sine(64, 1), 100), WaveriderError);
  assert.throws(() => resampleCycle(new Float32Array(100), 64), WaveriderError);
});

test("a non-finite point is refused rather than spread across the whole cycle", () => {
  // One NaN in the input becomes NaN in every output sample, so it has to be caught at the edge.
  const broken = sine(64, 1);
  broken[9] = NaN;
  assert.throws(() => resampleCycle(broken, 128), WaveriderError);
});
