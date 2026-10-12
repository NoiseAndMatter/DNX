/**
 * The stacked perspective view's geometry.
 *
 * **The fixtures are built here, byte by byte, and not with any helper from the module under
 * test.** A table built by the code being checked can agree with a bug in it — a decimation that
 * drops a peak and a builder that never wrote one produce a passing test about nothing. These
 * write big-endian samples with a `DataView` and assert against values worked out by hand.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WaveriderError } from "../packages/core/src/waverider/errors.js";
import {
  WATERFALL_VIEW,
  type WaterfallView,
  framePlace,
  frameOutline,
  waterfall,
} from "../packages/core/src/waverider/waterfall.js";

/** A table whose sample at (wave, point) is exactly what `shape` says, as int16 big-endian. */
function table(waves: number, points: number, shape: (wave: number, point: number) => number) {
  const bytes = new Uint8Array(waves * points * 2);
  const view = new DataView(bytes.buffer);
  for (let wave = 0; wave < waves; wave++) {
    for (let point = 0; point < points; point++) {
      view.setInt16((wave * points + point) * 2, shape(wave, point), false);
    }
  }
  return bytes;
}

const GEOMETRY = (waves: number, points: number) => ({ waves, points });

test("a full-scale sample reads as exactly plus or minus one", () => {
  // 0x8000 is -32,768 and must come back as -1; 0x7fff is 32,767, a hair short of +1.
  // `steps` equal to `points` gives one sample per bucket, so each value below is a decode and
  // not a decimation. The extra final point is the last sample again, closing the path.
  const samples: readonly number[] = [32767, -32768, 0, 16384];
  const bytes = table(1, 4, (_wave, point) => samples[point] ?? 0);
  const outline = frameOutline(bytes, GEOMETRY(1, 4), 0, 4);
  assert.equal(outline.length, 5);
  assert.ok(Math.abs((outline[0] ?? 0) - 32767 / 32768) < 1e-9, `first was ${String(outline[0])}`);
  assert.deepEqual(outline.slice(1), [-1, 0, 0.5, 0.5]);
});

test("decimation keeps the peak in its bucket, with its sign", () => {
  // 64 points, decimated to 4 segments, so each bucket is 16 points. Every bucket is quiet except
  // for one spike, and a nearest-sample decimation would miss all four of them.
  const spikes = new Map([
    [7, -30000],
    [20, 25000],
    [40, -12000],
    [55, 32000],
  ]);
  const bytes = table(1, 64, (_wave, point) => spikes.get(point) ?? 100);
  const outline = frameOutline(bytes, GEOMETRY(1, 64), 0, 4);
  assert.equal(outline.length, 5);
  const peak = (at: number): number => outline[at] ?? 0;
  assert.ok(peak(0) < -0.9, `bucket 0 lost its negative spike: ${peak(0)}`);
  assert.ok(peak(1) > 0.7, `bucket 1 lost its spike: ${peak(1)}`);
  assert.ok(peak(2) < -0.3, `bucket 2 lost its spike: ${peak(2)}`);
  assert.ok(peak(3) > 0.9, `bucket 3 lost its spike: ${peak(3)}`);
});

test("frame 1 is the furthest, and the last frame is a whole tilt nearer", () => {
  const far = framePlace(0, 64, WATERFALL_VIEW);
  assert.equal(far.x0, WATERFALL_VIEW.originX);
  assert.equal(far.y0, WATERFALL_VIEW.originY);
  assert.equal(far.width, WATERFALL_VIEW.width);
  assert.equal(far.amplitude, WATERFALL_VIEW.amplitude);

  const near = framePlace(63, 64, WATERFALL_VIEW);
  assert.equal(near.x0, WATERFALL_VIEW.originX - WATERFALL_VIEW.spread);
  assert.equal(near.y0, WATERFALL_VIEW.originY + WATERFALL_VIEW.tilt);
  assert.equal(near.width, WATERFALL_VIEW.width + WATERFALL_VIEW.widen);
  assert.equal(near.amplitude, WATERFALL_VIEW.amplitude + WATERFALL_VIEW.grow);
  // Lower, wider and taller: that is the whole of the perspective.
  assert.ok(near.y0 > far.y0 && near.amplitude > far.amplitude && near.width > far.width);
});

test("a single-wave table sits at the near end rather than dividing by zero", () => {
  const place = framePlace(0, 1, WATERFALL_VIEW);
  assert.equal(place.x0, WATERFALL_VIEW.originX);
  assert.equal(place.y0, WATERFALL_VIEW.originY);
  const drawn = waterfall(table(1, 8, () => 0), GEOMETRY(1, 8));
  assert.equal(drawn.frames.length, 1);
  assert.equal(drawn.frames.at(0)?.depth, 0);
});

