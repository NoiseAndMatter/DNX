/**
 * LZ4 block-format compressor for Elektron project payloads.
 *
 * The counterpart to `decodeProjectImage` in dn2codec.ts. A project payload's body is a
 * chain of LZ4 blocks sharing one continuous dictionary ("linked blocks"): each block is
 * preceded by a u32be compressed size, the chain ends with a u32be zero, and each block
 * covers BLOCK_SIZE bytes of the image (the last one short).
 *
 * We do NOT try to reproduce Elektron's compressor byte-for-byte. LZ4 is a deterministic
 * *format* but not a deterministic *encoding* — many valid streams decode to the same
 * bytes. What matters is that the image round-trips exactly, which is what the tests
 * assert. A consequence worth remembering: a rebuilt file will usually differ from the
 * original even when it is semantically identical, so never diff project files byte-wise
 * to check correctness. Compare the decoded images instead.
 *
 * Format of one sequence:
 *
 *   token      high nibble = literal length, low nibble = matchLength - 4
 *              a nibble of 15 means "read more length bytes", each 255 meaning "continue"
 *   literals   literalLength raw bytes
 *   offset     u16le distance back from the current output position
 *   [extra]    additional match-length bytes if the low nibble was 15
 *
 * The final sequence of a block is literals only, with no offset or match.
 */

import { BLOCK_SIZE } from "./dn2codec.js";

/**
 * A match may not start within the last MF_LIMIT bytes of a block, and the final
 * LAST_LITERALS bytes must always be emitted as literals. These are requirements of the
 * format, not tuning knobs — decoders rely on them to read ahead safely.
 */
const MF_LIMIT = 12;
const LAST_LITERALS = 5;

const MIN_MATCH = 4;
const MAX_OFFSET = 0xffff;

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;

/** Hash four bytes into the match table. */
function hash4(image: Uint8Array, at: number): number {
  const v =
    (image[at]! | (image[at + 1]! << 8) | (image[at + 2]! << 16) | (image[at + 3]! << 24)) >>> 0;
  return Math.imul(v, 2654435761) >>> (32 - HASH_BITS);
}

function writeLength(out: number[], value: number): void {
  let remaining = value;
  while (remaining >= 255) {
    out.push(255);
    remaining -= 255;
  }
  out.push(remaining);
}

/**
 * Compress `image[start..end)` as one LZ4 block.
 *
 * `image` is the whole project image and matches may reach back before `start` into
 * earlier blocks — that is what makes the chain "linked". `table` persists across blocks
 * for the same reason.
 */
function encodeBlock(
  image: Uint8Array,
  start: number,
  end: number,
  table: Int32Array,
  out: number[],
): void {
  const matchLimit = end - MF_LIMIT;
  let anchor = start;
  let at = start;

  while (at < matchLimit) {
    // Find a candidate at least MIN_MATCH bytes long, within the offset window.
    const h = hash4(image, at);
    const candidate = table[h]!;
    table[h] = at;

    const offset = at - candidate;
    if (
      candidate < 0 ||
      offset <= 0 ||
      offset > MAX_OFFSET ||
      image[candidate] !== image[at] ||
      image[candidate + 1] !== image[at + 1] ||
      image[candidate + 2] !== image[at + 2] ||
      image[candidate + 3] !== image[at + 3]
    ) {
      at++;
      continue;
    }

    // Extend the match forward, stopping short of the mandatory trailing literals.
    let length = MIN_MATCH;
    const extendLimit = end - LAST_LITERALS;
    while (at + length < extendLimit && image[candidate + length] === image[at + length]) length++;

    const literalLength = at - anchor;
    const matchLength = length - MIN_MATCH;

    out.push(
      ((literalLength >= 15 ? 15 : literalLength) << 4) | (matchLength >= 15 ? 15 : matchLength),
    );
    if (literalLength >= 15) writeLength(out, literalLength - 15);
    for (let i = 0; i < literalLength; i++) out.push(image[anchor + i]!);

    out.push(offset & 0xff, (offset >> 8) & 0xff);
    if (matchLength >= 15) writeLength(out, matchLength - 15);

    at += length;
    anchor = at;

    // Index the interior of the match so later positions can reference it.
    for (let i = Math.max(start, at - length + 1); i < at && i < matchLimit; i++) {
      table[hash4(image, i)] = i;
    }
  }

  // Trailing literals: the block always ends with a literals-only sequence.
  const literalLength = end - anchor;
  out.push((literalLength >= 15 ? 15 : literalLength) << 4);
  if (literalLength >= 15) writeLength(out, literalLength - 15);
  for (let i = 0; i < literalLength; i++) out.push(image[anchor + i]!);
}

/**
 * Compress a full project image into the block chain that sits between the 31-byte
 * container header and the 12-byte trailer.
 *
 * The returned bytes include each block's u32be size prefix and the terminating zero, so
 * this is exactly the region the check field covers and the length field measures.
 */
export function encodeBlockChain(image: Uint8Array): Uint8Array {
  const chain: number[] = [];
  const table = new Int32Array(HASH_SIZE).fill(-1);

  for (let start = 0; start < image.length; start += BLOCK_SIZE) {
    const end = Math.min(start + BLOCK_SIZE, image.length);
    const block: number[] = [];
    encodeBlock(image, start, end, table, block);

    chain.push(
      (block.length >>> 24) & 0xff,
      (block.length >>> 16) & 0xff,
      (block.length >>> 8) & 0xff,
      block.length & 0xff,
    );
    for (const b of block) chain.push(b);
  }

  chain.push(0, 0, 0, 0);
  return Uint8Array.from(chain);
}
