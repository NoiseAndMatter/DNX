/**
 * Convert decoded audio into a stored sample: 16-bit, 48 kHz, mono or stereo.
 *
 * **One job: the import conversion.** DNX does it because the device takes one format only
 * (`format.ts`), and the owner's reading is that Transfer converts for the DT2 in the same way.
 *
 * ## The steps, in order
 *
 * 1. **Channels.** Mono and stereo are kept. `channels: "mono"` sums to mono by averaging. More
 *    than two channels are refused unless mono is asked for: picking two of six is a guess.
 * 2. **Rate.** Anything not at 48 kHz is resampled (`resample.ts`).
 * 3. **Rumble high-pass, optional.** Zero-phase: a 2nd-order Butterworth run forward and then
 *    backward. The pair is tuned to be -3 dB at the frequency asked for, 20 Hz by convention, and
 *    falls at 24 dB an octave below it. The Python reference applies a 2nd-order magnitude on FFT
 *    bins instead, -3 dB at the same point and 12 dB an octave.
 * 4. **Normalise, optional.** The peak is scaled to `NORMALISE_PEAK`, as in the reference.
 * 5. **16 bits.** TPDF dither of one LSB peak to peak either way, then rounding and clipping.
 *
 * ## Exact when it can be, repeatable when it cannot
 *
 * **A source that is already 16-bit at 48 kHz, with no step asked for, is copied exactly.** No
 * dither is added, because every value is already a whole number of LSBs and dither would only
 * add noise. The test is on the values, not the file's label, so an 8-bit source is exact too.
 *
 * **The dither is seeded.** The same audio with the same options produces the same bytes, so the
 * same identity (`identity.ts`). A random seed would make every re-import of a file a new sample.
 */

import { SampleError } from "./errors.js";
import { SAMPLE_RATE, storedSample, type StoredSample } from "./format.js";
import { resampleChannel } from "./resample.js";

/** The peak a normalised sample reaches: about -0.18 dBFS, as in `dnfw/bloom/sample.py`. */
export const NORMALISE_PEAK = 0.98;

/** The seed every conversion uses unless told otherwise: "DNXS". */
export const DEFAULT_DITHER_SEED = 0x444e5853;

/** The channels of a decoded file at its own rate: what `audio/readaudio.ts` returns. */
export interface SourceAudio {
  channels: readonly Float32Array[];
  sampleRate: number;
  /** What the source said it was, for the report. */
  format?: string;
}

export interface ConvertOptions {
  /** `keep` (the default) or `mono`, which averages the channels. */
  channels?: "keep" | "mono";
  /** The rumble high-pass's -3 dB point in Hz. 0 or absent means none. */
  highpassHz?: number;
  /** Scale the peak to `NORMALISE_PEAK`. Off by default. */
  normalise?: boolean;
  /** The dither's seed. The default is fixed, so conversions repeat. */
  seed?: number;
}

export interface ConvertReport {
  sourceRate: number;
  sourceChannels: number;
  sourceFormat?: string;
  resampled: boolean;
  summedToMono: boolean;
  highpassHz: number;
  /** The gain normalising applied, in dB. 0 when off. */
  gainDb: number;
  /** True when the 16-bit step added dither, false for an exact copy. */
  dithered: boolean;
  /** Points that exceeded full scale and were clipped. */
  clippedPoints: number;
}

export interface Converted {
  sample: StoredSample;
  report: ConvertReport;
}

/** A 32-bit PRNG (mulberry32): small, fast, and the same on every platform. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * One 2nd-order Butterworth high-pass pass, in place, forward or backward (RBJ cookbook,
 * Q = 1/sqrt 2, direct form II transposed in double precision).
 */
function highpassPass(x: Float64Array, cutoff: number, rate: number, backward: boolean): void {
  const w = (2 * Math.PI * cutoff) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let z1 = 0;
  let z2 = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const i = backward ? n - 1 - k : k;
    const input = x[i]!;
    const y = b0 * input + z1;
    z1 = b1 * input - a1 * y + z2;
    z2 = b2 * input - a2 * y;
    x[i] = y;
  }
}

