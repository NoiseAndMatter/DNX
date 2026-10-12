/**
 * Making an arbitrary run of samples into a table's geometry: how many frames, and how long each.
 *
 * **One job: a sample count and a shape go in, exactly `waves * points` samples come out.**
 * Decoding the file is the browser's (`decodeAudioData`), packing the result into int16 is
 * `convert.ts`, resizing one cycle without aliasing is `spectral.ts`, and judging whether the
 * instrument will play the shape is `pool.ts`. This is the part that chooses a shape and makes the
 * source fit it, and **it never judges**: it proposes, and the caller decides.
 *
 * That split is deliberate. `unplayableReason` is the judge and it changes when the firmware's
 * reported bounds change; this file would otherwise have to change with it, and a second opinion
 * about playability is how a pane comes to show a table as fine while the write path refuses it.
 *
 * ## Why anything has to be chosen at all
 *
 * `convertTable` requires the sample count to match the geometry exactly, and says why: a wavetable
 * is cut into equal waves, so a source that does not divide has to be trimmed or resampled before
 * it gets there. A file on a hard drive has whatever length it has. Something has to choose, and
 * the honest version of choosing is to propose a shape, say how confident that proposal is, and let
 * it be overridden.
 *
 * **A sample count cannot identify a geometry.** 131,072 samples is 64 x 2048 and 32 x 4096 and
 * 128 x 1024 and 256 x 512, all exactly. `proposeGeometry` picks by convention, not by measurement,
 * and `exact` says only that the division had no remainder — never that the shape is the right one.
 * This is the same limit `wavepoolread.ts` records for a store listing, met from the other side.
 *
 * ## What the instrument will actually play
 *
 * From the firmware session on 2026-10-13, naming its own source (`csrc/wrstore/store.h`
 * `wr_store_playable`, `csrc/wrstore/modinfo.c`): a table plays only if its used flag is set, kind
 * is 1, `sampleFormat` is 1, `waves` is 1 to 64, `points` is 64 to 4096 **and a power of two**, its
 * start equals its own slot's extent, and its length is exactly `2 * waves * points`. **The loader
 * does not resample.** Anything failing a clause is stored and listed and plays the built-in
 * waveform, which is the whole reason this file exists rather than sending a source as it came.
 *
 * Those bounds arrive as an argument rather than as a constant here, because the build that reports
 * them is one build: a stock instrument plays one geometry and says nothing, and the caller knows
 * which it is talking to.
 *
 * ## Level is not restored by the instrument
 *
 * Also from the firmware session, and it matters to anyone reading this next: **the gain the
 * conversion stores at entry +96 is a record that nothing reads.** No `csrc/` file references it and
 * the DSP's request directory carries only waves and points per entry. So peak-normalising an
 * import is a permanent change to how loud that table is, not a normalisation the player undoes.
 * Nothing in this file normalises anything; the choice belongs to whoever calls `convertTable`, and
 * it should be made knowing that.
 */

import { WaveriderError } from "./errors.js";
import { POOL_POINTS, POOL_WAVES, type PlayableBounds } from "./pool.js";
import { isPowerOfTwo, resampleCycle } from "./spectral.js";

/** Frames, and points per frame. */
export interface Geometry {
  waves: number;
  points: number;
}

/**
 * What the instrument says it will play.
 *
 * **The judge's own type, not a second one.** `unplayableReason` decides whether a table plays and
 * takes `PlayableBounds`; this file decides what shape to make and takes the same thing. They were
 * briefly two identical shapes in two files, which is the arrangement where one of them gains a
 * field and the other quietly stops agreeing with it.
 */
export type FitBounds = PlayableBounds;

/**
 * The one geometry a build reporting no playable capability loads.
 *
 * Expressed as bounds so it can be passed anywhere bounds are wanted. Note that a stock build
 * plays this pair and **only** this pair, so a proposal of 8 x 512 sits inside these bounds and is
 * still not playable there. That judgement is `unplayableReason`'s, which is why this file does not
 * make it.
 */
export const STOCK_BOUNDS: FitBounds = {
  maxWaves: POOL_WAVES,
  minPoints: POOL_POINTS,
  maxPoints: POOL_POINTS,
  pointsPowerOfTwo: true,
};

/**
 * Single-cycle lengths to try, in the order they are worth trying.
 *
 * 2,048 first because it is what Serum, Vital and the public wavetable packs export, so a file
 * that divides by 2,048 almost certainly *is* frames of 2,048. Then 1,024 and 4,096, the other two
 * in common use. The small sizes are last: a 256-sample cycle divides almost any file, so trying it
 * early would make every proposal 256 and the convention would stop carrying information.
 */
const CONVENTIONAL_POINTS: readonly number[] = [2048, 1024, 4096, 512, 256, 128, 64];

