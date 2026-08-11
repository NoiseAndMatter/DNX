/**
 * The probe's timing instruments.
 *
 * These exist because writes stalled and nobody could say what had stalled — and until now they
 * could only be exercised by stalling a write, which is not a thing anybody can arrange. The pure
 * half is testable: what a status byte is, and what the report says when a measurement is or is not
 * worth mentioning.
 *
 * The watchers themselves need real timers and a real port; what is checked here is the part that
 * turns a measurement into a sentence, because a sentence that overstates gets ignored exactly as
 * fast as one that understates.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenRow, kindOf, timeGoesRow } from "../web/src/probe/timing.js";

test("a status byte is named in the terms this investigation needs", () => {
  // The distinction that mattered: 7,279 messages said nothing until they were counted by kind,
  // and what they *are* decides whether a stall is the instrument's clock, an echo of our own
  // write, or something nobody has looked at.
  assert.equal(kindOf(0xf0), "SysEx");
  assert.equal(kindOf(0xf8), "clock");
  assert.equal(kindOf(0xfe), "active sensing");
  assert.equal(kindOf(0xfa), "transport");
  assert.equal(kindOf(0xfc), "transport");
});

test("an unrecognised byte is described, not swallowed", () => {
  // Never "unknown": the number is the only thing that would let somebody look it up.
  assert.match(kindOf(0xf7), /system 0xf7/);
  assert.match(kindOf(0x90), /channel 0x90/);
  // Below 0x80 is not a status byte at all — it is the middle of a message.
  assert.equal(kindOf(0x40), "continuation");
});

test("a page that never stalled says nothing about stalling", () => {
  // The rows are for a card somebody reads while confused. A row saying "the page paused for 0.0s"
  // is noise competing with the row that matters.
  const rows = timeGoesRow({ longestGapMs: 12, ticks: 400 }, { messages: 0, bytes: 0, kinds: "" });
  assert.deepEqual(rows, []);
});

test("a stall over half a second is reported, with what got through", () => {
  const rows = timeGoesRow({ longestGapMs: 3200, ticks: 5 }, { messages: 0, bytes: 0, kinds: "" });
  assert.equal(rows.length, 1);
  assert.match(rows[0]![1], /3\.2s in one go/);
  // The tick count is the corroboration: a blocked thread runs almost no timers.
  assert.match(rows[0]![1], /5 tick\(s\)/);
});

test("inbound traffic is reported by kind, because the count alone explained nothing", () => {
  const rows = timeGoesRow(
    { longestGapMs: 0, ticks: 400 },
    { messages: 7279, bytes: 21837, kinds: "7000× clock, 279× SysEx" },
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]![1], /7000× clock/);
  assert.match(rows[0]![1], /21,837 bytes/, "thousands separated — these numbers get read in a hurry");
});

test("a hidden tab is reported, because that is what the stalls turned out to be", () => {
  // Browsers throttle setTimeout in a backgrounded tab, and a hardware test is exactly when the tab
  // gets backgrounded — the tester is looking at the instrument.
  const rows = hiddenRow({ hiddenMs: 45_000, times: 2 });
  assert.equal(rows.length, 1);
  assert.match(rows[0]![1], /45(\.0)?s/);
});

test("a tab that stayed visible says so, because a negative result is the useful one", () => {
  // If a stalled write reports no hidden time, the throttling theory is dead and the fault is
  // somewhere nobody has looked. That is worth as much as confirming it, so it must not be silent.
  const rows = hiddenRow({ hiddenMs: 0, times: 0 });
  assert.equal(rows.length, 1, "silence here would be indistinguishable from not measuring");
  assert.match(rows[0]![1], /visible|never hidden|stayed/i);
});
