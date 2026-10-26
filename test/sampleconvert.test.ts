/**
 * The import conversion: rate, channels, high-pass, normalising and 16 bits.
 *
 * The sources are synthesised here as floats, so each property is measured against a signal whose
 * true value is known: a sine's frequency and level, a constant's mean, a DC offset. Nothing is
 * compared against output from the code under test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToStored, NORMALISE_PEAK, pairCutoff } from "@noiseandmatter/dnx-core/sample/convert.js";
import { resampledLength } from "@noiseandmatter/dnx-core/sample/resample.js";
import { SampleError } from "@noiseandmatter/dnx-core/sample/errors.js";
import { identify } from "@noiseandmatter/dnx-core/sample/identity.js";

function sine(frequency: number, rate: number, seconds: number, level = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = level * Math.sin((2 * Math.PI * frequency * i) / rate);
  return out;
}

/** RMS of `pcm` (one channel of `channels`) over the middle half, as a fraction of full scale. */
function middleRms(pcm: Int16Array, channels = 1, channel = 0): number {
  const frames = pcm.length / channels;
  const from = Math.floor(frames / 4);
  const to = Math.floor((3 * frames) / 4);
  let sum = 0;
  for (let f = from; f < to; f++) sum += (pcm[f * channels + channel]! / 32_768) ** 2;
  return Math.sqrt(sum / (to - from));
}

const db = (ratio: number): number => 20 * Math.log10(ratio);

test("a 16-bit 48 kHz source with no steps is copied exactly, without dither", () => {
  const points = Int16Array.from([0, 1, -1, 32_767, -32_768, 1234, -4321]);
  const channel = Float32Array.from(points, (v) => v / 32_768);
  const { sample, report } = convertToStored({ channels: [channel], sampleRate: 48_000 });
  assert.deepEqual([...sample.pcm], [...points]);
  assert.equal(report.dithered, false);
  assert.equal(report.resampled, false);
  assert.equal(report.clippedPoints, 0);
});

test("stereo is kept interleaved, left first", () => {
  const left = Float32Array.from([1, 2, 3], (v) => v / 32_768);
  const right = Float32Array.from([-1, -2, -3], (v) => v / 32_768);
  const { sample } = convertToStored({ channels: [left, right], sampleRate: 48_000 });
  assert.equal(sample.channels, 2);
  assert.equal(sample.frames, 3);
  assert.deepEqual([...sample.pcm], [1, -1, 2, -2, 3, -3]);
});

test("the same source and options give the same bytes, so the same identity", () => {
  const source = { channels: [sine(440, 44_100, 0.2, 0.3)], sampleRate: 44_100 };
  const a = convertToStored(source);
  const b = convertToStored(source);
  assert.equal(a.report.dithered, true);
  assert.deepEqual(identify(a.sample), identify(b.sample));
  assert.notDeepEqual(identify(convertToStored(source, { seed: 7 }).sample), identify(a.sample));
});

test("44.1 kHz becomes 48 kHz with the tone's frequency and level kept", () => {
  const source = sine(1000, 44_100, 1, 0.5);
  const { sample, report } = convertToStored({ channels: [source], sampleRate: 44_100 });
  assert.equal(report.resampled, true);
  assert.equal(sample.frames, resampledLength(44_100, 44_100, 48_000));
  assert.equal(sample.frames, 48_000);
  // The level: a 0.5 sine has an RMS of 0.5 / sqrt 2.
  assert.ok(Math.abs(db(middleRms(sample.pcm) / (0.5 / Math.SQRT2))) < 0.05);
  // The frequency: compare against the ideal 1 kHz sine at 48 kHz, sample for sample.
  let worst = 0;
  for (let f = 12_000; f < 36_000; f++) {
    const ideal = 0.5 * Math.sin((2 * Math.PI * 1000 * f) / 48_000);
    worst = Math.max(worst, Math.abs(sample.pcm[f]! / 32_768 - ideal));
  }
  assert.ok(worst < 5e-4, `worst error ${worst}`);
});

test("going down from 96 kHz removes content above the new Nyquist instead of folding it", () => {
  // 30 kHz would alias to 18 kHz at 48 kHz.
  const { sample } = convertToStored({ channels: [sine(30_000, 96_000, 0.5, 0.5)], sampleRate: 96_000 });
  assert.equal(sample.frames, 24_000);
  assert.ok(db(middleRms(sample.pcm) / (0.5 / Math.SQRT2)) < -70);
  // And a tone well below the cutoff passes.
  const pass = convertToStored({ channels: [sine(5_000, 96_000, 0.5, 0.5)], sampleRate: 96_000 }).sample;
  assert.ok(Math.abs(db(middleRms(pass.pcm) / (0.5 / Math.SQRT2))) < 0.05);
});

