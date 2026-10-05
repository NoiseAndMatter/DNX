/**
 * Rebuild a project payload from a modified image.
 *
 * The inverse of decodeProjectImage. Layout of the payload we emit:
 *
 *   0x00..0x1E   container header, copied verbatim from the source payload
 *   0x1F..       LZ4 block chain, terminated by a u32be zero
 *   end-12       u32be check field   (CRC-32, zero init, over the chain)
 *   end-8        u32be length        (= chain byte count)
 *   end-4        AA A1 DA AA
 *
 * The header is copied rather than synthesised because it carries the device signature at
 * 0x1A..0x1D and the project slot at 0x18, plus bytes we have not identified. Preserving
 * unknown regions verbatim is the same discipline elk-herd uses, and it is what makes a
 * partial understanding of a format safe to write with.
 *
 * A rebuilt payload will normally NOT be byte-identical to the original even when nothing
 * changed, because our LZ4 encoder makes different (equally valid) choices from
 * Elektron's. Correctness is defined as "decodes to the same image", not "same bytes".
 */

import { COMPRESSED_FLAG_OFFSET } from "./container.js";
import { crc32ZeroInit } from "./checksum.js";
import { BLOCK_CHAIN_START, TRAILER_SIZE } from "./dn2codec.js";
import { encodeBlockChain } from "./lz4encode.js";

const FOOTER_MAGIC = Uint8Array.of(0xaa, 0xa1, 0xda, 0xaa);

/**
 * The value this writer stamps at `COMPRESSED_FLAG_OFFSET`, since everything it emits is an LZ4
 * chain. The offset and the evidence for it live in `container.js` beside the rest of the header.
 */
const COMPRESSED = 0x01;

export class ProjectWriteError extends Error {}

/**
 * Build a complete payload from a source payload's header plus a (possibly modified) image.
 *
 * Pass the original payload so its header survives; pass the image you want stored.
 */
export function buildPayload(sourcePayload: Uint8Array, image: Uint8Array): Uint8Array {
  if (sourcePayload.length < BLOCK_CHAIN_START + TRAILER_SIZE) {
    throw new ProjectWriteError(
      `Source payload too short to carry a header (${sourcePayload.length} bytes)`,
    );
  }

  const chain = encodeBlockChain(image);
  const total = BLOCK_CHAIN_START + chain.length + TRAILER_SIZE;
  const out = new Uint8Array(total);

  out.set(sourcePayload.subarray(0, BLOCK_CHAIN_START), 0);
  // **The header must describe what we actually wrote.** Copying it verbatim is right for every
  // byte but this one: a payload read off the +Drive carries an *uncompressed* body and says so
  // here, and what goes out below is always an LZ4 chain. Copying the 0 through produced a file
  // claiming to be uncompressed with compressed contents — which our own reader survives, because
  // it measures rather than trusting the flag, and Elektron Transfer does not: it stopped at
  // "Calculating Checksum" and crashed.
  out[COMPRESSED_FLAG_OFFSET] = COMPRESSED;
  out.set(chain, BLOCK_CHAIN_START);

  const view = new DataView(out.buffer);
  view.setUint32(total - 12, crc32ZeroInit(chain), false);
  // The length field measures the check-covered region, which is exactly the chain.
  view.setUint32(total - 8, chain.length, false);
  out.set(FOOTER_MAGIC, total - 4);

  return out;
}
