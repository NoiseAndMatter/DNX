/**
 * Keeping whole cycles from a file that has more of them than a table holds.
 *
 * The case is the owner's, from 2026-11-09: `ESW Analog - 303 Saw.wav` is 256 cycles of 2,048, the
 * instrument plays 64 frames, and the import cut it into 64 parts of 8,192 samples. Each frame held
 * 4 cycles, and the instrument's screen drew all four. These tests build a file of that shape and
 * check every frame of the written table, not only the proposal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cyclesInFrame,
  describePick,
  lastWindowStart,
  pickCycles,
  pickedCycle,
} from "@noiseandmatter/dnx-core/waverider/cyclepick.js";
import { planImport } from "@noiseandmatter/dnx-core/waverider/importplan.js";
import { readTableSamples } from "@noiseandmatter/dnx-core/waverider/convert.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { readWavFile } from "@noiseandmatter/dnx-core/audio/wavfile.js";

const CYCLES = 256;
const POINTS = 2048;
const SOURCE = { waves: CYCLES, points: POINTS };

/**
 * 256 saw cycles, each a little louder than the last, so a frame's level names its cycle.
 *
 * The level climbs from 0.5 to 1, a small step between neighbours, as in a table that morphs.
 */
const level = (cycle: number): number => 0.5 + (0.5 * cycle) / (CYCLES - 1);
function sawFile(): Float32Array {
  const out = new Float32Array(CYCLES * POINTS);
  for (let c = 0; c < CYCLES; c++) {
    for (let i = 0; i < POINTS; i++) out[c * POINTS + i] = ((2 * i) / POINTS - 1) * level(c);
  }
  return out;
}

function framesOf(table: Int16Array, points: number): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let at = 0; at < table.length; at += points) frames.push(table.subarray(at, at + points));
  return frames;
}

function peak(frame: ArrayLike<number>): number {
  let worst = 0;
  for (let i = 0; i < frame.length; i++) worst = Math.max(worst, Math.abs(frame[i]!));
  return worst;
}

/** The source cycle a written frame came from, read back from its level against the loudest frame. */
function cycleOf(frame: Int16Array, loudest: number, loudestCycle: number): number {
  const frameLevel = (peak(frame) / loudest) * level(loudestCycle);
  return Math.round((frameLevel - 0.5) * 2 * (CYCLES - 1)) + 0;
}

test("cutting a 256-cycle file into 64 parts puts 4 cycles in every frame", () => {
  // The fault, kept as a test so the frame check below is known to see it.
  const plan = planImport(
    { bytes: new Uint8Array([1]), samples: sawFile() },
    { slot: 3, stem: "303 Saw", geometry: { waves: 64, points: POINTS } },
  );
  const frames = framesOf(readTableSamples(plan.pending.table), POINTS);
  assert.equal(frames.length, 64);
  assert.ok(frames.every((frame) => cyclesInFrame(frame) === 4), "every cut frame holds 4 cycles");
});

test("spread keeps every 4th cycle, one cycle in each frame", () => {
  const plan = planImport(
    { bytes: new Uint8Array([1]), samples: sawFile() },
    { slot: 3, stem: "303 Saw", geometry: { waves: 64, points: POINTS }, pick: { mode: "spread", source: SOURCE } },
  );
  const frames = framesOf(readTableSamples(plan.pending.table), POINTS);
  assert.equal(frames.length, 64);
  assert.ok(frames.every((frame) => cyclesInFrame(frame) === 1), "every frame holds one cycle");

  // Frame k is cycle 4k: the last frame is cycle 252, the loudest one written.
  const loudest = peak(frames[63]!);
  assert.deepEqual(
    frames.map((frame) => cycleOf(frame, loudest, 252)),
    Array.from({ length: 64 }, (_, k) => 4 * k),
  );
  assert.match(plan.fit.reason, /every 4th cycle of 256, one cycle per frame/);
  assert.equal(plan.pending.name, "303 Saw_wt2048");
});

test("a window keeps 64 cycles in a row from its start", () => {
  const plan = planImport(
    { bytes: new Uint8Array([1]), samples: sawFile() },
    {
      slot: 3,
      stem: "303 Saw",
      geometry: { waves: 64, points: POINTS },
      pick: { mode: "window", first: 100, source: SOURCE },
    },
  );
  const frames = framesOf(readTableSamples(plan.pending.table), POINTS);
  assert.ok(frames.every((frame) => cyclesInFrame(frame) === 1));
  const loudest = peak(frames[63]!);
  assert.deepEqual(
    frames.map((frame) => cycleOf(frame, loudest, 163)),
    Array.from({ length: 64 }, (_, k) => 100 + k),
  );
});

