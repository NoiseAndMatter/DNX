import assert from "node:assert/strict";
import { test } from "node:test";
import { decode87, encode87 } from "@noiseandmatter/dnx-core/sysex/codec.js";

test("encode87 packs the documented MSB-first bit order", () => {
  // Seven bytes with only the high bit set, one at a time, must light up
  // header bits 6..0 in order.
  for (let i = 0; i < 7; i++) {
    const raw = new Uint8Array(7);
    raw[i] = 0x80;
    const enc = encode87(raw);
    assert.equal(enc.length, 8);
    assert.equal(enc[0], 1 << (6 - i), `byte ${i} should set header bit ${6 - i}`);
    for (let j = 1; j < 8; j++) assert.equal(enc[j], 0);
  }
});

test("encoded output is always 7-bit safe", () => {
  const raw = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const b of encode87(raw)) assert.ok(b <= 0x7f, `byte 0x${b.toString(16)} exceeds 7 bits`);
});

test("decode87 inverts encode87 for every length up to three groups", () => {
  for (let len = 0; len <= 21; len++) {
    const raw = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 129) & 0xff);
    assert.deepEqual(decode87(encode87(raw)), raw, `round-trip failed at length ${len}`);
  }
});

test("decode87 inverts encode87 for a large random payload", () => {
  const raw = new Uint8Array(100_000);
  let seed = 12345;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (seed >> 16) & 0xff;
  }
  assert.deepEqual(decode87(encode87(raw)), raw);
});

test("partial trailing groups are handled", () => {
  // 3 raw bytes -> 4 wire bytes, not a padded full group.
  assert.equal(encode87(new Uint8Array([0xff, 0x00, 0x80])).length, 4);
  assert.equal(decode87(new Uint8Array([0x70, 0x7f, 0x00, 0x00])).length, 3);
});

test("decode87 rejects a lone trailing header byte", () => {
  assert.throws(() => decode87(new Uint8Array(9)), /Malformed 8-in-7/);
});