test("the rumble high-pass is -3 dB at its frequency, removes DC and passes the audio band", () => {
  const at = (frequency: number): number => {
    const { sample } = convertToStored({ channels: [sine(frequency, 48_000, 4, 0.5)], sampleRate: 48_000 }, { highpassHz: 20 });
    return db(middleRms(sample.pcm) / (0.5 / Math.SQRT2));
  };
  assert.ok(Math.abs(at(20) + 3) < 0.1, `20 Hz at ${at(20)} dB`);
  assert.ok(Math.abs(at(1000)) < 0.05);
  assert.ok(at(5) < -40, `5 Hz at ${at(5)} dB`);

  const offset = Float32Array.from(sine(1000, 48_000, 4, 0.2), (v) => v + 0.3);
  const { sample, report } = convertToStored({ channels: [offset], sampleRate: 48_000 }, { highpassHz: 20 });
  assert.equal(report.highpassHz, 20);
  let mean = 0;
  for (let f = 48_000; f < 144_000; f++) mean += sample.pcm[f]! / 32_768;
  assert.ok(Math.abs(mean / 96_000) < 1e-3);
  assert.ok(pairCutoff(20) < 20);
});

test("normalising scales the peak to NORMALISE_PEAK and reports the gain", () => {
  const { sample, report } = convertToStored({ channels: [sine(100, 48_000, 0.1, 0.25)], sampleRate: 48_000 }, { normalise: true });
  const peak = Math.max(...[...sample.pcm].map(Math.abs)) / 32_768;
  assert.ok(Math.abs(peak - NORMALISE_PEAK) < 2 / 32_768);
  assert.ok(Math.abs(report.gainDb - db(NORMALISE_PEAK / 0.25)) < 0.01);
});

test("TPDF dither leaves the quantisation unbiased", () => {
  // A constant a quarter of an LSB: rounding alone gives 0 every time, dither averages to 0.25.
  const level = 0.25 / 32_768;
  const channel = new Float32Array(200_000).fill(level);
  const { sample } = convertToStored({ channels: [channel], sampleRate: 48_000 }, { normalise: false, highpassHz: 0, seed: 3 });
  // Float32 holds 0.25 LSB exactly, so the exact path is not taken by accident.
  const mean = sample.pcm.reduce((sum, v) => sum + v, 0) / sample.pcm.length;
  assert.ok(Math.abs(mean - 0.25) < 0.01, `mean ${mean}`);
  assert.ok(sample.pcm.every((v) => v >= -2 && v <= 2));
});

test("mono averages the channels, and more than two channels need it", () => {
  const a = Float32Array.from([0.5, 0.5]);
  const b = Float32Array.from([-0.5, 0.25]);
  const { sample, report } = convertToStored({ channels: [a, b], sampleRate: 48_000 }, { channels: "mono" });
  assert.equal(report.summedToMono, true);
  assert.deepEqual([...sample.pcm], [0, 0.375 * 32_768]);

  const six = Array.from({ length: 6 }, () => new Float32Array(4));
  assert.throws(() => convertToStored({ channels: six, sampleRate: 48_000 }), SampleError);
  assert.equal(convertToStored({ channels: six, sampleRate: 48_000 }, { channels: "mono" }).sample.channels, 1);
});

test("points past full scale are clipped and counted", () => {
  const { sample, report } = convertToStored({ channels: [Float32Array.from([1.5, -1.5, 0])], sampleRate: 48_000 });
  assert.deepEqual([...sample.pcm.slice(0, 2)], [32_767, -32_768]);
  assert.equal(report.clippedPoints, 2);
});

test("a source with no frames, uneven channels or no rate is refused", () => {
  assert.throws(() => convertToStored({ channels: [], sampleRate: 48_000 }), SampleError);
  assert.throws(() => convertToStored({ channels: [new Float32Array(0)], sampleRate: 48_000 }), SampleError);
  assert.throws(() => convertToStored({ channels: [new Float32Array(2), new Float32Array(3)], sampleRate: 48_000 }), SampleError);
  assert.throws(() => convertToStored({ channels: [new Float32Array(2)], sampleRate: 0 }), SampleError);
  assert.throws(() => convertToStored({ channels: [new Float32Array(2)], sampleRate: 48_000 }, { highpassHz: 20_000 }), SampleError);
});