/**
 * The single-pass cutoff that puts a forward-backward pair at -3 dB on `target`. The pair's power
 * response is `f^8 / (f^4 + c^4)^2`, which is 1/2 where `c = target * (sqrt 2 - 1)^(1/4)`.
 */
export function pairCutoff(target: number): number {
  return target * Math.pow(Math.SQRT2 - 1, 0.25);
}

/** Convert `source` into a stored sample. */
export function convertToStored(source: SourceAudio, options: ConvertOptions = {}): Converted {
  const sourceChannels = source.channels.length;
  if (sourceChannels === 0) throw new SampleError("the source has no channels");
  const frames = source.channels[0]!.length;
  if (frames === 0) throw new SampleError("the source has no frames");
  if (source.channels.some((c) => c.length !== frames)) {
    throw new SampleError("the source's channels differ in length");
  }
  if (!(source.sampleRate > 0)) {
    throw new SampleError(`the source declares a sample rate of ${source.sampleRate}`);
  }

  const wantMono = options.channels === "mono";
  if (sourceChannels > 2 && !wantMono) {
    throw new SampleError(
      `the source has ${sourceChannels} channels. A sample is mono or stereo, so import it as mono.`,
    );
  }

  // 1. Channels.
  let channels: Float32Array[];
  const summedToMono = wantMono && sourceChannels > 1;
  if (summedToMono) {
    const mono = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (const channel of source.channels) sum += channel[f]!;
      mono[f] = sum / sourceChannels;
    }
    channels = [mono];
  } else {
    channels = [...source.channels];
  }

  // 2. Rate.
  const resampled = source.sampleRate !== SAMPLE_RATE;
  if (resampled) channels = channels.map((c) => resampleChannel(c, source.sampleRate, SAMPLE_RATE));

  // Double precision from here, so the filter and the gain add no rounding of their own.
  const work = channels.map((c) => Float64Array.from(c));

  // 3. Rumble high-pass.
  const highpassHz = options.highpassHz && options.highpassHz > 0 ? options.highpassHz : 0;
  if (highpassHz > 0) {
    if (highpassHz >= SAMPLE_RATE / 4) {
      throw new SampleError(`a high-pass at ${highpassHz} Hz is not a rumble filter`);
    }
    const cutoff = pairCutoff(highpassHz);
    for (const channel of work) {
      highpassPass(channel, cutoff, SAMPLE_RATE, false);
      highpassPass(channel, cutoff, SAMPLE_RATE, true);
    }
  }

  // 4. Normalise.
  let gainDb = 0;
  if (options.normalise) {
    let peak = 0;
    for (const channel of work) for (const v of channel) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) {
      const gain = NORMALISE_PEAK / peak;
      for (const channel of work) for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * gain;
      gainDb = 20 * Math.log10(gain);
    }
  }

  // 5. 16 bits: exact when every value is already a whole LSB in range, dithered otherwise.
  const outFrames = work[0]!.length;
  const count = work.length;
  const exact = work.every((channel) =>
    channel.every((v) => {
      const scaled = v * 32_768;
      return scaled === Math.round(scaled) && scaled >= -32_768 && scaled <= 32_767;
    }),
  );

  const pcm = new Int16Array(outFrames * count);
  let clippedPoints = 0;
  const random = prng(options.seed ?? DEFAULT_DITHER_SEED);
  for (let f = 0; f < outFrames; f++) {
    for (let c = 0; c < count; c++) {
      let scaled = work[c]![f]! * 32_768;
      if (!exact) scaled = Math.round(scaled + (random() - random()));
      if (scaled > 32_767) {
        scaled = 32_767;
        clippedPoints++;
      } else if (scaled < -32_768) {
        scaled = -32_768;
        clippedPoints++;
      }
      pcm[f * count + c] = scaled;
    }
  }

  return {
    sample: storedSample(count, pcm),
    report: {
      sourceRate: source.sampleRate,
      sourceChannels,
      ...(source.format === undefined ? {} : { sourceFormat: source.format }),
      resampled,
      summedToMono,
      highpassHz,
      gainDb,
      dithered: !exact,
      clippedPoints,
    },
  };
}
