/**
 * The one allocator every conversation with an instrument draws from.
 *
 * Two hard constraints, and a page that gets either wrong fails on hardware in ways that read as a
 * device fault:
 *
 * 1. **`msgId` is a u16.** A read spends one id per chunk and a project is ~6,300 of them, so a
 *    reservation running past the ceiling would make `encodeMessage` throw *mid-read*, with a
 *    handle open on the device.
 * 2. **No two live conversations may share an id.** Not a tidiness rule — it is the bug this module
 *    exists for, observed twice: `expected 0xd3 to a listing and got 0xd4`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_MESSAGE_ID,
  IDS_FOR,
  MAX_MESSAGE_ID,
  MESSAGE_ID_SPAN,
  reserveMessageIds,
  resetMessageIdsForTest,
} from "../web/src/messageids.js";

test("reservations never overlap, whatever sizes they are asked for", () => {
  // The property that matters. Mixed sizes, because the real callers differ by four orders of
  // magnitude — a listing is one message and a project is six thousand.
  resetMessageIdsForTest();

  const sizes = [IDS_FOR.oneMessage, IDS_FOR.wholeProject, IDS_FOR.oneObject, IDS_FOR.wholeBank, 1];
  const taken: [number, number][] = [];

  for (const size of sizes) {
    const base = reserveMessageIds(size);
    for (const [otherBase, otherSize] of taken) {
      const disjoint = base + size <= otherBase || otherBase + otherSize <= base;
      assert.ok(
        disjoint,
        `${base}..${base + size - 1} overlaps ${otherBase}..${otherBase + otherSize - 1}`,
      );
    }
    taken.push([base, size]);
  }
});

test("every id handed out stays inside a u16", () => {
  // Including across a wrap. A reservation straddling the ceiling would hand back a base whose run
  // leaves the range — a failure that happens mid-conversation rather than at the call.
  resetMessageIdsForTest();

  for (let i = 0; i < 40; i++) {
    const base = reserveMessageIds(IDS_FOR.wholeProject);
    assert.ok(base >= FIRST_MESSAGE_ID, `${base} is inside Elektron Transfer's range`);
    assert.ok(
      base + IDS_FOR.wholeProject - 1 <= MAX_MESSAGE_ID,
      `a reservation at ${base} would reach ${base + IDS_FOR.wholeProject - 1}, past the ceiling`,
    );
  }
});

test("nothing is ever handed out below Transfer's range", () => {
  // Sharing a port with Elektron Transfer is normal on this desk, and Transfer numbers from the low
  // hundreds. An id it also uses is a reply that could belong to either of us.
  resetMessageIdsForTest();
  for (let i = 0; i < 200; i++) {
    assert.ok(reserveMessageIds(IDS_FOR.oneMessage) >= FIRST_MESSAGE_ID);
  }
});

test("the allocator wraps rather than running out", () => {
  // A page is long-lived and the space is finite. Running out would be a throw in the middle of a
  // session; wrapping reuses ids only after 57,344, by which time nothing is still waiting.
  resetMessageIdsForTest();

  const first = reserveMessageIds(IDS_FOR.oneMessage);
  let sawWrap = false;
  for (let i = 0; i < Math.ceil(MESSAGE_ID_SPAN / IDS_FOR.wholeProject) + 4; i++) {
    if (reserveMessageIds(IDS_FOR.wholeProject) === FIRST_MESSAGE_ID) sawWrap = true;
  }
  assert.equal(first, FIRST_MESSAGE_ID);
  assert.ok(sawWrap, "the allocator should return to the base rather than exceed the u16");
});

test("a reservation larger than the space is refused, not truncated", () => {
  // Truncating would hand back a base that silently cannot hold the conversation, and the caller
  // would run past it into whatever came next — the exact bug this module exists to prevent.
  assert.throws(() => reserveMessageIds(MESSAGE_ID_SPAN + 1), RangeError);
});

test("a reservation must be at least one whole id", () => {
  assert.throws(() => reserveMessageIds(0), RangeError);
  assert.throws(() => reserveMessageIds(-1), RangeError);
  assert.throws(() => reserveMessageIds(1.5), RangeError);
});

test("the named sizes are ceilings for the traffic they describe", () => {
  // These are what call sites read as intent, so each has to be at least as large as the
  // conversation it names. Under-reserving is not a smaller reservation, it is a collision.
  assert.ok(
    IDS_FOR.wholeProject >= Math.ceil(12_889_647 / 2_048),
    "a Digitone II project is 12,889,647 bytes at 2,048 a chunk",
  );
  // A bank is 256 slots and `slottags.ts` numbers each one 8 apart.
  assert.ok(IDS_FOR.wholeBank >= 256 * 8, "a bank's tag read must fit");
  assert.ok(IDS_FOR.oneObject >= 4, "an object arrives in chunks, plus an open and a close");
});