/** A shape a sample count could be, and how much the proposal is worth. */
export interface GeometryProposal {
  geometry: Geometry;
  /**
   * Whether the sample count divided into this shape with no remainder.
   *
   * `true` means the file *can* be this shape, never that it is: several shapes usually divide
   * exactly and this one was chosen by convention. `false` means nothing divided and the source
   * will be resampled to fit.
   */
  exact: boolean;
  /** One sentence for a pane to show, saying what was decided and on what grounds. */
  reason: string;
}

function allowedPoints(bounds: FitBounds): number[] {
  return CONVENTIONAL_POINTS.filter(
    (points) =>
      points >= bounds.minPoints &&
      points <= bounds.maxPoints &&
      (!bounds.pointsPowerOfTwo || isPowerOfTwo(points)),
  );
}

/**
 * The shape to stage a file at, before anybody overrides it.
 *
 * Tries the conventional cycle lengths in order and takes the first that divides the count exactly
 * and leaves a frame count inside the bounds. Failing that, proposes the largest allowed cycle
 * length that fits in the file at all, with the frame count rounded, and says it will be resampled.
 */
export function proposeGeometry(sampleCount: number, bounds: FitBounds): GeometryProposal {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    throw new WaveriderError(`a sample count must be a positive integer, got ${sampleCount}`);
  }
  const candidates = allowedPoints(bounds);
  if (candidates.length === 0) {
    throw new WaveriderError(
      `no conventional cycle length fits between ${bounds.minPoints} and ${bounds.maxPoints} points` +
        `${bounds.pointsPowerOfTwo ? " with points a power of two" : ""}`,
    );
  }

  for (const points of candidates) {
    if (sampleCount % points !== 0) continue;
    const waves = sampleCount / points;
    if (waves < 1 || waves > bounds.maxWaves) continue;
    return {
      geometry: { waves, points },
      exact: true,
      reason:
        `${sampleCount.toLocaleString()} samples divides into ${waves} frames of ${points} points ` +
        `exactly. Other shapes divide it too, so this is the convention rather than a measurement.`,
    };
  }

  /*
   * Nothing divided. Take the largest allowed cycle length the file can fill at least once, so the
   * frames keep as much of the source's detail as the instrument will hold, and round the frame
   * count to the nearest whole one rather than truncating: a file 1.9 frames long is better read as
   * 2 stretched frames than as 1 with nearly half of it discarded.
   */
  const points = candidates.reduce(
    (best, candidate) => (candidate <= sampleCount && candidate > best ? candidate : best),
    Math.min(...candidates),
  );
  const waves = Math.min(bounds.maxWaves, Math.max(1, Math.round(sampleCount / points)));

  /*
   * **Say which of the two things went wrong, because they call for opposite actions.**
   *
   * Reaching here means no *allowed* shape divided the count, and that happens two ways. Either
   * nothing divides it at all, and the file is not a wavetable export, or something divides it
   * perfectly and this build will not play that shape. Reporting the second as the first tells
   * somebody holding a correct 64 x 2048 table that their file does not divide, and they go and
   * re-export a file that was already right. Seen on a stock build, where the only allowed length
   * is 512 and a 16 x 2048 file lands here.
   */
  const divides = CONVENTIONAL_POINTS.filter((candidate) => sampleCount % candidate === 0)
    .map((candidate) => `${sampleCount / candidate} x ${candidate}`);
  // Three at most. A count like 32,768 divides seven ways, and listing all of them turns a useful
  // sentence into a wall nobody reads. They are already in order of how likely each is to be what
  // the file actually is, so the first few are the ones worth naming.
  const named = divides.slice(0, 3).join(" or ");
  const others = divides.length - 3;

  return {
    geometry: { waves, points },
    exact: false,
    reason:
      divides.length === 0
        ? `${sampleCount.toLocaleString()} samples is not a whole number of frames at any ` +
          `conventional cycle length, so this is ${waves} frames of ${points} points with the ` +
          `source resampled to fit.`
        : `${sampleCount.toLocaleString()} samples divides exactly as ${named}` +
          `${others > 0 ? ` and ${others} other shapes` : ""}, and this instrument plays none of ` +
          `them, so this is ${waves} frames of ${points} points with the source resampled to fit.`,
  };
}

/** How the samples were made to fit. */
export type FitMethod =
  /** The count already matched. Nothing was resampled. */
  | "exact"
  /** Every frame was a power-of-two cycle, resized band-limited through the transform. */
  | "spectral"
  /** The frames were spans of a recording, resized by interpolation. */
  | "interpolated";

export interface FitResult {
  /** Exactly `geometry.waves * geometry.points` samples, ready for `convertTable`. */
  samples: Float32Array;
  geometry: Geometry;
  method: FitMethod;
  /** Source samples each frame was taken from. Fractional when the count did not divide. */
  sourceFramePoints: number;
  /** One sentence for a pane, naming the method and what it cost. */
  reason: string;
}

