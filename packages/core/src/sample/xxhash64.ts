/**
 * xxHash64, the sample library's content hash.
 *
 * ## Why 64 bits, and why this one
 *
 * A sample is identified by a hash of its stored bytes plus their size ("Sample region plan",
 * 2026-10-21). xxHash32 is what the Waverider store uses, and it is too short for a library: with
 * 10,000 samples a 32-bit hash collides with a chance of about 1 %. 64 bits make that negligible.
 * xxHash64 is the 64-bit member of the family the firmware already links, and it is the
 * plan's first choice. **The format is not agreed yet**, so `identity.ts` is the only caller and
 * the one place a change of hash would land.
 *
 * ## How it is computed
 *
 * Canonical XXH64: four accumulators over 32-byte stripes, a merge, a tail of 8, 4 and 1-byte
 * steps, then an avalanche. Input lanes are little-endian. Arithmetic is `BigInt` masked to 64
 * bits, which is slow but exact. `xxhash64.test.ts` checks it against published vectors, which
 * were not produced by this code.
 */

const MASK = (1n << 64n) - 1n;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK;

function round(acc: bigint, lane: bigint): bigint {
  acc = (acc + lane * P2) & MASK;
  acc = rotl(acc, 31n);
  return (acc * P1) & MASK;
}

function merge(acc: bigint, value: bigint): bigint {
  acc ^= round(0n, value);
  return (acc * P1 + P4) & MASK;
}

/** xxHash64 of `bytes`, as an unsigned 64-bit `bigint`. */
export function xxHash64(bytes: Uint8Array, seed = 0n): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  const lane64 = (at: number): bigint => view.getBigUint64(at, true);
  let at = 0;
  let h: bigint;

  if (length >= 32) {
    let v1 = (seed + P1 + P2) & MASK;
    let v2 = (seed + P2) & MASK;
    let v3 = seed & MASK;
    let v4 = (seed - P1) & MASK;
    const limit = length - 32;
    while (at <= limit) {
      v1 = round(v1, lane64(at));
      v2 = round(v2, lane64(at + 8));
      v3 = round(v3, lane64(at + 16));
      v4 = round(v4, lane64(at + 24));
      at += 32;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    h = merge(h, v1);
    h = merge(h, v2);
    h = merge(h, v3);
    h = merge(h, v4);
  } else {
    h = (seed + P5) & MASK;
  }

  h = (h + BigInt(length)) & MASK;

  while (at + 8 <= length) {
    h ^= round(0n, lane64(at));
    h = (rotl(h, 27n) * P1 + P4) & MASK;
    at += 8;
  }
  if (at + 4 <= length) {
    h ^= (BigInt(view.getUint32(at, true)) * P1) & MASK;
    h = (rotl(h, 23n) * P2 + P3) & MASK;
    at += 4;
  }
  while (at < length) {
    h ^= (BigInt(bytes[at]!) * P5) & MASK;
    h = (rotl(h, 11n) * P1) & MASK;
    at += 1;
  }

  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  h ^= h >> 32n;
  return h;
}
