/**
 * The API response readers that nothing else exercises.
 *
 * `deviceapi.test.ts` covers the codec — framing, seven-bit cleanliness, the id round trip — and
 * two of the six readers. These are the other four, and they are the ones that decode bytes off a
 * real instrument into things the rest of the code trusts: a directory listing, a file handle, a
 * chunk of a project.
 *
 * ## Why the fixtures are built rather than captured
 *
 * A capture would prove these agree with one device on one firmware. Building the bytes from the
 * documented shape proves they agree with *the shape*, which is what a reader is for — and lets the
 * awkward cases exist at all: an empty listing, a 64-bit value above `2^53`, a chunk whose declared
 * length disagrees with its payload. None of those are things a working device would ever send,
 * which is exactly why no capture contains them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  describeQueryValue,
  readDirListResponse,
  readFileReadOpenResponse,
  readFileReadResponse,
  readQueryResponse,
} from "../src/device/api.js";

/** Big-endian u32, the API's only integer width. */
function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function nul(text: string): number[] {
  return [...[...text].map((c) => c.charCodeAt(0)), 0];
}

/** One flat run of bytes from any mix of scalars and runs. */
const bytes = (...parts: (number | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => part));

// --- query answers -------------------------------------------------------------------------

test("a key the device does not know answers 'none', which is a real answer", () => {
  // This is what makes probing keys safe rather than a guessing game with consequences.
  assert.deepEqual(readQueryResponse(bytes(0)), { kind: "none" });
  assert.equal(describeQueryValue({ kind: "none" }), "—");
});

test("a boolean answer is a tag and a byte", () => {
  assert.deepEqual(readQueryResponse(bytes(1, 1)), { kind: "bool", value: true });
  assert.deepEqual(readQueryResponse(bytes(1, 0)), { kind: "bool", value: false });
});

test("a 64-bit answer is kept as two halves, because folding it would lose precision", () => {
  // A device reporting a size or a serial has every reason to exceed 2^53, where a JS number
  // stops counting exactly — so the halves are carried rather than combined.
  const value = readQueryResponse(bytes(3, u32(0x0001_0000), u32(0x0000_0001)));
  assert.deepEqual(value, { kind: "int", signed: false, hi: 0x0001_0000, lo: 1 });
  assert.equal(describeQueryValue(value), "0x1000000000001");
});

test("a small integer reads as a plain number, and a signed one says so", () => {
  assert.deepEqual(readQueryResponse(bytes(2, u32(0), u32(42))), {
    kind: "int", signed: true, hi: 0, lo: 42,
  });
  assert.equal(describeQueryValue({ kind: "int", signed: true, hi: 0, lo: 42 }), "42");
});

test("a string answer stops at its terminator", () => {
  assert.deepEqual(readQueryResponse(bytes(4, nul("Digitone II"))), {
    kind: "string", value: "Digitone II",
  });
});

test("an unknown answer type is refused rather than read as something plausible", () => {
  assert.throws(() => readQueryResponse(bytes(9)), (error: Error) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.message, /unknown query response type 9/);
    return true;
  });
});

// --- directory listings --------------------------------------------------------------------

test("a listing is read to the end, because the response carries no count", () => {
  const entry = (hash: number, size: number, locked: number, type: string, name: string): number[] =>
    [...u32(hash), ...u32(size), locked, type.charCodeAt(0), ...nul(name)];

  const entries = readDirListResponse(
    bytes(entry(0xdead_beef, 4_194_304, 0, "D", "projects"), entry(1, 269, 1, "F", "MY SOUND")),
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    hash: 0xdead_beef, size: 4_194_304, locked: false, type: "D", name: "projects",
  });
  assert.deepEqual(entries[1], { hash: 1, size: 269, locked: true, type: "F", name: "MY SOUND" });
});

test("an empty listing is an empty list, not a failure", () => {
  // A directory with nothing in it is ordinary, and the +Drive has plenty of them.
  assert.deepEqual(readDirListResponse(new Uint8Array(0)), []);
});

// --- file handles and chunks ----------------------------------------------------------------

test("an open reports its handle and the length it is going to send", () => {
  assert.deepEqual(readFileReadOpenResponse(bytes(1, u32(7), u32(2_781_743))), {
    ok: true, fd: 7, totalLength: 2_781_743,
  });
});

test("a refused open still parses, so the caller can report it rather than hang", () => {
  assert.equal(readFileReadOpenResponse(bytes(0, u32(0), u32(0))).ok, false);
});

test("a chunk carries its range and its bytes", () => {
  const data = [1, 2, 3, 4];
  const chunk = readFileReadResponse(bytes(1, u32(7), u32(data.length), u32(0), u32(4), data));
  assert.equal(chunk.ok, true);
  assert.equal(chunk.fd, 7);
  assert.equal(chunk.start, 0);
  assert.equal(chunk.end, 4);
  assert.deepEqual([...chunk.data], data);
});

test("a chunk shorter than it claims is refused, not assembled", () => {
  // The declared length and the payload are two independent statements of the same fact. A chunk
  // that is quietly short is how a truncated project gets assembled with nobody the wiser until
  // the device refuses it weeks later.
  assert.throws(
    () => readFileReadResponse(bytes(1, u32(7), u32(64), u32(0), u32(64), [1, 2, 3])),
    ApiError,
  );
});
