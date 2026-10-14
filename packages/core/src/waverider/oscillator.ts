/**
 * Playing a table the way the instrument plays it, as samples rather than as sound.
 *
 * **One job: a table and a pitch go in, audio comes out.** Opening an `AudioContext` and pushing
 * the result at a speaker is the web layer's; this is the arithmetic, and it is here so a test can
 * check it without a browser. What the preview is *for* is hearing whether an import came out
 * right, and a preview that reads the table differently from the instrument would be worse than
 * none: it would make a wrong import sound correct.
 *
 * ## Interpolation is copied from the player, not chosen
 *
 * From the firmware session on 2026-10-13: **the player interpolates between neighbouring samples
 * and between neighbouring frames, always.** `flags` bit 1, the do-not-interpolate bit, is stored
 * and never read, and the only flag the firmware tests is bit 0. So this interpolates in both
 * directions too, bilinearly, and a table imported at 16 x 512 sounds here as it will there.
 *
 * Reading the table with nearest-neighbour instead would be the obvious shortcut and it would make
 * every table sound harsher than the instrument makes it, which is exactly the kind of difference
 * somebody would spend an afternoon chasing in the converter.
 *
 * ## The cycle wraps
 *
 * Point `points - 1` interpolates back to point 0, not to itself. A cycle that does not wrap has a
 * discontinuity once per period, which is a buzz at the note's own frequency: loud, obvious, and
 * easy to mistake for a fault in the conversion.
 */

import { WaveriderError } from "./errors.js";

/** How to read the table over time. */
export interface RenderOptions {
  /** Samples per second to render at. The web layer passes its `AudioContext`'s own rate. */
  sampleRate: number;
  /** Hertz. 261.63 is middle C, which is what the pane previews at. */
  frequency: number;
  /** How long to render. */
  seconds: number;
  /**
   * Which frame to play, zero-based and fractional.
   *
   * Fractional on purpose: the player can sit between two frames, so a preview that could only
   * sit on one would not be able to show what the frame slider is actually doing.
   */
  frame?: number;
  /**
   * Sweep from frame 0 to the last frame over the whole render, ignoring `frame`.
   *
   * This is the one thing a wavetable does that a single frame cannot show, so it is worth a
   * control of its own rather than being something you fake by dragging the slider.
   */
  sweep?: boolean;
  /**
   * Seconds of fade at each end. 0.005 by default.
   *
   * **Not something the instrument does.** It is here because starting a buffer mid-cycle at full
   * amplitude clicks, and a click at the start of every audition is both unpleasant and easy to
   * hear as a fault in the table.
   */
  fadeSeconds?: number;
}

/** One table's samples, as `readTableSamples` or `fitToGeometry` give them. */
export interface TableSamples {
  /** `waves * points` values. Int16 from a stored table, or float from a fit. */
  samples: ArrayLike<number>;
  waves: number;
  points: number;
  /**
   * What full scale is in `samples`. 32,767 for int16 read off a table, 1 for a fit.
   *
   * Explicit rather than sniffed from the data: a quiet int16 table and a loud float one look the
   * same to a guess, and guessing wrong is either silence or a 32,000x overload.
   */
  fullScale: number;
}

/**
 * Render `table` to mono audio.
 *
 * The result is nominally in -1..1, scaled by `fullScale`. Nothing is normalised here: the point of
 * the preview is to hear the table as it is, including that it is quiet.
 */
export function renderTable(table: TableSamples, options: RenderOptions): Float32Array {
  const { samples, waves, points, fullScale } = table;
  const { sampleRate, frequency, seconds } = options;

  if (!Number.isInteger(waves) || waves <= 0) {
    throw new WaveriderError(`waves must be a positive integer, got ${waves}`);
  }
  if (!Number.isInteger(points) || points <= 0) {
    throw new WaveriderError(`points per wave must be a positive integer, got ${points}`);
  }
  if (samples.length !== waves * points) {
    throw new WaveriderError(
      `${waves} x ${points} needs ${waves * points} samples and ${samples.length} were given`,
    );
  }
  if (!(sampleRate > 0) || !(seconds > 0) || !(frequency > 0)) {
    throw new WaveriderError(
      `a render needs a positive rate, pitch and length, got ${sampleRate} Hz, ` +
        `${frequency} Hz and ${seconds} s`,
    );
  }
  if (fullScale === 0 || !Number.isFinite(fullScale)) {
    throw new WaveriderError(`full scale cannot be ${fullScale}`);
  }

  const total = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(total);
  const sweep = options.sweep === true;
  const fixed = Math.max(0, Math.min(waves - 1, options.frame ?? 0));
  // Phase advanced per output sample, in points.
  const step = (frequency * points) / sampleRate;

  let phase = 0;
  for (let n = 0; n < total; n++) {
    const framePosition = sweep ? (waves === 1 ? 0 : ((waves - 1) * n) / (total - 1 || 1)) : fixed;
    const frameLow = Math.floor(framePosition);
    const frameHigh = Math.min(waves - 1, frameLow + 1);
    const frameMix = framePosition - frameLow;

    const pointLow = Math.floor(phase);
    // The wrap: the last point interpolates into the first, because a cycle is a circle.
    const pointHigh = (pointLow + 1) % points;
    const pointMix = phase - pointLow;

    const lowBase = frameLow * points;
    const highBase = frameHigh * points;
    const a = samples[lowBase + pointLow]! * (1 - pointMix) + samples[lowBase + pointHigh]! * pointMix;
    const b = samples[highBase + pointLow]! * (1 - pointMix) + samples[highBase + pointHigh]! * pointMix;

    out[n] = (a * (1 - frameMix) + b * frameMix) / fullScale;

    phase += step;
    while (phase >= points) phase -= points;
  }

  const fade = Math.min(
    Math.floor(total / 2),
    Math.max(0, Math.round((options.fadeSeconds ?? 0.005) * sampleRate)),
  );
  for (let i = 0; i < fade; i++) {
    const gain = i / fade;
    out[i] = out[i]! * gain;
    out[total - 1 - i] = out[total - 1 - i]! * gain;
  }

  return out;
}