/**
 * Resample one span of `src` to `points` values.
 *
 * `start` and `end` are fractional positions in `src`, because `total / waves` rarely divides. The
 * span is read as a cycle: output `i` sits at phase `i / points` across it, so the last output
 * point lands just before `end` rather than on it and a frame joins its neighbour without a
 * repeated sample.
 *
 * **Downsampling by more than half averages rather than interpolates.** Picking every third sample
 * out of a recording folds everything above the new Nyquist back into the band, and a box average
 * over each output point's own span is the cheapest thing that does not. It is a poor filter and
 * much better than none; the good path is `spectral.ts`, which this falls back from only when the
 * frame is not a power-of-two cycle and so has no harmonics to preserve.
 */
function resampleSpan(
  src: Float32Array | readonly number[],
  start: number,
  end: number,
  points: number,
): Float32Array {
  const out = new Float32Array(points);
  const span = end - start;
  const ratio = span / points;
  const last = src.length - 1;
  const at = (index: number): number => src[Math.max(0, Math.min(last, index))]!;

  if (ratio > 2) {
    for (let i = 0; i < points; i++) {
      const from = start + (i / points) * span;
      const to = start + ((i + 1) / points) * span;
      let sum = 0;
      let weight = 0;
      const first = Math.floor(from);
      const stop = Math.ceil(to);
      for (let index = first; index < stop; index++) {
        // How much of sample `index` this output point covers.
        const overlap = Math.min(index + 1, to) - Math.max(index, from);
        if (overlap <= 0) continue;
        sum += at(index) * overlap;
        weight += overlap;
      }
      out[i] = weight === 0 ? at(first) : sum / weight;
    }
    return out;
  }

  for (let i = 0; i < points; i++) {
    const position = start + (i / points) * span;
    const whole = Math.floor(position);
    const fraction = position - whole;
    out[i] = at(whole) * (1 - fraction) + at(whole + 1) * fraction;
  }
  return out;
}

/**
 * Make `samples` into exactly `waves * points` values.
 *
 * Three paths, and the result says which was taken:
 *
 * - **exact**, when the count already matches. A copy, so the caller's array is not aliased.
 * - **spectral**, when the count divides into `waves` frames whose length is a power of two. Each
 *   frame is a cycle and is resized through the transform, which is the only alias-free answer.
 * - **interpolated**, otherwise. The source is read as a recording cut into `waves` equal spans.
 */
export function fitToGeometry(
  samples: Float32Array | readonly number[],
  geometry: Geometry,
): FitResult {
  const { waves, points } = geometry;
  if (!Number.isInteger(waves) || waves <= 0) {
    throw new WaveriderError(`waves must be a positive integer, got ${waves}`);
  }
  if (!Number.isInteger(points) || points <= 0) {
    throw new WaveriderError(`points per wave must be a positive integer, got ${points}`);
  }
  const total = samples.length;
  if (total === 0) {
    throw new WaveriderError("there are no samples to fit: the file decoded to nothing");
  }

  const wanted = waves * points;
  if (total === wanted) {
    return {
      samples: Float32Array.from(samples),
      geometry,
      method: "exact",
      sourceFramePoints: points,
      reason: `${total.toLocaleString()} samples is already ${waves} x ${points}; nothing was resampled.`,
    };
  }

  const framePoints = total / waves;
  const out = new Float32Array(wanted);

  /*
   * **Both lengths have to qualify, not just the source's.** Radix-2 needs a power of two at each
   * end, so a file of 2,048-point frames asked for 500 points would otherwise pick this path on the
   * strength of its source alone and throw from inside the transform. The device's own rule makes
   * `points` a power of two for anything playable, which is exactly why the one case that is not
   * has to be handled here rather than assumed away.
   */
  if (Number.isInteger(framePoints) && isPowerOfTwo(framePoints) && isPowerOfTwo(points)) {
    const frame = new Float32Array(framePoints);
    for (let w = 0; w < waves; w++) {
      const base = w * framePoints;
      for (let i = 0; i < framePoints; i++) frame[i] = samples[base + i]!;
      out.set(resampleCycle(frame, points), w * points);
    }
    return {
      samples: out,
      geometry,
      method: "spectral",
      sourceFramePoints: framePoints,
      reason:
        `${waves} frames of ${framePoints} points resized to ${points}, through the transform, so ` +
        `no harmonic folded back into the band.`,
    };
  }

  for (let w = 0; w < waves; w++) {
    const start = (w * total) / waves;
    const end = ((w + 1) * total) / waves;
    out.set(resampleSpan(samples, start, end, points), w * points);
  }
  return {
    samples: out,
    geometry,
    method: "interpolated",
    sourceFramePoints: framePoints,
    reason:
      `${total.toLocaleString()} samples read as ${waves} spans of ` +
      `${framePoints.toFixed(1)} and resized to ${points} points each. The spans are not whole ` +
      `cycles, so they were interpolated rather than transformed.`,
  };
}
