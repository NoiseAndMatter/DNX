/**
 * xxHash64 and the sample identity built on it.
 *
 * **The vectors were not produced by the code they check.** The five strings are published
 * XXH64 values. The length table was generated on 2026-10-22 by xxhash-wasm 1.1.0, a WebAssembly
 * build of the reference C implementation, over bytes `(i * 167 + 13) & 0xff`. Its lengths reach
 * every branch: under 32 bytes, the stripe loop, and the 8-, 4- and 1-byte tails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { xxHash64 } from "@noiseandmatter/dnx-core/sample/xxhash64.js";
import { storedSample, canonicalBytes } from "@noiseandmatter/dnx-core/sample/format.js";
import { identify, parseSampleKey, sameSample, sampleKey } from "@noiseandmatter/dnx-core/sample/identity.js";
import { SampleError } from "@noiseandmatter/dnx-core/sample/errors.js";

const hex = (v: bigint): string => v.toString(16).padStart(16, "0");
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

test("xxHash64 matches the published vectors", () => {
  assert.equal(hex(xxHash64(text(""))), "ef46db3751d8e999");
  assert.equal(hex(xxHash64(text("a"))), "d24ec4f1a98c6e5b");
  assert.equal(hex(xxHash64(text("abc"))), "44bc2cf5ad770999");
  assert.equal(hex(xxHash64(text("Nobody inspects the spammish repetition"))), "fbcea83c8a378bf1");
  assert.equal(hex(xxHash64(text("xxhash"), 20141025n)), "b559b98d844e0635");
});

// [length, seed 0, seed 0x9e3779b1], from xxhash-wasm 1.1.0.
const REFERENCE: [number, string, string][] = [
  [0, "ef46db3751d8e999", "ac75fda2929b17ef"],
  [1, "2078e1ad38ad738b", "e09a55ee04ee9790"],
  [3, "634d95fc01a189cd", "2812951f9274c573"],
  [4, "eed340908a1ac6c6", "7077215546799520"],
  [7, "0da493621d6dc898", "502e324adb3bfac6"],
  [8, "76f916c7bb523126", "3eefa3e2227523c4"],
  [9, "175d7bee83bd73b9", "224593bacb7ca6d3"],
  [15, "4e1c333b057fb6a4", "377ad0d5a5c42d70"],
  [16, "7bbeff67699312f6", "a3bf833bb2661796"],
  [17, "5a63f300c4cb3d87", "8e8029ad7e1663e0"],
  [31, "65c5feb01da7464d", "d59b0494237a2e46"],
  [32, "7665c921c9bf2ec7", "3c9b8ca326d19018"],
  [33, "b5a9d9ef259ae821", "bf0219f3739423b4"],
  [63, "b0289cd9324034f0", "ed9abfb1d3b4c22c"],
  [64, "fff2525c99bf2005", "57d64632337ad473"],
  [65, "01fbd6d6ac20fbaf", "4bec2a992244011b"],
  [100, "74e502db362efd4c", "9203b64af7d0c8f2"],
  [1000, "626443c8029d0542", "5fc1cfbdef1f261c"],
];

test("xxHash64 agrees with the reference implementation at every length boundary", () => {
  for (const [n, seed0, seeded] of REFERENCE) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 167 + 13) & 0xff;
    assert.equal(hex(xxHash64(bytes)), seed0, `length ${n}, seed 0`);
    assert.equal(hex(xxHash64(bytes, 0x9e3779b1n)), seeded, `length ${n}, seeded`);
  }
});

test("xxHash64 reads a view at its own offset, not its buffer's start", () => {
  const backing = new Uint8Array(40);
  backing.set(text("abc"), 7);
  assert.equal(hex(xxHash64(backing.subarray(7, 10))), "44bc2cf5ad770999");
});

test("the canonical bytes are little-endian int16 whatever the platform", () => {
  const sample = storedSample(2, Int16Array.from([1, -2, 0x1234, -32768]));
  assert.deepEqual([...canonicalBytes(sample)], [0x01, 0x00, 0xfe, 0xff, 0x34, 0x12, 0x00, 0x80]);
});

test("an identity is the hash of the canonical bytes, seeded by the channel count, and their size", () => {
  const sample = storedSample(1, Int16Array.from([1, -2, 0x1234, -32768]));
  const id = identify(sample);
  assert.equal(id.size, 8);
  assert.equal(id.hash, hex(xxHash64(canonicalBytes(sample), 1n)));
  assert.match(id.hash, /^[0-9a-f]{16}$/);
});

test("mono and stereo with the same points are two samples", () => {
  // The same bytes and the same size: only the seed tells them apart. Without it the library
  // would hold one object for two different sounds.
  const points = Int16Array.from([5, 6, 7, 8]);
  const mono = identify(storedSample(1, points));
  const stereo = identify(storedSample(2, points));
  assert.equal(mono.size, stereo.size);
  assert.ok(!sameSample(mono, stereo));
});

test("a sample key round-trips, and a malformed one is refused", () => {
  const id = { hash: "0123456789abcdef", size: 96_000 };
  assert.deepEqual(parseSampleKey(sampleKey(id)), id);
  for (const bad of ["0123456789abcdef", "0123456789ABCDEF:2", "0123:2", "0123456789abcdef:3", "0123456789abcdef:0"]) {
    assert.throws(() => parseSampleKey(bad), SampleError, bad);
  }
});

test("a stored sample refuses three channels, no frames and a torn frame", () => {
  assert.throws(() => storedSample(3, new Int16Array(6)), SampleError);
  assert.throws(() => storedSample(1, new Int16Array(0)), SampleError);
  assert.throws(() => storedSample(2, new Int16Array(3)), SampleError);
});
