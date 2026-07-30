import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Code, encodeMessage } from "../src/device/api.js";
import { DumpCapture, apiName, captureFileName, summariseCapture } from "../src/device/capture.js";
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

/**
 * A capture this project's probe made from a real device, in the private corpus's session folder.
 *
 * Named rather than globbed: each of these is evidence of one specific thing that went wrong, and
 * a test that took whichever file came first would pass by finding something else. Missing files
 * throw, which is the point — a fixture that quietly is not there is a test that quietly is not
 * one.
 */
function hardwareTest(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CAPTURES, "..", "..", "..", "99_HardwareTest", name)));
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
    api: [],
    groups: [
      { productId: 21, product: "Digitone II", dumpType: 0x50, name: "PatternKit dump", count: 128, objects: [], numbersExhausted: false, bytes: 14_606_432, badChecksum: 0 },
      { productId: 21, product: "Digitone II", dumpType: 0x53, name: "Sound dump", count: 119, objects: [], numbersExhausted: false, bytes: 50_694, badChecksum: 0 },
    ],
  };
  const name = captureFileName(summary, new Date(2026, 6, 28, 22, 51));
  assert.match(name, /248msg/, `"${name}" should count every message, not just the biggest group`);
  assert.doesNotMatch(name, /128x/, `"${name}" should not imply only 128 messages were saved`);
});

// --- the other protocol --------------------------------------------------------------------------

test("API traffic is counted as API, not described as a mangled dump", () => {
  // A capture of 5,973 API messages was reported as `product 16` with every checksum BAD, because
  // this summariser is a *dump* parser: fed `F0 00 20 3C 10 00 …` it reads byte 4 as a product and
  // byte 6 as a dump type and invents both. That hid Elektron Transfer polling the device for the
  // best part of an hour, and a wrong conclusion was recorded on the strength of it.
  const summary = summariseCapture(encodeMessage(7, Code.Device));

  assert.deepEqual(summary.groups, [], "not a dump, so not in the dump groups");
  assert.equal(summary.api.length, 1);
  assert.equal(summary.api[0]!.code, Code.Device);
  assert.match(summary.api[0]!.name, /Device request/);
  assert.equal(summary.foreign, 0, "it is Elektron's, just not a dump");
  assert.equal(summary.unparsed, 0, "and it is readable — by the right parser");
});

test("the storage codes are named, because a capture full of 0xd3 tells nobody anything", () => {
  const listing = summariseCapture(encodeMessage(9, 0x53));
  assert.equal(listing.api[0]!.name, "directory listing request");
  // The reply is the request +0x80, so 0xd3 has to resolve back to the same name.
  assert.equal(apiName(0xd3), "directory listing reply");
  assert.equal(apiName(0xda), "mutation ack reply");
  // An unknown code says so rather than borrowing a neighbour's name.
  assert.equal(apiName(0x77), "unknown 0x77");
});

test("a capture of Elektron Transfer reads as Transfer, not as 5,973 broken dumps", { skip }, () => {
  // The file that caused this. Nearly an hour of Transfer polling a Digitone 1, saved by the probe
  // as `product16_Project_5973msg_1338.syx` — a product that does not exist and a project that was
  // never dumped. The whole capture is the other protocol.
  const summary = summariseCapture(hardwareTest("product16_Project_5973msg_1338.syx"));

  assert.deepEqual(summary.groups, [], "there is not one dump in this file");
  assert.equal(summary.foreign, 0);
  assert.ok(summary.api.length > 0, "the API traffic has to land somewhere");

  const counted = summary.api.reduce((n, g) => n + g.count, 0);
  assert.equal(counted + summary.unparsed, summary.messages, "every message is accounted for");

  // Transfer's idle loop is Device / Version / 0x03, and the replies carry the request's code
  // +0x80 — so finding 0x81 by name is what proves the decode rather than the counting.
  const names = summary.api.map((g) => g.name);
  for (const expected of ["Device reply", "Version reply", "idle poll reply"]) {
    assert.ok(names.includes(expected), `expected ${expected} in ${names.join(", ")}`);
  }

  const device = summary.api.find((g) => g.code === 0x81)!;
  assert.equal(device.replies, device.count, "a reply carries the id of the request it answers");
});

test("a capture that is all API is named for that, not for a product that does not exist", { skip }, () => {
  const summary = summariseCapture(hardwareTest("product16_Project_5973msg_1338.syx"));
  const name = captureFileName(summary, new Date(2026, 6, 30, 13, 38));
  assert.match(name, /^API_5973msg_1338\.syx$/, `"${name}" should say API and the true count`);
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

test("running out of object numbers is reported, not mistaken for lost messages", { skip }, () => {
  // A Digitone sending a bank of 182 sounds numbers them 0..127 and then reports 0 for the rest —
  // the field is a single 7-bit SysEx byte. Showing "128 objects" against 182 messages read as
  // data loss, and the user reasonably asked whether the capture was buggy. It was not; the
  // display was.
  const summary = summariseCapture(hardwareTest("Digitone_Sound_182x_2308.syx"));
  const sounds = summary.groups.find((g) => g.dumpType === 0x53);
  if (!sounds) throw new Error("no sound dumps in the DN1 bank capture");

  assert.equal(sounds.count, 182, "every message is counted");
  assert.equal(sounds.objects.length, 128, "but only 128 distinct numbers exist to hand out");
  assert.equal(sounds.numbersExhausted, true, "which has to be said, or it reads as lost data");
});
