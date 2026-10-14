/**
 * Reading a table over time, checked against the analytic answer rather than against itself.
 *
 * The preview exists so somebody can hear whether an import came out right, which means a preview
 * that reads the table differently from the instrument is worse than no preview at all: it makes a
 * wrong import sound correct. So the two things the firmware session told us the player does
 * — interpolate between samples, and interpolate between frames — each get a test that fails if
 * this stops doing them.
 *
 * `fadeSeconds: 0` throughout. The fade is a preview nicety and it would mask every edge value
 * these tests are about.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTable } from "@noiseandmatter/dnx-core/waverider/oscillator.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

/** `waves` frames, each filled with its own constant from `levels`. */
function flatFrames(levels: readonly number[], points: number): Float32Array {
  const out = new Float32Array(levels.length * points);
  levels.forEach((level, w) => out.fill(level, w * points, (w + 1) * points));
  return out;
}

function peak(a: ArrayLike<number>): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]!));
  return worst;
}

test("a sine table renders as a sine at the asked-for pitch", () => {
  const points = 2048;
  const samples = new Float32Array(points);
  for (let i = 0; i < points; i++) samples[i] = Math.sin((2 * Math.PI * i) / points);

  const sampleRate = 48_000;
  const frequency = 220;
  const out = renderTable(
    { samples, waves: 1, points, fullScale: 1 },
    { sampleRate, frequency, seconds: 0.02, fadeSeconds: 0 },
  );

  for (let n = 0; n < out.length; n++) {
    const want = Math.sin((2 * Math.PI * frequency * n) / sampleRate);
    assert.ok(Math.abs(out[n]! - want) < 1e-4, `sample ${n}: ${out[n]} want ${want}`);
  }
});

test("a fractional frame sits between its two neighbours", () => {
  // Frame 0 is -1 everywhere and frame 1 is +1, so the mix is readable straight off the output.
  const samples = flatFrames([-1, 1], 64);
  const common = { sampleRate: 8000, frequency: 100, seconds: 0.01, fadeSeconds: 0 };

  for (const [frame, want] of [[0, -1], [1, 1], [0.5, 0], [0.25, -0.5], [0.75, 0.5]] as const) {
    const out = renderTable({ samples, waves: 2, points: 64, fullScale: 1 }, { ...common, frame });
    for (let n = 0; n < out.length; n++) {
      assert.ok(Math.abs(out[n]! - want) < 1e-6, `frame ${frame} sample ${n}: ${out[n]} want ${want}`);
    }
  }
});

test("a frame beyond the table is clamped rather than read off the end", () => {
  const samples = flatFrames([-1, 1], 64);
  const out = renderTable(
    { samples, waves: 2, points: 64, fullScale: 1 },
    { sampleRate: 8000, frequency: 100, seconds: 0.005, frame: 9, fadeSeconds: 0 },
  );
  for (let n = 0; n < out.length; n++) {
    assert.ok(Math.abs(out[n]! - 1) < 1e-6, `sample ${n} should be the last frame, got ${out[n]}`);
  }
});

test("the cycle wraps, so the last point interpolates into the first", () => {
  /*
   * Four points, with only the last one set. Phase between 3 and 4 must read point 3 against
   * point 0, not against something past the end of the frame. Without the wrap the read is
   * `samples[4]`, which is `undefined` and makes every such sample NaN.
   */
  const samples = Float32Array.from([0, 0, 0, 1]);
  const out = renderTable(
    { samples, waves: 1, points: 4, fullScale: 1 },
    { sampleRate: 8000, frequency: 1000, seconds: 0.01, fadeSeconds: 0 },
  );
  for (let n = 0; n < out.length; n++) {
    assert.ok(Number.isFinite(out[n]!), `sample ${n} is ${out[n]}, so the cycle did not wrap`);
  }
  // Phase advances by 0.5 points per sample here, so every other sample lands halfway between
  // point 3 and point 0, which is 0.5. None may exceed the table's own peak.
  assert.ok(peak(out) <= 1 + 1e-6, `the wrap produced ${peak(out)}, above the table's own peak`);
  assert.ok(out.some((value) => Math.abs(value - 0.5) < 1e-6), "no sample landed between 1 and 0");
});

test("full scale is applied, so an int16 table comes back in -1..1", () => {
  const points = 512;
  const samples = new Int16Array(points);
  for (let i = 0; i < points; i++) samples[i] = Math.round(32_767 * Math.sin((2 * Math.PI * i) / points));

  const out = renderTable(
    { samples, waves: 1, points, fullScale: 32_767 },
    { sampleRate: 44_100, frequency: 261.63, seconds: 0.02, fadeSeconds: 0 },
  );
  assert.ok(peak(out) <= 1 + 1e-6, `an int16 table rendered to ${peak(out)}`);
  assert.ok(peak(out) > 0.99, `a full-scale int16 table rendered only to ${peak(out)}`);
});

test("a sweep visits every frame, not just the two ends", () => {
  /*
   * The middle frame is the opposite of both ends, so a sweep that actually reads frame 1 swings
   * to +1 halfway through and a crossfade straight from frame 0 to frame 2 never leaves -1.
   * Levels of -1, 0, +1 would not separate those two: blending the ends gives 0 in the middle as
   * well, which is why the obvious fixture is the wrong one here.
   */
  const samples = flatFrames([-1, 1, -1], 64);
  const out = renderTable(
    { samples, waves: 3, points: 64, fullScale: 1 },
    { sampleRate: 8000, frequency: 100, seconds: 0.05, sweep: true, fadeSeconds: 0 },
  );

  assert.ok(Math.abs(out[0]! + 1) < 1e-6, `a sweep began at ${out[0]}, not on frame 0`);
  assert.ok(Math.abs(out[out.length - 1]! + 1) < 1e-6, `a sweep ended at ${out[out.length - 1]}`);
  const middle = out[out.length >> 1]!;
  assert.ok(middle > 0.99, `halfway through a sweep the middle frame read ${middle}, not +1`);
});

test("the fade is applied at both ends and nowhere else", () => {
  const samples = flatFrames([1], 64);
  const sampleRate = 8000;
  const out = renderTable(
    { samples, waves: 1, points: 64, fullScale: 1 },
    { sampleRate, frequency: 100, seconds: 0.1, fadeSeconds: 0.005 },
  );
  assert.equal(out[0], 0, "the first sample should be fully faded");
  assert.ok(Math.abs(out[out.length - 1]!) < 1e-6, "the last sample should be fully faded");
  // 40 samples of fade at each end of 800, so the middle is untouched.
  assert.ok(Math.abs(out[400]! - 1) < 1e-6, `the middle was faded too, to ${out[400]}`);
});

test("a render that cannot be done is refused", () => {
  const samples = flatFrames([1], 64);
  const table = { samples, waves: 1, points: 64, fullScale: 1 };
  const options = { sampleRate: 8000, frequency: 100, seconds: 0.01 };

  // The sample count must match the geometry, as it must everywhere else.
  assert.throws(() => renderTable({ ...table, waves: 2 }, options), WaveriderError);
  assert.throws(() => renderTable({ ...table, waves: 0 }, options), WaveriderError);
  assert.throws(() => renderTable({ ...table, points: 1.5 }, options), WaveriderError);
  assert.throws(() => renderTable({ ...table, fullScale: 0 }, options), WaveriderError);
  assert.throws(() => renderTable(table, { ...options, sampleRate: 0 }), WaveriderError);
  assert.throws(() => renderTable(table, { ...options, frequency: -1 }), WaveriderError);
  assert.throws(() => renderTable(table, { ...options, seconds: 0 }), WaveriderError);
});
