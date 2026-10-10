/**
 * Turning a wavetable into the stacked perspective view the Library draws.
 *
 * **One job: geometry.** Every frame of the table becomes one SVG path, placed so the table reads
 * back to front, and the box they all fit in is measured rather than guessed. Nothing here knows
 * about colour, selection, the DOM or the +Drive; the pane decides how a frame is painted and this
 * decides where it goes.
 *
 * It sits in the core rather than in `web/` because it is arithmetic with an answer a test can
 * check, and because the next caller is already visible: the expander's report wants the same
 * picture of a table it is about to write, and two copies of a projection drift.
 *
 * ## Why peak decimation and not every point
 *
 * A 64 x 512 table is 32,768 points. Drawing them all is 64 paths of 512 segments, which the
 * browser can do and nobody can see: at the width a frame occupies, several points share a pixel.
 * So each frame is decimated to `steps` segments — but by the **extreme sample in each bucket,
 * keeping its sign**, not by taking every nth one. Nearest-sample decimation of a saw at this
 * ratio drops the turning points and draws a wave that is visibly not the one stored; keeping the
 * largest magnitude keeps the peaks where they are, which is the whole point of a preview.
 *
 * ## Why the box is measured
 *
 * The far frame is wider, lower and further left than the near one, and how much of each depends
 * on the view. Hardcoding a `viewBox` that suited one set of numbers is how the bottom frame ends
 * up clipped the first time somebody widens the spread. `waterfall` walks the frames it just
 * built, takes their real extent and reports it, so the caller's `viewBox` always contains the
 * drawing.
 */

import { FORMAT_INT16_BE } from "./entries.js";
import { WaveriderError } from "./errors.js";
import { type Geometry } from "./pool.js";

/**
 * How the stack is laid out, in the units of the box `waterfall` reports.
 *
 * **Frame 1 is the furthest and the last frame is the nearest.** Each step toward the viewer
 * moves down by a share of `tilt`, left by a share of `spread`, and grows, which is what makes
 * the stack read as depth rather than as a list.
 */
export interface WaterfallView {
  /** Where the furthest frame's baseline starts. */
  originX: number;
  originY: number;
  /** The furthest frame's width, and how much wider the nearest one is. */
  width: number;
  widen: number;
  /** How far the nearest frame sits below the furthest, and how far to its left. */
  tilt: number;
  spread: number;
  /** Half-height of the furthest frame, and how much taller the nearest one is. */
  amplitude: number;
  grow: number;
  /** Segments per frame after decimation. */
  steps: number;
  /** Blank space kept around the drawing in the reported box. */
  pad: number;
}

/**
 * The view the Library uses.
 *
 * **These numbers came from the owner's chosen mockup rather than from taste**, which is why they
 * are a named constant a caller can lean on instead of a set of defaults scattered through the
 * signature. A caller that wants a different stack passes its own.
 */
export const WATERFALL_VIEW: WaterfallView = {
  originX: 260,
  originY: 70,
  width: 700,
  widen: 160,
  tilt: 250,
  spread: 260,
  amplitude: 24,
  grow: 26,
  steps: 96,
  // Enough room for a corner label to sit clear of the outermost frame rather than across it.
  pad: 22,
};

/** Where one frame's baseline sits and how big it is drawn. */
export interface FramePlace {
  x0: number;
  y0: number;
  width: number;
  amplitude: number;
}

/** One frame, placed. */
export interface WaterfallFrame {
  /** Zero-based index into the table's waves. */
  index: number;
  /** 0 for the furthest frame, 1 for the nearest. */
  depth: number;
  /** An SVG path, absolute moves and lines. */
  d: string;
}

/** Everything the pane needs to draw one table. */
export interface Waterfall {
  frames: WaterfallFrame[];
  /** The two lines along the edges of the stack, far end to near end. */
  guides: readonly [string, string];
  /** A rule under one frame's baseline, or `undefined` when no frame was named. */
  marker: string | undefined;
  /** A `viewBox` that contains every path above. */
  viewBox: string;
  /** The box's own numbers, for a caller placing its own labels. */
  box: { x: number; y: number; width: number; height: number };
}

/** Where frame `index` of `waves` sits under `view`. Index 0 is the furthest from the viewer. */
export function framePlace(index: number, waves: number, view: WaterfallView): FramePlace {
  const depth = waves <= 1 ? 0 : index / (waves - 1);
  return {
    x0: view.originX - depth * view.spread,
    y0: view.originY + depth * view.tilt,
    width: view.width + depth * view.widen,
    amplitude: view.amplitude + depth * view.grow,
  };
}

/**
 * The samples of one frame, decimated to `steps + 1` points in -1..1.
 *
 * Exported because the test checks the decimation on its own: a path string is a poor place to
 * find out that a peak moved.
 */
