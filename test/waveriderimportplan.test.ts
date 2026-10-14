/**
 * Assembling one import, and placing a drop of several.
 *
 * The assertions worth their place are the two that pin down a field somebody will later "fix" into
 * agreeing with the probe's own version of this: the source hash is of the **file**, not of the
 * converted table, and the gain is the conversion's rather than 1. Both are right for a different
 * reason than the probe's are, and both look wrong next to it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  placeFrom,
  planImport,
  stemFromFileName,
} from "@noiseandmatter/dnx-core/waverider/importplan.js";
import { readTableSamples } from "@noiseandmatter/dnx-core/waverider/convert.js";
import { buildSlotFile } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

/** A source whose samples are a quiet sine, so the gain is not 1 and the peak is known. */
function quietSine(samples: number, peak = 0.25): { bytes: Uint8Array; samples: Float32Array } {
  const values = new Float32Array(samples);
  for (let i = 0; i < samples; i++) values[i] = peak * Math.sin((2 * Math.PI * i) / 512);
  // Bytes deliberately unrelated to the samples: the point is that the hash is of the file.
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
  return { bytes, samples: values };
}

test("a filename becomes a name stem", () => {
  assert.equal(stemFromFileName("01 Basic Sine2Saw.wav"), "01 Basic Sine2Saw");
  assert.equal(stemFromFileName("  padded.aiff  "), "padded");
  assert.equal(stemFromFileName("no-extension"), "no-extension");
  assert.equal(stemFromFileName("two.dots.here.wav"), "two.dots.here");
});

test("a planned import is the bytes the write path will take", () => {
  const source = quietSine(16 * 512);
  const { pending, fit, converted } = planImport(source, {
    slot: 9,
    stem: "Pulse narrowing",
    geometry: { waves: 16, points: 512 },
  });

  assert.equal(pending.slot, 9);
  assert.equal(pending.waves, 16);
  assert.equal(pending.points, 512);
  assert.equal(pending.table.length, 2 * 16 * 512);
  assert.equal(fit.method, "exact", "a source that already matches should not be resampled");

  // The name carries the convention, which nothing reads back.
  assert.equal(pending.name, "Pulse narrowing_wt512");

  // And the whole thing has to satisfy the builder, which refuses everything the firmware refuses.
  assert.ok(buildSlotFile(pending).length > 0);
  assert.equal(converted.payload, pending.table);
});

test("the source hash is of the file, not of the converted table", () => {
  /*
   * The probe's `pendingFrom` hashes the table, correctly: there the chosen file already *is* the
   * table. Here the file is audio, so hashing the payload would make the same WAV imported at two
   * geometries record two different sources, and a re-import at the same geometry unrecognisable.
   */
  const source = quietSine(16 * 512);
  const { pending } = planImport(source, {
    slot: 0,
    stem: "x",
    geometry: { waves: 16, points: 512 },
  });

  assert.equal(pending.sourceHash, xxHash32(source.bytes));
  assert.equal(pending.sourceSize, source.bytes.length);
  assert.notEqual(pending.sourceHash, xxHash32(pending.table), "this is hashing the table");

  // The same file at a second geometry keeps the same source record.
  const other = planImport(source, { slot: 1, stem: "x", geometry: { waves: 8, points: 1024 } });
  assert.equal(other.pending.sourceHash, pending.sourceHash);
  assert.notEqual(other.pending.table.length, 0);
});

test("the gain recorded is the one the conversion applied", () => {
  // A source peaking at 0.25 is normalised by 4, and the device will not undo it.
  const { pending, converted } = planImport(quietSine(16 * 512, 0.25), {
    slot: 0,
    stem: "quiet",
    geometry: { waves: 16, points: 512 },
  });

  assert.ok(Math.abs(converted.peak - 0.25) < 1e-6, `peak measured as ${converted.peak}`);
  assert.ok(Math.abs(pending.gain - 4) < 1e-4, `gain recorded as ${pending.gain}, want about 4`);
  assert.notEqual(pending.gain, 1, "a gain of 1 would claim nothing was scaled");

  // Normalised means full scale, which is the level the player reads.
  let worst = 0;
  for (const value of readTableSamples(pending.table)) worst = Math.max(worst, Math.abs(value));
  assert.equal(worst, 32_767);
});

test("the interpolation flag is clear by default and shows in the name when set", () => {
  const source = quietSine(8 * 256);
  const plain = planImport(source, { slot: 0, stem: "t", geometry: { waves: 8, points: 256 } });
  assert.equal(plain.pending.interpolate, true);
  assert.equal(plain.pending.name, "t_wt256");

  const raw = planImport(source, {
    slot: 0,
    stem: "t",
    geometry: { waves: 8, points: 256 },
    interpolate: false,
  });
  assert.equal(raw.pending.interpolate, false);
  assert.equal(raw.pending.name, "t_wt256r");
});

test("a source that has to be resampled still produces a complete table", () => {
  const source = quietSine(44_100);
  const { pending, fit } = planImport(source, {
    slot: 3,
    stem: "recording",
    geometry: { waves: 16, points: 512 },
  });
  assert.equal(fit.method, "interpolated");
  assert.equal(pending.table.length, 2 * 16 * 512);
  assert.ok(buildSlotFile(pending).length > 0);
});

test("a slot outside the store is refused before any work is done", () => {
  const source = quietSine(16 * 512);
  const geometry = { waves: 16, points: 512 };
  assert.throws(() => planImport(source, { slot: -1, stem: "x", geometry }), WaveriderError);
  assert.throws(() => planImport(source, { slot: 256, stem: "x", geometry }), WaveriderError);
  assert.throws(() => planImport(source, { slot: 1.5, stem: "x", geometry }), WaveriderError);
});

test("a drop lands on consecutive free slots", () => {
  const placed = placeFrom(80, 3, new Set());
  assert.deepEqual(placed.slots, [80, 81, 82]);
  assert.deepEqual(placed.skipped, []);
});

test("a drop steps over what is already claimed and says which", () => {
  /*
   * Skipping rather than refusing, which is the opposite of the batch control's rule. Nothing is
   * written by a drop, and a staged table can be dragged elsewhere or discarded, so landing the
   * files visibly and naming the slots passed over beats refusing and leaving somebody to count
   * free slots by eye.
   */
  const placed = placeFrom(80, 3, new Set([81, 82, 84]));
  assert.deepEqual(placed.slots, [80, 83, 85]);
  assert.deepEqual(placed.skipped, [81, 82, 84]);
});

test("a drop that cannot place everything stages nothing and says so", () => {
  // Three files from slot 254, with 255 taken: only one slot available.
  assert.throws(
    () => placeFrom(254, 3, new Set([255])),
    (error: unknown) =>
      error instanceof WaveriderError && /need 3 free slots from 254 upward and there is 1/.test(error.message),
  );
  // And a single file at the very end of a full store.
  assert.throws(() => placeFrom(255, 1, new Set([255])), WaveriderError);
});

test("placing is refused outside the store", () => {
  assert.throws(() => placeFrom(256, 1, new Set()), WaveriderError);
  assert.throws(() => placeFrom(-1, 1, new Set()), WaveriderError);
  assert.throws(() => placeFrom(0, 0, new Set()), WaveriderError);
});
