/**
 * Pattern records OS 1.11 sends as storage version 4.
 *
 * Found by the release test run: Open device showed every pattern of the loaded project as
 * "v4 unreadable version". The record is the version-3 size and parses as version 3, so it is now
 * read with that layout and kept out of every operation that writes.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PATTERN, RECORD_VERSION, TRACK_SIZE_BY_VERSION, asVersion3, recordVersion } from "@noiseandmatter/dnx-core/project/dn2pattern.js";
import { DN2_LAYOUT, patternRecord } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { DN2_SPEC } from "@noiseandmatter/dnx-core/project/spec.js";
import { soundLockedSlots } from "@noiseandmatter/dnx-core/project/dn2pattern.js";
import { planPatternMerge } from "@noiseandmatter/dnx-core/expand/merge.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import { CORPUS } from "./corpus.js";

test("version 4 is read with the version-3 track size", () => {
  assert.equal(TRACK_SIZE_BY_VERSION[4], TRACK_SIZE_BY_VERSION[RECORD_VERSION]);
});

test("normalising a version-4 record changes only its version field", () => {
  /*
   * **The trap this guards.** The re-pack for narrower versions writes four settings bytes at the end
   * of each track's shorter block. At equal width that position is the start of the next track, so a
   * version-4 record run through the version-2 path came back with every later track's first four
   * bytes overwritten.
   */
  const record = new Uint8Array(DN2_LAYOUT.patternSize);
  for (let i = 0; i < record.length; i++) record[i] = (i * 31 + 7) & 0xff;
  new DataView(record.buffer).setUint32(PATTERN.versionOffset, 4, false);

  const normalised = asVersion3(record);
  assert.equal(recordVersion(normalised), RECORD_VERSION);
  assert.equal(recordVersion(record), 4, "the caller's record still says what was sent");
  const moved = [...normalised.keys()].filter((i) => normalised[i] !== record[i]);
  assert.ok(moved.every((i) => i < 4), `bytes outside the version field changed: ${moved.filter((i) => i >= 4).slice(0, 8)}`);
});

// --- the record captured off the instrument -------------------------------------------------------------

const DUMP = CORPUS && join(CORPUS, "..", "99_HardwareTest", "dump_A1_patternkit_os1.11_factory.bin");
const TEMPLATE = CORPUS && join(CORPUS, "02_DN2", "01_Projects", "004 SKETCHPAD.dn2prj");
const skip = !(DUMP && TEMPLATE && existsSync(DUMP) && existsSync(TEMPLATE)) &&
  "needs the version-4 A1 captured from factory OS 1.11 in the private corpus";

test("A1 of factory PRESETS, as OS 1.11 sends it, reads and stays unwritable", { skip }, () => {
  const dump = new Uint8Array(readFileSync(DUMP!));
  assert.equal(dump.length, DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize);
  assert.equal(recordVersion(dump.subarray(0, DN2_LAYOUT.patternSize)), 4);

  const image = decodeProjectImage(parseProject(new Uint8Array(readFileSync(TEMPLATE!))).payload.raw).image;
  image.set(dump.subarray(0, DN2_LAYOUT.patternSize), DN2_LAYOUT.headerSize);
  image.set(dump.subarray(DN2_LAYOUT.patternSize), DN2_LAYOUT.kitBase);

  const summary = deviceFor(image).summarise(image, 0);
  assert.equal(summary.readable, true);
  assert.equal(summary.supported, false, "read, never written");
  assert.equal(summary.name, "LIGHTHOUSE");
  assert.equal(summary.trigCount, 199);
});

// --- and yet a version-4 pattern can still be copied --------------------------------------------

/**
 * A whole OS 1.11 project, read off the instrument on 2026-09-22 and kept in the private corpus.
 *
 * `004 SKETCHPAD.dn2prj` beside it is the same project **before** 1.11 upgraded it, at version 3.
 */
const OS111 = CORPUS && join(CORPUS, "02_DN2", "03_OS111", "004 SKETCHPAD OS111.dn2prj");
const skipCopy = !(OS111 && existsSync(OS111)) &&
  "needs the OS 1.11 project in the private corpus under 02_DN2/03_OS111";

