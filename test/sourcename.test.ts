/**
 * What a Digitone 1 project is called once it has been opened.
 *
 * Three lines of logic, and they exist because somebody asked: *"In this case the project name and
 * slot name are the same, would they ever differ or are we just adding noise?"* They can differ,
 * and the rule below is the answer — so it is worth a test that states it rather than a comment
 * that describes it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { slotLabel, sourceBadge } from "../web/src/expander/sourcename.js";

test("the drive name is dropped when it agrees with the project name", () => {
  // The usual case, and printing it twice is the noise that was reported.
  assert.equal(slotLabel("MORNING_JAM", "MORNING_JAM", 2), "slot 2");
});

test("the drive name is kept when it disagrees, because that difference is the news", () => {
  // Two different things: the +Drive entry is the file's name on the drive, the project name lives
  // inside the image at offset 8. Anything this tool stamps a build time into changes the second
  // and not the first, so a disagreement is exactly what somebody needs to see.
  assert.equal(slotLabel("JAGGED 1042", "JAGGED", 9), "JAGGED · slot 9");
});

test("an unnamed project still says where it came from", () => {
  // A blank name is not the same as agreement — the slot is all there is to go on.
  assert.equal(slotLabel("", "SKETCH", 14), "SKETCH · slot 14");
});

test("the badge says what it is, then where it came from", () => {
  assert.equal(sourceBadge("MORNING_JAM", "slot 2"), "MORNING_JAM · slot 2");
  assert.equal(sourceBadge("MORNING_JAM", "morning.dnprj"), "MORNING_JAM · morning.dnprj");
});