test("picked cycles are resized one by one when the table's points differ", () => {
  const plan = planImport(
    { bytes: new Uint8Array([1]), samples: sawFile() },
    { slot: 3, stem: "303 Saw", geometry: { waves: 64, points: 512 }, pick: { mode: "spread", source: SOURCE } },
  );
  assert.equal(plan.fit.method, "spectral");
  const frames = framesOf(readTableSamples(plan.pending.table), 512);
  assert.ok(frames.every((frame) => cyclesInFrame(frame) === 1));
});

test("a pick and a blend together are refused", () => {
  assert.throws(
    () =>
      planImport(
        { bytes: new Uint8Array([1]), samples: sawFile() },
        {
          slot: 3,
          stem: "x",
          geometry: { waves: 64, points: POINTS },
          pick: { mode: "spread", source: SOURCE },
          blendFrom: SOURCE,
        },
      ),
    /picked from the file's cycles or blended/,
  );
});

test("a window that does not fit, or a file of the wrong length, is refused", () => {
  const file = sawFile();
  assert.equal(lastWindowStart(SOURCE, 64), 192);
  assert.throws(() => pickCycles(file, SOURCE, 64, { mode: "window", first: 193 }), WaveriderError);
  assert.throws(() => pickCycles(file, SOURCE, 64, { mode: "window", first: -1 }), WaveriderError);
  assert.throws(() => pickCycles(file, SOURCE, 300, { mode: "spread" }), WaveriderError);
  assert.throws(() => pickCycles(file.subarray(1), SOURCE, 64, { mode: "spread" }), WaveriderError);
  // The last window that fits ends on the file's last cycle.
  assert.equal(pickedCycle(SOURCE, 64, { mode: "window", first: 192 }, 63), 255);
});

test("a spread that does not divide still starts on the first cycle and stays in the file", () => {
  const source = { waves: 100, points: 64 };
  const picked = Array.from({ length: 64 }, (_, k) => pickedCycle(source, 64, { mode: "spread" }, k));
  assert.equal(picked[0], 0);
  assert.ok(picked.every((cycle, k) => cycle < 100 && (k === 0 || cycle > picked[k - 1]!)));
  assert.equal(describePick(source, 64, { mode: "spread" }), "64 cycles spread evenly across 100");
  assert.equal(describePick(SOURCE, 64, { mode: "spread" }), "every 4th cycle of 256");
  assert.equal(describePick(SOURCE, 64, { mode: "window", first: 0 }), "cycles 1 to 64 of 256, in a row");
});

test("the frame check counts repeats, and calls silence one cycle", () => {
  const saw = Float32Array.from({ length: 2048 }, (_, i) => (2 * i) / 2048 - 1);
  const twice = Float32Array.from({ length: 2048 }, (_, i) => saw[(i * 2) % 2048]!);
  const eight = Float32Array.from({ length: 2048 }, (_, i) => saw[(i * 8) % 2048]!);
  assert.equal(cyclesInFrame(saw), 1);
  assert.equal(cyclesInFrame(twice), 2);
  assert.equal(cyclesInFrame(eight), 8);
  assert.equal(cyclesInFrame(new Float32Array(2048)), 1);
});

/** A minimal 16-bit mono WAV with a `clm ` chunk ahead of the data, as Serum writes it. */
function wavWithClm(clm: string | undefined): Uint8Array {
  const samples = 4096;
  const chunks: number[] = [];
  const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
  const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
  chunks.push(...ascii("fmt "), ...u32(16), ...u16(1), ...u16(1), ...u32(44_100), ...u32(88_200), ...u16(2), ...u16(16));
  if (clm !== undefined) {
    const body = ascii(clm);
    chunks.push(...ascii("clm "), ...u32(body.length), ...body, ...(body.length % 2 ? [0] : []));
  }
  chunks.push(...ascii("data"), ...u32(samples * 2), ...new Array<number>(samples * 2).fill(0));
  return Uint8Array.from([...ascii("RIFF"), ...u32(4 + chunks.length), ...ascii("WAVE"), ...chunks]);
}

test("a WAV's clm chunk gives its cycle length", () => {
  assert.equal(readWavFile(wavWithClm("<!>2048 20000000 wavetable (www.xferrecords.com)")).cycleLength, 2048);
  assert.equal(readWavFile(wavWithClm("<!>1024 10000000")).cycleLength, 1024);
  assert.equal(readWavFile(wavWithClm("not a declaration")).cycleLength, undefined);
  assert.equal(readWavFile(wavWithClm(undefined)).cycleLength, undefined);
});
