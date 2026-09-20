/**
 * Noticing another application on the instrument's port.
 *
 * The judgement is one comparison, and the value of it is entirely in where the floor is: it is
 * `messageids.ts`'s `FIRST_MESSAGE_ID`, which exists because Elektron Transfer numbers from the
 * low hundreds. These tests pin that the two stay the same number, because a detector reading a
 * floor the allocator no longer uses would be silent exactly when it matters.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FIRST_MESSAGE_ID, reserveMessageIds, resetMessageIdsForTest } from "../web/src/messageids.js";
import {
  FOREIGN_BELOW, foreignReplyCount, isForeignReply, noteReply, onOtherTraffic,
  otherTrafficSeen, resetOtherTrafficForTest,
} from "../web/src/othertraffic.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the floor is the allocator's, not a number of its own", () => {
  /*
   * If these ever differ, the detector either misses Transfer or accuses DNX of being someone
   * else. One constant, imported, so they cannot.
   */
  assert.equal(FOREIGN_BELOW, FIRST_MESSAGE_ID);
});

test("an id this page could allocate is never called foreign", () => {
  resetMessageIdsForTest();
  // Every id the allocator hands out, across a few reservations of the sizes real conversations
  // take, has to read as ours.
  for (const count of [1, 4, 32, 8_192]) {
    const base = reserveMessageIds(count);
    for (const id of [base, base + count - 1]) {
      assert.equal(isForeignReply(id), false, `${id} came from the allocator and is ours`);
    }
  }
  resetMessageIdsForTest();
});

test("Transfer's range reads as another application", () => {
  // The low hundreds are what `messageids.ts` records Transfer using.
  for (const id of [1, 2, 100, 255, 888, FOREIGN_BELOW - 1]) {
    assert.equal(isForeignReply(id), true, `${id} is below the floor`);
  }
});

test("a message that answers nothing is not evidence of anything", () => {
  // `respId` is undefined on a message the device volunteered. It answers no request, so it says
  // nothing about who else is asking.
  assert.equal(isForeignReply(undefined), false);
});

test("counting rises with each foreign reply, and listeners hear it", () => {
  resetOtherTrafficForTest();
  const heard: number[] = [];
  onOtherTraffic((n) => heard.push(n));

  assert.equal(otherTrafficSeen(), false);
  noteReply(9_000); // ours
  assert.equal(foreignReplyCount(), 0, "one of ours is not counted");
  assert.deepEqual(heard, [], "and nobody is told about it");

  noteReply(120);
  noteReply(121);
  assert.equal(foreignReplyCount(), 2);
  assert.equal(otherTrafficSeen(), true);
  assert.deepEqual(heard, [1, 2], "the count is what a listener is given");

  resetOtherTrafficForTest();
});

test("a listener that arrives late is told at once", () => {
  // The tool row is built before any device is opened on some pages and after on others. A
  // warning that only fires on the *next* reply would miss a read that has already finished.
  resetOtherTrafficForTest();
  noteReply(300);
  let told: number | undefined;
  onOtherTraffic((n) => { told = n; });
  assert.equal(told, 1);
  resetOtherTrafficForTest();
});

test("every API reply is counted where they all pass, not per page", () => {
  /*
   * `awaitApiFrame` is the one place a decoded API frame exists for every page that talks to an
   * instrument. Counting anywhere else means the page somebody forgets is the page running the
   * read that Transfer truncates.
   */
  const link = readFileSync(join(ROOT, "src/device/link.ts"), "utf8");
  const start = link.indexOf("awaitApiFrame(");
  assert.ok(start > 0, "awaitApiFrame has been renamed; this check no longer guards anything");
  assert.match(link.slice(start, start + 900), /noteReply\?\.\(frame\.respId\)/);

  /*
   * The correlation is platform-free now and may not import a module that draws a warning strip,
   * so the hook is passed in. Half a guard would pass on a link nobody wired up, which is a
   * counter that silently counts nothing: the browser layer has to supply it, in the one
   * constructor every page's link goes through.
   */
  const adapter = readFileSync(join(ROOT, "web/src/devicelink.ts"), "utf8");
  assert.match(adapter, /import \{ noteReply \} from "\.\/othertraffic\.js";/);
  assert.match(adapter, /super\(new WebMidiPort\(input, output\), \{ noteReply \}\)/);
});

test("the warning is installed by the tool row, so every page has it", () => {
  const nav = readFileSync(join(ROOT, "web/src/toolnav.ts"), "utf8");
  assert.match(nav, /installOtherTrafficWarning\(container\)/);
});

test("the probe counts while it listens, where nothing of ours is in flight", () => {
  /*
   * The other pages only see replies inside `awaitApiFrame`, which runs while DNX waits for one
   * of its own. Listen is the opposite case: a port nobody here is driving, which is exactly where
   * another application's conversation is visible in full — and it would have gone uncounted.
   */
  const probe = readFileSync(join(ROOT, "web/src/probe/main.ts"), "utf8");
  // Two handlers in this file match on shape; the listening one is the one that fills the capture.
  const start = probe.indexOf("capture.add(data);");
  assert.ok(start > 0, "the listen handler has been renamed; this check no longer guards anything");
  assert.match(probe.slice(start, start + 900), /noteReply\(frame\.respId\)/);
});
