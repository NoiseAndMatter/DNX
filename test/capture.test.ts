import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DumpCapture, captureFileName, summariseCapture } from "../src/device/capture.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

/**
 * The corpus captures were made the same way the probe will make them — a device told to send
 * from its own front panel — so they are the right fixture for a receiver. If the summariser
 * cannot describe a file the hardware actually produced, it will not describe a live one either.
 */
const skip = NO_CORPUS && SKIP_REASON;
const CAPTURES = `${CORPUS}02_DN2/reference_captures`;

function anyCapture(): Uint8Array {
  const files = readdirSync(CAPTURES).filter((f) => /\.syx$/i.test(f));
  if (files.length === 0) throw new Error(`no .syx captures in ${CAPTURES}`);
  return new Uint8Array(readFileSync(join(CAPTURES, files[0]!)));
}

test("a real device capture is described, not merely accepted", { skip }, () => {
  const summary = summariseCapture(anyCapture());

  assert.ok(summary.messages > 0, "no SysEx messages found in a file full of them");
  assert.equal(summary.unparsed, 0, "every message in a native capture should parse");
  assert.equal(summary.foreign, 0, "a Digitone capture should be all Elektron");
  assert.ok(summary.groups.length > 0, "nothing was grouped");

  for (const group of summary.groups) {
    assert.equal(group.badChecksum, 0, `${group.name} has messages with a bad checksum`);
    assert.ok(group.count > 0);
    assert.ok(group.bytes > 0);
  }
});

test("the Digitone II is recognised by product id, not guessed at", { skip }, () => {
  const summary = summariseCapture(anyCapture());
  assert.ok(
    summary.groups.some((g) => g.product === "Digitone II"),
    `expected a Digitone II group, got ${summary.groups.map((g) => g.product).join(", ")}`,
  );
});

// --- tolerance, which is the point ------------------------------------------------------------

test("a truncated capture is still summarised", { skip }, () => {
  // The user can stop listening mid-transfer, so a partial capture is a normal outcome rather
  // than an error. A summary that refuses to describe an imperfect capture is useless exactly
  // when it is most needed — which is when something went wrong.
  // One whole message followed by half of another, which is exactly what stopping a multi-message
  // transfer looks like. Built rather than taken, because a corpus capture is a single message
  // and cutting it would only ever prove the empty case.
  const one = anyCapture();
  const cut = new Uint8Array(one.length + Math.floor(one.length / 2));
  cut.set(one, 0);
  cut.set(one.subarray(0, cut.length - one.length), one.length);

  const summary = summariseCapture(cut);
  assert.equal(summary.messages, 1, "the message that completed before the cut is still described");
  assert.equal(summary.unparsed, 0);
  assert.equal(summary.bytes, cut.length);
  assert.ok(
    summary.trailingBytes > 0,
    "the partial message at the end should be reported, not silently dropped",
  );
});

test("other manufacturers are counted, not parsed", () => {
  // A MIDI port carries everyone's traffic. Reading a Yamaha dump with Elektron's layout would
  // produce confident nonsense, so it is set aside and reported instead.
  const yamaha = Uint8Array.from([0xf0, 0x43, 0x00, 0x00, 0xf7]);
  const summary = summariseCapture(yamaha);
  assert.equal(summary.foreign, 1);
  assert.equal(summary.groups.length, 0);
});

test("garbage is counted rather than thrown", () => {
  // An Elektron header with nothing behind it. Truncated mid-message is exactly what stopping a
  // transfer early produces.
  const stub = Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, 0x15, 0xf7]);
  const summary = summariseCapture(stub);
  assert.equal(summary.unparsed, 1);
  assert.equal(summary.foreign, 0);
});

// --- accumulating ------------------------------------------------------------------------------

test("the capture keeps the bytes exactly as they arrived", { skip }, () => {
  // The saved file's whole value is being able to say "this is what the device sent", so nothing
  // may be normalised, reordered or re-framed on the way in.
  const original = anyCapture();
  const capture = new DumpCapture();
  // Deliver it in pieces, the way MIDI does.
  for (const message of splitForTest(original)) capture.add(message);

  assert.equal(capture.byteLength, original.length);
  assert.deepEqual([...capture.bytes()], [...original]);
});

test("non-SysEx traffic never reaches the capture", () => {
  // Clock ticks and note-ons arrive constantly on a live port and are not part of any dump.
  const capture = new DumpCapture();
  capture.add(Uint8Array.from([0xf8]));
  capture.add(Uint8Array.from([0x90, 0x40, 0x7f]));
  capture.add(Uint8Array.from([]));
  assert.equal(capture.isEmpty, true);

  capture.add(Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, 0x15, 0xf7]));
  assert.equal(capture.byteLength, 6);
});

test("clearing resets the byte count as well as the buffer", () => {
  const capture = new DumpCapture();
  capture.add(Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, 0x15, 0xf7]));
  capture.clear();
  assert.equal(capture.isEmpty, true);
  assert.equal(capture.byteLength, 0);
  assert.deepEqual([...capture.bytes()], []);
});

// --- naming -------------------------------------------------------------------------------------

test("a capture names itself after what it holds", { skip }, () => {
  // Three files called capture.syx are three files nobody can tell apart an hour later, and this
  // session will produce several: a pattern, a project, then the same from the other machine.
  const name = captureFileName(summariseCapture(anyCapture()), new Date(2026, 6, 28, 9, 5));
  assert.match(name, /^Digitone/, `"${name}" should start with the product`);
  assert.match(name, /_0905\.syx$/, `"${name}" should end with a time stamp`);
  assert.match(name, /\d+x/, `"${name}" should say how many messages`);
});

test("a mixed capture is named for the whole thing, not its biggest group", () => {
  // A project dump is 128 PatternKit, 119 Sound and one ProjectSettings. Naming it
  // `PatternKit_128x` made the user reasonably conclude the other 120 messages had been dropped.
  // They were in the file; only the name lied.
  const summary = {
    messages: 248,
    bytes: 14_657_727,
    foreign: 0,
    unparsed: 0,
    trailingBytes: 0,
    groups: [
      { productId: 21, product: "Digitone II", dumpType: 0x50, name: "PatternKit dump", count: 128, objects: [], bytes: 14_606_432, badChecksum: 0 },
      { productId: 21, product: "Digitone II", dumpType: 0x53, name: "Sound dump", count: 119, objects: [], bytes: 50_694, badChecksum: 0 },
    ],
  };
  const name = captureFileName(summary, new Date(2026, 6, 28, 22, 51));
  assert.match(name, /248msg/, `"${name}" should count every message, not just the biggest group`);
  assert.doesNotMatch(name, /128x/, `"${name}" should not imply only 128 messages were saved`);
});

test("an empty capture still gets a usable name", () => {
  assert.match(captureFileName(summariseCapture(new Uint8Array()), new Date(2026, 6, 28, 9, 5)), /^CAPTURE_0905\.syx$/);
});

/** Split a file into its messages, so the accumulator can be fed the way MIDI delivers them. */
function splitForTest(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < data.length) {
    const start = data.indexOf(0xf0, i);
    if (start === -1) break;
    const end = data.indexOf(0xf7, start + 1);
    if (end === -1) break;
    out.push(data.subarray(start, end + 1));
    i = end + 1;
  }
  return out;
}
