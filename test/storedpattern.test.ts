/**
 * Reading a pattern index that came **out of a project**, where the number can be damaged.
 *
 * rivvi's `AM REBECCA` holds 196 in a song row. Drawing that row called `summarise`, which asserts
 * its index, and the `RangeError` took down the manager's whole `render()` — including the line
 * that reveals **Save to +Drive…**. The project that needed rescuing off the +Drive was the only
 * one that could not be sent to it.
 *
 * These assertions keep the two readers apart: `summarise` is loud for a caller that chose the
 * index, `storedPattern` is quiet for a caller that read it out of stored bytes.
 *
 * **What changed on 2026-10-13**: quiet is not the same as silent. The owner asked that a project
 * detected as damaged say so, so the answer is now three cases rather than a name and `undefined`
 * — and the one that matters is that *out of range* and *unnamed* can never be confused again.
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
  storedPattern,
} from "@noiseandmatter/dnx-core/librarian/device.js";

/** Nothing may be read from this. Any read is a bug the assertions below will show as a throw. */
const NO_IMAGE = new Uint8Array(0);

test("an index no project has reads as out of range, not as an error and not as unnamed", () => {
  assert.equal(DN2_DEVICE.patternCount, 128);

  // The number from rivvi's song row. It carries its own value and the count it broke, because
  // both of those are in the sentence somebody is shown.
  assert.deepEqual(storedPattern(DN2_DEVICE, NO_IMAGE, 196), {
    kind: "outOfRange",
    index: 196,
    count: 128,
  });

  // The rest of the boundary, each a thing a damaged record can hold.
  for (const index of [DN2_DEVICE.patternCount, -1, 1.5, Number.NaN, 0xffff]) {
    assert.equal(storedPattern(DN2_DEVICE, NO_IMAGE, index).kind, "outOfRange", `index ${index}`);
  }

  // The DN1 answers for its own count rather than the DN2's, so the guard is the device's.
  const dn1 = storedPattern(DN1_DEVICE, NO_IMAGE, DN1_DEVICE.patternCount);
  assert.equal(dn1.kind, "outOfRange");
  assert.equal(dn1.kind === "outOfRange" && dn1.count, DN1_DEVICE.patternCount);
});

test("out of range is distinguishable from having no name, which is the whole point", () => {
  /*
   * **The distinction this type exists for.** Before, both answered `undefined`, so a row naming a
   * pattern that cannot exist was drawn exactly like a row naming an unnamed one — and every
   * factory pattern is unnamed, so the damaged row was the least conspicuous thing on the page.
   */
  const damaged = storedPattern(DN2_DEVICE, NO_IMAGE, 196);
  assert.notEqual(damaged.kind, "unnamed");
  assert.notEqual(damaged.kind, "named");
});

test("a caller that chose the index still hears about it", () => {
  // The whole reason `storedPattern` exists rather than `summarise` being softened: a typo in a
  // call site should be loud, and only a number read out of a project should be forgiven.
  assert.throws(() => DN2_DEVICE.summarise(NO_IMAGE, 196), RangeError);
  assert.throws(() => DN2_DEVICE.summarise(NO_IMAGE, -1), RangeError);
});

test("an index the project does have is not short-circuited", () => {
  // It must reach the read rather than being waved through, otherwise the guard would hide every
  // name instead of the impossible ones. With no bytes behind it the read fails, and that failure
  // is the proof it was attempted.
  for (const index of [0, 1, DN2_DEVICE.patternCount - 1]) {
    assert.throws(
      () => storedPattern(DN2_DEVICE, NO_IMAGE, index),
      (error: unknown) => error instanceof Error && !/out of range/.test(error.message),
      `index ${index} is inside the project and must be read, not refused`,
    );
  }
});
