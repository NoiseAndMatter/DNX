/**
 * Change a channel's sample rate with a windowed-sinc interpolator.
 *
 * **One job: floats at one rate in, floats at another rate out.** Band-limited, so content above
 * the lower of the two Nyquist frequencies is removed before it can alias.
 *
 * ## The filter
 *
 * A sinc with 24 zero crossings each side, under a Kaiser window with beta 9 (stopband about
 * -90 dB). The cutoff is 0.97 of the lower Nyquist, so a 44.1 kHz source keeps everything to
 * about 21.4 kHz. The kernel is tabulated at 512 points per zero crossing and read with linear
 * interpolation, which handles any pair of rates the same way: there is no rational-ratio
 * polyphase bank to size.
 *
 * The Python reference (`dnfw/bloom/sample.py`) resamples by FFT over the whole file. This does
 * the same job in the time domain, because a 10-minute stereo file would need one FFT of 29
 * million points, and memory then grows with the file instead of with the kernel.
 *
 * ## Cost
 *
 * About 50 taps per output point when going up in rate, and more when going down (the kernel
 * widens with the ratio). The edges are padded with silence.
 */

const ZERO_CROSSINGS = 24;
const KAISER_BETA = 9;
const CUTOFF = 0.97;
const TABLE_STEPS = 512;

/** The modified Bessel function of the first kind, order 0, by its series. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= quarter / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

let table: Float64Array | undefined;

/** The windowed sinc at u = 0, 1/512, 2/512 … 24, plus one guard point for interpolation. */
function kernelTable(): Float64Array {
  if (table) return table;
  const points = ZERO_CROSSINGS * TABLE_STEPS + 2;
  const out = new Float64Array(points);
  const norm = besselI0(KAISER_BETA);
  for (let i = 0; i < points; i++) {
    const u = i / TABLE_STEPS;
    const ratio = u / ZERO_CROSSINGS;
    const window = ratio >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - ratio * ratio)) / norm;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    out[i] = sinc * window;
  }
  table = out;
  return out;
}

/** The output length for `frames` input frames: `round(frames * to / from)`, at least 1. */
export function resampledLength(frames: number, from: number, to: number): number {
  return Math.max(1, Math.round((frames * to) / from));
}

/** Resample one channel from `from` Hz to `to` Hz. The same rate returns a copy. */
export function resampleChannel(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return Float32Array.from(input);
  const kernel = kernelTable();
  const n = input.length;
  const m = resampledLength(n, from, to);
  const out = new Float32Array(m);

  // The cutoff, in cycles per input sample relative to the input's Nyquist.
  const fc = CUTOFF * Math.min(1, to / from);
  // How far either side of the centre the kernel reaches, in input samples.
  const reach = ZERO_CROSSINGS / fc;
  const step = from / to;

  for (let j = 0; j < m; j++) {
    const x = j * step;
    const first = Math.max(0, Math.ceil(x - reach));
    const last = Math.min(n - 1, Math.floor(x + reach));
    let sum = 0;
    for (let i = first; i <= last; i++) {
      const u = Math.abs(x - i) * fc * TABLE_STEPS;
      const k = Math.floor(u);
      if (k >= ZERO_CROSSINGS * TABLE_STEPS) continue;
      const frac = u - k;
      const g = kernel[k]! + (kernel[k + 1]! - kernel[k]!) * frac;
      sum += input[i]! * g;
    }
    out[j] = sum * fc;
  }
  return out;
}
