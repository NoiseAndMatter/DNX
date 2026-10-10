/**
 * Reading a pattern index that came **out of a project**, where the number can be damaged.
 *
 * rivvi's `AM REBECCA` holds 196 in a song row. Drawing that row called `summarise`, which asserts
 * its index, and the `RangeError` took down the manager's whole `render()` — including the line
 * that reveals **Save to +Drive…**. The project that needed rescuing off the +Drive was the only
 * one that could not be sent to it.
 *
 * These assertions keep the two readers apart: `summarise` is loud for a caller that chose the
 * index, `storedPatternName` is quiet for a caller that read it out of stored bytes.
 *
 * No corpus and no image: an out-of-range index must be answered **before** anything is read, so
 * an empty array is the strongest fixture there is. If the guard is ever removed, these fail by
 * throwing rather than by finding nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DN1_DEVICE,
  DN2_DEVICE,
  storedPatternName,
} from "@noiseandmatter/dnx-core/librarian/device.js";

/** Nothing may be read from this. Any read is a bug the assertions below will show as a throw. */
const NO_IMAGE = new Uint8Array(0);

test("an index no project has reads as no name, not as an error", () => {
  assert.equal(DN2_DEVICE.patternCount, 128);

  // The number from rivvi's song row.
  assert.equal(storedPatternName(DN2_DEVICE, NO_IMAGE, 196), undefined);

  // The rest of the boundary, each a thing a damaged record can hold.
  assert.equal(storedPatternName(DN2_DEVICE, NO_IMAGE, DN2_DEVICE.patternCount), undefined);
  assert.equal(storedPatternName(DN2_DEVICE, NO_IMAGE, -1), undefined);
  assert.equal(storedPatternName(DN2_DEVICE, NO_IMAGE, 1.5), undefined);
  assert.equal(storedPatternName(DN2_DEVICE, NO_IMAGE, Number.NaN), undefined);
  assert.equal(storedPatternName(DN2_DEVICE, NO_IMAGE, 0xffff), undefined);

  // The DN1 answers for its own count rather than the DN2's, so the guard is the device's.
  assert.equal(storedPatternName(DN1_DEVICE, NO_IMAGE, DN1_DEVICE.patternCount), undefined);
});

test("a caller that chose the index still hears about it", () => {
  // The whole reason `storedPatternName` exists rather than `summarise` being softened: a typo in
  // a call site should be loud, and only a number read out of a project should be forgiven.
  assert.throws(() => DN2_DEVICE.summarise(NO_IMAGE, 196), RangeError);
  assert.throws(() => DN2_DEVICE.summarise(NO_IMAGE, -1), RangeError);
});

test("an index the project does have is not short-circuited", () => {
  // It must reach the read rather than being waved through as "no name" — otherwise the guard
  // would hide every name instead of the impossible ones. With no bytes behind it the read fails,
  // and that failure is the proof it was attempted.
  for (const index of [0, 1, DN2_DEVICE.patternCount - 1]) {
    assert.throws(
      () => storedPatternName(DN2_DEVICE, NO_IMAGE, index),
      (error: unknown) =>
        error instanceof Error && !/out of range/.test(error.message),
      `index ${index} is inside the project and must be read, not refused`,
    );
  }
});
