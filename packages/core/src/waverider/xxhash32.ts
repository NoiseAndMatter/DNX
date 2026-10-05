/**
 * xxHash32, because the Waverider store identifies its contents by it.
 *
 * ## Why this algorithm and not the one DNX already had
 *
 * DNX computes one hash today — `crc32ZeroInit`, in `project/checksum.ts` — and that is the
 * **transport** checksum the +Drive's `0x58` carries per chunk. It stays exactly where it is. This
 * is a different job: the Waverider store's superblock and index identify a table by the hash of
 * its bytes, and the firmware that reads that store already has xxHash32 linked. A content hash has
 * to agree with the reader, so the reader chose it.
 *
 * Keeping the two apart matters more than which is which. A handler that validates a chunk with
 * xxHash32 refuses every write with the device's own `Invalid package checksum; corrupt transfer`,
 * which reads as a transport fault and is not one.
 *
 * ## The specification, and where the values come from
 *
 * Canonical xxHash32: five primes, four accumulators over 16-byte blocks, then a tail and an
 * avalanche. **Input is read as little-endian `u32`**, which is worth saying out loud in a codebase
 * where almost every other multi-byte field on an Elektron device is big-endian — the Waverider
 * store's own fields are big-endian, and the hash over them is not.
 *
 * `Math.imul` throughout: JavaScript's `*` on two values near 2^32 loses the low bits to float
 * rounding, and the result is a hash that is self-consistent and agrees with nothing.
 *
 * ## What the tests show, and the one thing they do not
 *
 * **There is no independent xxHash32 on this machine** — no Node built-in, nothing in
 * `node_modules`, and Python's `hashlib` does not carry it. So the vectors in `xxhash32.test.ts`
 * are published ones rather than ones generated here, which is the stronger position anyway: they
 * were not produced by the code they check.
 *
 * Every branch is covered, which was not a given. The short strings take the `seed + PRIME5` path,
 * and the 39-byte one runs **two full passes of the four-accumulator loop and then both tails** —
 * one `u32` and three single bytes. A 16-byte boundary case pins the `do/while` bound, which is
 * where an off-by-one would hide and where no shorter vector can reach.
 *
 * > **What that still does not prove is agreement with the firmware**, which is the only
 * > implementation this has to match. Published vectors say we implement the specification; they
 * > cannot say the reader does. A pair of values computed on the instrument over a known buffer
 * > settles it, and has been asked for.
 *
 * Until it arrives, make the first table's hash a value **both sides compute and compare** rather
 * than one side asserting.
 */

/** The five constants, as the specification names them. */
const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

/**
 * Rotate left within 32 bits.
 *
 * `<<` and `>>>` each coerce their operand to a 32-bit integer first, so an accumulator that has
 * drifted above 2^32 is wrapped here rather than carried.
 */
function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/** One accumulator step. */
function round(acc: number, lane: number): number {
  return Math.imul(rotl((acc + Math.imul(lane, PRIME2)) | 0, 13), PRIME1);
}

/** Four bytes as a little-endian `u32`. */
function u32le(data: Uint8Array, at: number): number {
  return (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24)) >>> 0;
}

/**
 * Hash `data`, returning an unsigned 32-bit number.
 *
 * The Waverider store uses seed 0 everywhere, and the parameter exists because leaving it out of a
 * hash whose specification has one invites somebody to add a different one later.
 */
export function xxHash32(data: Uint8Array, seed = 0): number {
  const length = data.length;
  let at = 0;
  let hash: number;

  if (length >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) | 0;
    let v2 = (seed + PRIME2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - PRIME1) | 0;

    // `do/while` against `length - 16`, which is the specification's own bound. A `while (at + 16
    // <= length)` says the same thing for every input and is one transcription away from an
    // off-by-one that only a 16-byte input would show.
    const limit = length - 16;
    do {
      v1 = round(v1, u32le(data, at));
      v2 = round(v2, u32le(data, at + 4));
      v3 = round(v3, u32le(data, at + 8));
      v4 = round(v4, u32le(data, at + 12));
      at += 16;
    } while (at <= limit);

    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    hash = (seed + PRIME5) | 0;
  }

  hash = (hash + length) | 0;

  while (at + 4 <= length) {
    hash = (hash + Math.imul(u32le(data, at), PRIME3)) | 0;
    hash = Math.imul(rotl(hash, 17), PRIME4);
    at += 4;
  }
  while (at < length) {
    hash = (hash + Math.imul(data[at]!, PRIME5)) | 0;
    hash = Math.imul(rotl(hash, 11), PRIME1);
    at += 1;
  }

  // Avalanche.
  hash ^= hash >>> 15;
  hash = Math.imul(hash, PRIME2);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, PRIME3);
  hash ^= hash >>> 16;

  return hash >>> 0;
}
