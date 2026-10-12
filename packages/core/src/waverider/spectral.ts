/**
 * Resizing one cycle of a waveform, without the aliasing that plain interpolation would add.
 *
 * **One job: a cycle of N points becomes a cycle of M points, and nothing else changes.** Which
 * cycles to cut out of a file, and how many, is `fit.ts`. Turning the result into bytes is
 * `convert.ts`. This is the arithmetic in between, and it is here on its own because it is the one
 * part a test can pin down exactly: a sine stays a sine, a saw loses the harmonics that no longer
 * fit and keeps the ones that do, and both are checked against values computed by hand.
 *
 * ## Why not linear interpolation
 *
 * A wavetable frame is a single cycle, so it is periodic by construction, and its harmonics are
 * exactly the bins of its DFT. Resizing in the frequency domain is therefore not an approximation
 * of the right answer, it *is* the right answer: dropping the bins above the new Nyquist is what
 * anti-aliasing means for periodic data, and keeping them all while adding zeroes above is
 * band-limited interpolation.
 *
 * Linear interpolation gets both directions wrong, and gets them wrong in a way that sounds like a
 * worse oscillator rather than like a bug. Going down from 2048 points to 512, every harmonic above
 * the 256th folds back into the audible band and detunes the result. Going up, it inserts corners
 * that are new harmonics the source never had. A 64 x 2048 table imported from Serum and squeezed
 * into 16 x 512 by interpolation is the exact case this exists for, and it is the common one.
 *
 * ## What it costs when the frame is not a power of two
 *
 * Radix-2 needs a power-of-two length, and `pointsPowerOfTwo` in the device's own capability bits
 * says the player wants one too, so every geometry worth writing lands here. A source span that is
 * *not* a power of two has no cycle structure to preserve anyway: it came from chopping an
 * arbitrary recording into equal pieces, and `fit.ts` sends those down its own path and says which
 * it used. This file refuses rather than silently doing something else.
 */

import { WaveriderError } from "./errors.js";

/** Whether `n` is a positive power of two, which both the FFT and the player require. */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * In-place complex FFT, radix-2 Cooley-Tukey, length a power of two.
 *
 * `inverse` conjugates the twiddles and divides by the length, so `fft(re, im); fft(re, im, true)`
 * returns the input to within floating-point error. Exported because `spectral.test.ts` checks
 * that round trip directly, which is the cheapest possible guard on the butterflies.
 *
 * The twiddle factors are computed with `Math.cos`/`Math.sin` per butterfly rather than by
 * advancing a running complex multiply. The running form is the faster one and it accumulates
 * phase error across a stage, which at 4,096 points shows up as a low-level noise floor in the
 * result: the kind of wrong that passes a listening test and fails a numeric one. These sizes are
 * small enough that the trig is not worth optimising away.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (im.length !== n) {
    throw new WaveriderError(`real and imaginary parts differ in length: ${n} and ${im.length}`);
  }
  if (!isPowerOfTwo(n)) {
    throw new WaveriderError(`this FFT is radix-2 and ${n} is not a power of two`);
  }

  // Bit-reversal permutation, so the butterflies below can run in place.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        const a = start + k;
        const b = a + half;
        const uRe = re[a]!;
        const uIm = im[a]!;
        const vRe = re[b]! * wRe - im[b]! * wIm;
        const vIm = re[b]! * wIm + im[b]! * wRe;
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * One cycle of `cycle.length` points, resampled to `points`, band-limited.
 *
 * Both lengths must be powers of two. Equal lengths return a copy rather than a round trip through
 * the transform, so the common case of a table already at the target geometry is exact rather than
 * exact-to-within-rounding.
 *
 * ## The Nyquist bin is dropped, deliberately
 *
 * At the folding frequency a real signal's bin carries a cosine whose phase cannot be recovered,
 * so there is no correct amplitude to carry across to a different length: splitting it invents
 * phase, keeping it whole doubles the energy at one frequency. It is one bin out of hundreds, at
 * the very top of the band, and dropping it is the only choice that is not a guess. Written down
 * because somebody comparing a round trip at equal lengths against this path will find the
 * difference and should find the reason with it.
 */
export function resampleCycle(cycle: Float32Array | readonly number[], points: number): Float32Array {
  const n = cycle.length;
  if (!isPowerOfTwo(n)) {
    throw new WaveriderError(
      `a cycle of ${n} points cannot be resampled here: this path is radix-2 and needs a power of two`,
    );
  }
  if (!isPowerOfTwo(points)) {
    throw new WaveriderError(`${points} points is not a power of two`);
  }

  if (points === n) return Float32Array.from(cycle);

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const value = cycle[i]!;
    if (!Number.isFinite(value)) {
      throw new WaveriderError(`point ${i} of this cycle is ${value}, which cannot be resampled`);
    }
    re[i] = value;
  }
  fft(re, im);

  const outRe = new Float64Array(points);
  const outIm = new Float64Array(points);
  // Harmonics that exist in both lengths, below the lower of the two Nyquists.
  const keep = Math.min(n, points) >> 1;
  outRe[0] = re[0]!;
  outIm[0] = im[0]!;
  for (let k = 1; k < keep; k++) {
    outRe[k] = re[k]!;
    outIm[k] = im[k]!;
    // The conjugate half, so the inverse transform comes back real.
    outRe[points - k] = re[n - k]!;
    outIm[points - k] = im[n - k]!;
  }

  fft(outRe, outIm, true);

  /*
   * An unnormalised forward transform of length n followed by a normalised inverse of length
   * `points` scales every amplitude by n / points, so this puts it back. Without it, squeezing
   * 2,048 points into 512 would come out four times too quiet — and the conversion that follows
   * peak-normalises, so the error would be invisible on a single table and would show up only as
   * two tables of the same material disagreeing about their stored gain.
   */
  const scale = points / n;
  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) out[i] = outRe[i]! * scale;
  return out;
}