test("frames come back furthest first so painting in order puts the near ones on top", () => {
  const drawn = waterfall(table(4, 8, () => 0), GEOMETRY(4, 8));
  // Frame 1 (index 0) is the furthest, so it is painted first and the nearest is painted last.
  assert.deepEqual(drawn.frames.map((f) => f.index), [0, 1, 2, 3]);
  assert.equal(drawn.frames.at(0)?.depth, 0);
  assert.equal(drawn.frames.at(-1)?.depth, 1);
  const place = (index: number) => framePlace(index, 4, WATERFALL_VIEW);
  assert.ok(
    place(3).y0 > place(0).y0,
    "the frame painted last must be the lower, nearer one or the stack is drawn back to front",
  );
});

test("the reported box contains every point of every path", () => {
  // A square wave at full scale, so the extremes are real and not a rounding artefact.
  const bytes = table(16, 32, (_wave, point) => (point < 16 ? 32767 : -32768));
  const drawn = waterfall(bytes, GEOMETRY(16, 32), 8);
  const { x, y, width, height } = drawn.box;
  let checked = 0;
  for (const frame of drawn.frames) {
    for (const match of frame.d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
      const px = Number(match[1] ?? NaN);
      const py = Number(match[2] ?? NaN);
      assert.ok(px >= x && px <= x + width, `x ${px} outside ${x}..${x + width}`);
      assert.ok(py >= y && py <= y + height, `y ${py} outside ${y}..${y + height}`);
      checked++;
    }
  }
  // A regex that matched nothing would make every assertion above vacuous.
  assert.ok(checked >= drawn.frames.length * 33, `only ${checked} path points were parsed`);
  assert.equal(drawn.viewBox, `${x} ${y} ${width} ${height}`);
});

test("the marker appears only for a frame that exists", () => {
  const bytes = table(8, 16, () => 0);
  assert.equal(waterfall(bytes, GEOMETRY(8, 16)).marker, undefined);
  assert.equal(waterfall(bytes, GEOMETRY(8, 16), 8).marker, undefined);
  assert.equal(waterfall(bytes, GEOMETRY(8, 16), -1).marker, undefined);
  const named = waterfall(bytes, GEOMETRY(8, 16), 3).marker;
  assert.ok(named && named.startsWith("M"), `expected a path, got ${String(named)}`);
});

test("a table shorter than its geometry is refused rather than read past its end", () => {
  const short = table(4, 16, () => 0).subarray(0, 100);
  assert.throws(
    () => waterfall(short, GEOMETRY(4, 16)),
    (error: unknown) =>
      error instanceof WaveriderError &&
      /needs 128 bytes and this table has 100/.test(error.message),
  );
});

test("a sample format the pool cannot load is refused by name", () => {
  assert.throws(
    () => waterfall(table(2, 8, () => 0), { waves: 2, points: 8, sampleFormat: 7 }),
    (error: unknown) => error instanceof WaveriderError && /format 7/.test(error.message),
  );
});

test("a geometry that cannot describe a table is refused", () => {
  const bytes = table(2, 8, () => 0);
  assert.throws(() => waterfall(bytes, GEOMETRY(0, 8)), WaveriderError);
  assert.throws(() => waterfall(bytes, GEOMETRY(2, 1)), WaveriderError);
  assert.throws(() => waterfall(bytes, GEOMETRY(2.5, 8)), WaveriderError);
});

test("steps must be positive, because zero segments is a frame nobody can see", () => {
  const view: WaterfallView = { ...WATERFALL_VIEW, steps: 0 };
  assert.throws(() => waterfall(table(2, 8, () => 0), GEOMETRY(2, 8), undefined, view), WaveriderError);
});

test("a wider spread moves the far frame and the box follows it", () => {
  const bytes = table(32, 64, (wave, point) => (point < 32 ? 1 : -1) * 1000 * (wave + 1));
  const narrow = waterfall(bytes, GEOMETRY(32, 64), undefined, { ...WATERFALL_VIEW, spread: 100 });
  const wide = waterfall(bytes, GEOMETRY(32, 64), undefined, { ...WATERFALL_VIEW, spread: 400 });
  assert.ok(
    wide.box.width > narrow.box.width,
    `a 400 spread should need a wider box than 100: ${wide.box.width} vs ${narrow.box.width}`,
  );
});
