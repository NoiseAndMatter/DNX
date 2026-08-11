/**
 * The message-id bands a long read draws from.
 *
 * This exists for one hard constraint: **`msgId` is a u16**. A read spends one id per chunk and a
 * large file is thousands of them, so a counter that simply advanced would leave range in three
 * presses — and `encodeMessage` would throw *mid-read*, with a handle open on the device.
 *
 * The arithmetic was three constants and a modulo spread across a 2,000-line file, with nothing
 * asserting it stayed in range. It does. These say so.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_MESSAGE_ID,
  MessageIdBands,
  READ_ID_BANDS,
  READ_ID_BASE,
  READ_ID_SPAN,
} from "../web/src/probe/messageids.js";

test("every id a read could spend stays inside a u16", () => {
  // The whole point. The top of the last band is the worst case, and it must not reach 0xFFFF.
  const bands = new MessageIdBands();
  for (let i = 0; i < READ_ID_BANDS * 3; i++) {
    const top = bands.base() + READ_ID_SPAN - 1;
    assert.ok(
      top <= MAX_MESSAGE_ID,
      `band starting ${bands.base()} would reach ${top}, past the u16 ceiling`,
    );
    bands.advance();
  }
});

test("a whole read fits in one band, so ids cannot run into the next", () => {
  // A band has to be at least as wide as the longest read, or two overlapping reads share ids and
  // each answers the other's requests — the collision actually observed.
  assert.ok(READ_ID_SPAN >= 8_192, "a large file read is thousands of chunks");
});

test("the bands start clear of Elektron Transfer", () => {
  // Transfer numbers from the low hundreds, and sharing a port with it is normal on this desk.
  // An id it also uses is an answer that could belong to either of us.
  assert.ok(READ_ID_BASE >= 8_192, "well above Transfer's range");
  assert.equal(new MessageIdBands().base(), READ_ID_BASE, "the first read starts at the bottom");
});

test("consecutive reads get non-overlapping bands", () => {
  const bands = new MessageIdBands();
  const seen: number[] = [];
  for (let i = 0; i < READ_ID_BANDS; i++) {
    seen.push(bands.base());
    bands.advance();
  }
  assert.equal(new Set(seen).size, READ_ID_BANDS, "every band distinct before any repeats");

  // And no band's range overlaps another's.
  const sorted = [...seen].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i]! >= sorted[i - 1]! + READ_ID_SPAN, `${sorted[i - 1]} and ${sorted[i]} overlap`);
  }
});

test("it cycles rather than growing without bound", () => {
  // Cycling is not reusing: by the time a band comes round, several complete reads have finished
  // and closed. Growing without bound is what would leave the u16.
  const bands = new MessageIdBands();
  const first = bands.base();
  for (let i = 0; i < READ_ID_BANDS; i++) bands.advance();
  assert.equal(bands.base(), first, "back to the start after a full lap");
});

test("advancing after a failure still moves on", () => {
  // Called from a `finally`: the ids a failed read already spent are gone whether or not it
  // finished, so coming round onto them is exactly the collision this prevents.
  const bands = new MessageIdBands();
  const before = bands.base();
  bands.advance();
  assert.notEqual(bands.base(), before);
});