export function frameOutline(
  table: Uint8Array,
  geometry: Geometry,
  index: number,
  steps: number,
): number[] {
  const { points } = geometry;
  const base = index * points;
  // One view over the whole table rather than two indexed reads per sample: it reads the signed
  // big-endian value directly, and it is the difference between a bounds check per byte and none.
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const out: number[] = [];
  for (let step = 0; step <= steps; step++) {
    // The bucket this segment stands for. The last step is a single point, so the two ends of the
    // frame are the table's own first and last sample rather than an average of a short bucket.
    const from = Math.min(points - 1, Math.floor((step * points) / steps));
    const to = Math.min(points - 1, Math.max(from, Math.floor(((step + 1) * points) / steps) - 1));
    let peak = 0;
    let magnitude = -1;
    for (let at = from; at <= to; at++) {
      const sample = sampleAt(view, base + at);
      if (Math.abs(sample) > magnitude) {
        magnitude = Math.abs(sample);
        peak = sample;
      }
    }
    out.push(peak);
  }
  return out;
}

/**
 * One big-endian 16-bit sample, as -1..1.
 *
 * Scaled by 32,768 rather than 32,767, so -32,768 is exactly -1 and the scale stays symmetric
 * about zero. The cost is that full positive reads 0.99997 instead of 1, which no eye can see and
 * no arithmetic here cares about; the alternative puts the zero line off centre.
 */
function sampleAt(view: DataView, at: number): number {
  return view.getInt16(at * 2, false) / 0x8000;
}

/**
 * Place every frame of `table`, back to front, and measure the box they need.
 *
 * `current` names the frame to put a marker under, and is left out when nothing is selected.
 *
 * The frames come back **furthest first**, which here means frame 1 first, so a caller that
 * paints them in the order given gets the nearer ones over the further ones with no sorting and
 * no second pass. Emitting them the other way round draws the back of the stack over its front,
 * which looks almost right until two frames cross.
 */
export function waterfall(
  table: Uint8Array,
  geometry: Geometry,
  current?: number,
  view: WaterfallView = WATERFALL_VIEW,
): Waterfall {
  const { waves, points } = geometry;
  const format = geometry.sampleFormat ?? FORMAT_INT16_BE;

  if (format !== FORMAT_INT16_BE) {
    throw new WaveriderError(
      `sample format ${format} cannot be drawn; this view reads format ${FORMAT_INT16_BE}, ` +
        "16-bit big-endian, which is the only one the pool loads",
    );
  }
  if (!Number.isInteger(waves) || waves < 1 || !Number.isInteger(points) || points < 2) {
    throw new WaveriderError(
      `a table of ${waves} x ${points} cannot be drawn; it needs at least 1 wave of 2 points`,
    );
  }
  const needed = waves * points * 2;
  if (table.length < needed) {
    throw new WaveriderError(
      `${waves} x ${points} needs ${needed.toLocaleString()} bytes and this table has ` +
        `${table.length.toLocaleString()}. Drawing it would read past the end and show a wave ` +
        "that is not there.",
    );
  }
  if (!Number.isInteger(view.steps) || view.steps < 1) {
    throw new WaveriderError(`steps must be a positive whole number, not ${view.steps}`);
  }

  const frames: WaterfallFrame[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  // Furthest first, and index 0 is the furthest: it sits highest and smallest, and every step
  // toward `waves - 1` comes down and forward. Painting in this order leaves the nearest frame
  // last, which is the one that should occlude the others.
  for (let index = 0; index < waves; index++) {
    const place = framePlace(index, waves, view);
    const outline = frameOutline(table, geometry, index, view.steps);
    const parts: string[] = [];
    for (const [step, sample] of outline.entries()) {
      const x = place.x0 + (step / view.steps) * place.width;
      const y = place.y0 - sample * place.amplitude;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      parts.push(`${step === 0 ? "M" : "L"}${round(x)} ${round(y)}`);
    }
    frames.push({
      index,
      depth: waves <= 1 ? 0 : index / (waves - 1),
      d: parts.join(" "),
    });
  }

  const far = framePlace(0, waves, view);
  const near = framePlace(waves - 1, waves, view);
  const guides: readonly [string, string] = [
    `M${round(far.x0)} ${round(far.y0)} L${round(near.x0)} ${round(near.y0)}`,
    `M${round(far.x0 + far.width)} ${round(far.y0)} ` +
      `L${round(near.x0 + near.width)} ${round(near.y0)}`,
  ];

  let marker: string | undefined;
  if (current !== undefined && Number.isInteger(current) && current >= 0 && current < waves) {
    const place = framePlace(current, waves, view);
    const y = place.y0 + place.amplitude + 10;
    marker = `M${round(place.x0)} ${round(y)} L${round(place.x0 + place.width)} ${round(y)}`;
    if (y > maxY) maxY = y;
  }

  // **Rounded outward, and the box and the `viewBox` are the same numbers.** Rounding the string
  // and leaving `box` exact let the two disagree, and a box rounded to the nearest unit can come
  // out a fraction smaller than the drawing, which clips the outermost peak. Floor the origin,
  // ceil the size, report one set of numbers.
  const x = Math.floor(minX - view.pad);
  const y = Math.floor(minY - view.pad);
  const width = Math.ceil(maxX + view.pad) - x;
  const height = Math.ceil(maxY + view.pad) - y;
  return {
    frames,
    guides,
    marker,
    viewBox: `${x} ${y} ${width} ${height}`,
    box: { x, y, width, height },
  };
}

/** Two decimals, without a trailing `.00` on every coordinate. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