function imageOf(path: string): Uint8Array {
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

/** Every byte offset inside a pattern record that holds a sound lock. */
function lockByteOffsets(): Set<number> {
  const { trackOffset, trackSize, soundLockOffset, lockTrackCount } = DN2_SPEC.pattern;
  const out = new Set<number>();
  for (let t = 0; t < lockTrackCount; t++) {
    const base = trackOffset + t * trackSize + soundLockOffset;
    for (let step = 0; step < DN2_SPEC.stepCount; step++) out.add(base + step);
  }
  return out;
}

/** A version-4 pattern that locks sounds, and a version-4 pattern that locks none. */
function subject(image: Uint8Array): { pattern: number; empty: number } {
  let pattern = -1;
  let empty = -1;
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    let version: number;
    try { version = recordVersion(patternRecord(image, p, DN2_LAYOUT)); } catch { continue; }
    if (version !== 4) continue;
    const locks = soundLockedSlots(patternRecord(image, p, DN2_LAYOUT));
    if (pattern < 0 && locks.size > 0) pattern = p;
    if (empty < 0 && locks.size === 0) empty = p;
  }
  if (pattern < 0 || empty < 0) throw new Error("no locked and free version-4 pattern in the fixture");
  return { pattern, empty };
}

test("OS 1.11 writes version 4 across a whole project", { skip: skipCopy }, () => {
  // The premise the two below rest on. 1.11 upgraded every stored project on the instrument it was
  // installed on, so on such a machine there is no version-3 project left to work on.
  const image = imageOf(OS111!);
  let v4 = 0;
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    try { if (recordVersion(patternRecord(image, p, DN2_LAYOUT)) === 4) v4++; } catch { /* uninitialised */ }
  }
  assert.ok(v4 > 100, `expected most of 128 patterns at version 4, found ${v4}`);
});

test("copying a version-4 pattern inside its own project changes not one byte of it", { skip: skipCopy }, () => {
  /*
   * **A copy does not interpret the record, and this is the strongest form of saying so.**
   *
   * A rearrange rewrites a record in place and must know what its fields mean, which is why it is
   * right to refuse version 4. A copy moves the record as a unit. Source and destination share a
   * pool here, so no lock needs re-pointing and the whole 89,088-byte record must arrive untouched.
   */
  const image = imageOf(OS111!);
  const { pattern, empty } = subject(image);
  const plan = planPatternMerge({
    source: image, patterns: [pattern], destination: image, landing: empty, confirmOverwrite: true,
  });

  assert.equal(plan.rerouted, 0, "same pool, so no lock should have moved");
  assert.deepEqual(
    [...patternRecord(plan.image, empty, DN2_LAYOUT)],
    [...patternRecord(image, pattern, DN2_LAYOUT)],
    "the record did not survive the copy unchanged",
  );
});

test("copying a version-4 pattern out changes only its sound-lock bytes", { skip: skipCopy }, () => {
  /*
   * The real case: a different project with a different pool, so locks genuinely move. Every byte
   * the copy touches must be a lock byte — those are the only offsets it claims to understand, and
   * `TRACK_SIZE_BY_VERSION` gives versions 3 and 4 the same track size, so they do not move
   * between the two.
   *
   * Measured when this was written: 89 bytes changed, all 89 of them locks.
   */
  const source = imageOf(OS111!);
  const destination = imageOf(TEMPLATE!);   // the same project at version 3, before the upgrade
  const { pattern } = subject(source);
  const landing = 120;

  const plan = planPatternMerge({
    source, patterns: [pattern], destination, landing, confirmOverwrite: true,
  });

  const before = patternRecord(source, pattern, DN2_LAYOUT);
  const after = patternRecord(plan.image, landing, DN2_LAYOUT);
  const locks = lockByteOffsets();
  const changed: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i);

  assert.ok(plan.rerouted > 0, "no lock moved, so this proves nothing about re-pointing");
  assert.deepEqual(changed.filter((i) => !locks.has(i)), [],
    "the copy changed a byte outside the sound-lock area, so it is interpreting a record " +
      "whose version it does not write");
  assert.equal(changed.length, plan.rerouted, "every changed byte should be a re-pointed lock");
  assert.equal(recordVersion(after), 4, "the landed record is still version 4");
});
