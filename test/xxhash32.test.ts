/**
 * xxHash32, against vectors this repository did not produce.
 *
 * The Waverider store identifies a table by this hash, and the firmware that reads the store
 * computes it independently. So the only failure that matters is disagreement with the firmware —
 * but a wrong implementation of the specification guarantees that disagreement, and these catch it
 * without needing the instrument.
 *
 * **Every vector below is a published one.** There is no independent xxHash32 on this machine to
 * generate them with, which turns out to be the better position: nothing here was produced by the
 * code it checks. See `xxhash32.ts` for what that still leaves open.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test("the published vectors, which cover every branch", () => {
  // Under 16 bytes: the `seed + PRIME5` path, and the two tails. No accumulator runs at all.
  assert.equal(xxHash32(utf8("")), 0x02cc5d05);
  assert.equal(xxHash32(utf8("a")), 0x550d7456);
  assert.equal(xxHash32(utf8("abc")), 0x32d153ff);
  assert.equal(xxHash32(utf8("abcd")), 0xa3643705);

  // The seed is not decoration: the same empty input under a different seed.
  assert.equal(xxHash32(utf8(""), 1), 0x0b2cb792);

  // 39 bytes, and the only vector here that does real work: **two full passes of the
  // four-accumulator loop**, then a 4-byte tail and three single bytes. Without it the loop that
  // the algorithm actually consists of would be untested, because no vector short enough to be
  // widely quoted ever enters it.
  assert.equal(xxHash32(utf8("Nobody inspects the spammish repetition")), 0xe2293b2f);
});

test("the sixteen-byte boundary, where an off-by-one would live", () => {
  // The loop bound is `do { ... } while (at <= length - 16)`. At exactly 16 bytes it must run once
  // and stop; at 15 it must not run at all. Those are different code paths producing different
  // hashes, and a `<` for a `<=` is invisible at every other length.
  const sixteen = utf8("abcdefghijklmnop");
  assert.equal(sixteen.length, 16);

  const fifteen = sixteen.subarray(0, 15);
  const seventeen = utf8("abcdefghijklmnopq");

  // Not asserting the values — they are not published and inventing them from this implementation
  // would prove nothing. What is asserted is that all three are distinct and that none throws,
  // which is what an off-by-one breaks: a 16-byte input that silently takes the short path reads
  // the same as something it is not.
  const hashes = [xxHash32(fifteen), xxHash32(sixteen), xxHash32(seventeen)];
  assert.equal(new Set(hashes).size, 3, "three lengths, three hashes");
  for (const hash of hashes) assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff);
});

test("the result is unsigned, which Math.imul does not give you for free", () => {
  // `Math.imul` returns a signed 32-bit number, so the final `>>> 0` is load-bearing. A negative
  // hash written into a `u32` field is a different number from the one the firmware computed, and
  // it would only show up on a device.
  //
  // Found by searching for an input whose avalanche lands with the top bit set.
  let sawTopBitSet = false;
  for (let i = 0; i < 512; i++) {
    const hash = xxHash32(utf8(`waverider-${i}`));
    assert.ok(hash >= 0, `xxHash32 returned ${hash}, which is negative`);
    assert.ok(Number.isInteger(hash));
    if (hash > 0x7fffffff) sawTopBitSet = true;
  }
  assert.ok(sawTopBitSet, "no input produced a high-bit hash, so this proved nothing");
});

test("a table-sized buffer hashes, and length is part of the hash", () => {
  // 16 waves x 512 points x 2 bytes is what a v1 Waverider table measures, and 1,024 passes of the
  // accumulator loop is further than any vector reaches. This is not a correctness check — it is
  // here because the length field is folded in before the tail, so two buffers that differ only in
  // length must not collide, and a truncated table is exactly the failure that would produce one.
  const table = new Uint8Array(16 * 512 * 2);
  for (let i = 0; i < table.length; i++) table[i] = (i * 7) & 0xff;

  const whole = xxHash32(table);
  const short = xxHash32(table.subarray(0, table.length - 1));
  assert.notEqual(whole, short, "a truncated table must not hash as the whole one");

  // And it is stable across calls, which rules out the accumulators leaking between them.
  assert.equal(xxHash32(table), whole);
});

test("a subarray hashes as its own bytes, not as its parent's", () => {
  // `Uint8Array.subarray` shares the buffer and carries a byteOffset. Indexing through `data[i]`
  // respects that, but a reader written against the underlying ArrayBuffer would not — and the
  // store hands out extents as subarrays of a larger read.
  const parent = new Uint8Array(64);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  const slice = parent.subarray(16, 48);
  const copy = Uint8Array.from(slice);
  assert.notEqual(slice.byteOffset, 0, "the slice must actually be offset for this to test anything");
  assert.equal(xxHash32(slice), xxHash32(copy));
});
