/**
 * Compression codec for `.dnprj` / `.dn2prj` project payloads.
 *
 * The project payload body is NOT plain binary. It is a chain of **LZ4 block-format**
 * blocks that share one continuous dictionary (LZ4 "linked blocks"), each decoding to
 * exactly 32,768 bytes apart from the last.
 *
 * This was missed at first because the compression ratio is high (40x-150x) and the
 * decoded image is mostly 0xFF and 0x00, so a naive entropy probe on the *compressed*
 * bytes reads low (3.7-6.2 bits) rather than the ~7.9 expected of compressed data.
 * The literal runs an LZ4 stream leaves behind are long stretches of readable ASCII and
 * structure, which is exactly what made the payload look uncompressed.
 *
 * It also explains the "stride-6 0xFF" anomaly seen in raw DN2 payloads, where sound
 * names read `SHAK ff R VEL ff CY T` instead of `SHAKER VELDCY T`. Those 0xFF bytes are
 * not punched-out data: they are the low byte of the u16le match offset in an LZ4
 * sequence, sitting between two literal runs. A repeated `[offset][token][literals]`
 * triple with one literal per sequence produces a byte that repeats every 6 bytes.
 * After decoding, every name is clean ASCII.
 *
 * Block chain layout inside the payload:
 *
 *   0x1F        u32be  compressed size of block 0   (this is also where the CRC region
 *                                                    starts, which is not a coincidence)
 *   0x23        block 0 bytes
 *   ...         u32be  compressed size of block 1, then block 1 bytes, ...
 *   <terminator> u32be 0
 *   len-12      CRC / length / footer, see container.ts
 *
 * Verified: all 53 DN1 payloads decode to exactly 2,781,700 bytes and all 9 DN2
 * payloads to exactly 12,889,604 bytes, with the block chain landing exactly on the
 * zero terminator in every file. Nothing is left over and nothing is short.
 */

/** Offset of the first block-size field. Also the first byte covered by the CRC. */
export const BLOCK_CHAIN_START = 0x1f;

/** Bytes reserved at the end of the payload for CRC (4), length (4) and footer (4). */
export const TRAILER_SIZE = 12;

/**
 * Uncompressed size of every block except the last.
 *
 * Not read from the file — there is no field for it. It is inferred: every non-final
 * block in all 62 corpus payloads produces exactly this many bytes.
 */
export const BLOCK_SIZE = 32768;

/** Decoded image size of a Digitone 1 project. Identical in all 53 DN1 payloads. */
export const DN1_IMAGE_SIZE = 2_781_700;

/** Decoded image size of a Digitone II project. Identical in all 9 DN2 payloads. */
export const DN2_IMAGE_SIZE = 12_889_604;

/**
 * Decoded image size of a Digitone II project written by **OS 1.11**. Container format `"0059"`.
 *
 * 512 bytes longer than 1.10E's, and **nothing before them moved**. Measured 2026-09-14 on the
 * same project read both ways: the header, all 128 patterns, all 128 kits and the old tail are
 * byte-identical, and every `BEEFBACE` object sits at the same offset with the same version. The
 * appended block holds two new version-2 objects. The firmware's type table gained
 * `BOB::bobConfigStorage_v0_t` (BreakOutBoxSettings, the Outbox 8) in the same release, which is
 * the likeliest reading of them and is not yet confirmed.
 *
 * 1.11 upgraded every stored project on the instrument it was installed on, so this is not an edge
 * case: on that machine it is the only size there is.
 */
export const DN2_OS111_IMAGE_SIZE = 12_890_116;

export class Lz4DecodeError extends Error {}

/**
 * Decode one LZ4 block-format stream into `out`.
 *
 * `out` is passed in rather than returned because blocks are *linked*: a match in block
 * n may reference bytes produced by block n-1. Decoding each block into a fresh buffer
 * fails almost immediately for exactly that reason.
 *
 * Standard LZ4 block format, no deviations found:
 *   token byte: high nibble = literal count, low nibble = match length - 4
 *   counts of 15 are extended by a chain of bytes, terminated by any byte != 255
 *   literals follow the token, then a u16le match offset
 *   the final sequence in a block is literals only and carries no offset
 */
function decodeBlock(src: Uint8Array, start: number, end: number, out: number[]): void {
  let at = start;

  while (at < end) {
    const token = src[at++]!;

    let literals = token >> 4;
    if (literals === 15) {
      for (;;) {
        const b = src[at++]!;
        literals += b;
        if (b !== 0xff) break;
      }
    }
    for (let i = 0; i < literals; i++) out.push(src[at + i]!);
    at += literals;

    // A block ends on a literal run; there is no offset after it.
    if (at >= end) break;

    const offset = src[at]! | (src[at + 1]! << 8);
    at += 2;

    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      for (;;) {
        const b = src[at++]!;
        matchLength += b;
        if (b !== 0xff) break;
      }
    }

    const from = out.length - offset;
    if (offset === 0 || from < 0) {
      throw new Lz4DecodeError(
        `Invalid match offset ${offset} at input 0x${at.toString(16)} (output ${out.length})`,
      );
    }
    // Byte-at-a-time on purpose: overlapping matches (offset < matchLength) are the
    // normal way LZ4 encodes runs, e.g. offset 1 to repeat a single padding byte.
    for (let i = 0; i < matchLength; i++) out.push(out[from + i]!);
  }

  if (at !== end) {
    throw new Lz4DecodeError(`Block overran its declared size by ${at - end} bytes`);
  }
}

export interface DecodedImage {
  /** The fully decompressed project image. */
  image: Uint8Array;
  /** Compressed size of each block, in order, as stored in the u32be headers. */
  blockSizes: number[];
}

/**
 * Decompress a project payload body into the full project image.
 *
 * `payload` is the raw bytes of the ZIP's binary entry, i.e. what `parsePayload` in
 * container.ts is handed. The container header (0x00..0x1E) and the 12-byte trailer are
 * skipped here; only the block chain between them is consumed.
 */
export function decodeProjectImage(payload: Uint8Array): DecodedImage {
  const limit = payload.length - TRAILER_SIZE;
  if (limit <= BLOCK_CHAIN_START) {
    throw new Lz4DecodeError(`Payload too short to hold a block chain (${payload.length} bytes)`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: number[] = [];
  const blockSizes: number[] = [];
  let at = BLOCK_CHAIN_START;

  while (at < limit) {
    const size = view.getUint32(at, false);
    at += 4;
    // A zero size terminates the chain. It sits just before the CRC in every payload.
    if (size === 0) break;
    if (at + size > limit) {
      throw new Lz4DecodeError(
        `Block at 0x${(at - 4).toString(16)} claims ${size} bytes but only ${limit - at} remain`,
      );
    }
    decodeBlock(payload, at, at + size, out);
    blockSizes.push(size);
    at += size;
  }

  return { image: Uint8Array.from(out), blockSizes };
}
