/**
 * Taking whole cycles out of a file that has more of them than a table holds.
 *
 * **One job: a file of `S` cycles in, `N` of those cycles out, each one still whole.** Choosing the
 * shape is `fit.ts`, and resizing a cycle is `spectral.ts`. This decides which cycles survive.
 *
 * ## Why a pick and not a cut
 *
 * The instrument plays 64 frames at most. Wavetable packs ship 256: `ESW Analog - 303 Saw.wav`
 * is 524,288 samples, 256 cycles of 2,048, and says so in its `clm ` chunk. Cutting that into 64
 * equal parts gives parts of 8,192 samples, and each part holds 4 cycles. A frame of 4 cycles plays
 * two octaves above the note, and the instrument's screen draws four waves in one frame. The owner
 * found exactly that on 2026-11-09.
 *
 * A pick keeps one cycle per frame. There are two ways to choose which:
 *
 * - **spread**: every `S / N`th cycle from the first, so the table still travels the whole file.
 *   The default, because a sweep of the result is a sweep of the source.
 * - **window**: `N` cycles in a row from `first`, for a part of the file that changes smoothly.
 */

import { WaveriderError } from "./errors.js";
import { type Geometry } from "./fit.js";

/** Which cycles to keep. */
export type CyclePick = { mode: "spread" } | { mode: "window"; first: number };

/** The source cycle that output frame `k` of `waves` comes from. */
export function pickedCycle(source: Geometry, waves: number, pick: CyclePick, k: number): number {
  return pick.mode === "spread" ? Math.floor((k * source.waves) / waves) : pick.first + k;
}

/** The last `first` a window of `waves` cycles can start at. */
export function lastWindowStart(source: Geometry, waves: number): number {
  return Math.max(0, source.waves - waves);
}

/**
 * `waves` whole cycles of `source.points` samples each, taken from `samples`.
 *
 * The result is `waves * source.points` samples, so `fitToGeometry` then sees whole cycles and
 * resizes each one on its own.
 */
export function pickCycles(
  samples: Float32Array | readonly number[],
  source: Geometry,
  waves: number,
  pick: CyclePick,
): Float32Array {
  const { points } = source;
  if (samples.length !== source.waves * points) {
    throw new WaveriderError(
      `picking cycles needs the file to be ${source.waves} x ${points}, and it is ` +
        `${samples.length.toLocaleString()} samples`,
    );
  }
  if (!Number.isInteger(waves) || waves <= 0 || waves > source.waves) {
    throw new WaveriderError(`cannot pick ${waves} cycles from a file of ${source.waves}`);
  }
  if (pick.mode === "window") {
    const last = lastWindowStart(source, waves);
    if (!Number.isInteger(pick.first) || pick.first < 0 || pick.first > last) {
      throw new WaveriderError(
        `a window of ${waves} cycles starts at cycle 0 to ${last}, not ${pick.first}`,
      );
    }
  }

  const out = new Float32Array(waves * points);
  for (let k = 0; k < waves; k++) {
    const from = pickedCycle(source, waves, pick, k) * points;
    for (let i = 0; i < points; i++) out[k * points + i] = samples[from + i]!;
  }
  return out;
}

/** One phrase naming the pick, for the import panel: `every 4th cycle of 256`. */
export function describePick(source: Geometry, waves: number, pick: CyclePick): string {
  if (pick.mode === "window") {
    return `cycles ${pick.first + 1} to ${pick.first + waves} of ${source.waves}, in a row`;
  }
  const step = source.waves / waves;
  if (step === 1) return `all ${source.waves} cycles`;
  return Number.isInteger(step)
    ? `every ${ordinal(step)} cycle of ${source.waves}`
    : `${waves} cycles spread evenly across ${source.waves}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * How many times one frame repeats itself: 1 for a single cycle, 4 for a frame of 4 cycles.
 *
 * Checks whether the frame matches itself shifted by a half, a quarter or an eighth of its length.
 * **A hint for the preview, not a measurement.** A cycle that holds only even harmonics also
 * matches itself at a half, and reads as 2. A table that morphs fast between cycles can miss the
 * match and read as 1. The threshold allows the small change between neighbouring cycles of a
 * morphing table.
 */
export function cyclesInFrame(frame: Float32Array | Int16Array | readonly number[]): number {
  const length = frame.length;
  let energy = 0;
  for (let i = 0; i < length; i++) energy += frame[i]! ** 2;
  if (energy === 0) return 1;

  for (const count of [8, 4, 2]) {
    if (length % count !== 0) continue;
    const lag = length / count;
    let difference = 0;
    for (let i = 0; i + lag < length; i++) difference += (frame[i]! - frame[i + lag]!) ** 2;
    if (difference / energy < REPEAT_BELOW) return count;
  }
  return 1;
}

/** How close a shifted frame has to be to itself to count as a repeat. */
const REPEAT_BELOW = 0.1;
