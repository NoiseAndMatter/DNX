/**
 * The 32-bit check field in the Elektron project payload footer.
 *
 * Layout of the last twelve bytes of a payload:
 *
 *   end-12  u32be   check field   <- computed here
 *   end-8   u32be   length field  == payloadLength - 43
 *   end-4   AA A1 DA AA           container footer magic
 *
 * ## Algorithm
 *
 * A reflected CRC-32 over the bytes `[0x1F, payloadLength - 12)`, stored big-endian:
 *
 *   width   32
 *   poly    0x04C11DB7   (reversed: 0xEDB88320 — the ordinary CRC-32 polynomial)
 *   init    0x00000000   <- NOT 0xFFFFFFFF
 *   refin   true
 *   refout  true
 *   xorout  0xFFFFFFFF
 *
 * It is therefore *not* plain CRC-32/ISO-HDLC, which is why the obvious guess fails.
 * It differs only in the initial register value: ISO-HDLC pre-loads the register with
 * all ones, this variant starts from zero and still complements the result. The pair
 * of differences — a non-standard init and a message that starts at 0x1F rather than
 * at the container header or the first object — is what makes the field look opaque.
 *
 * Equivalent one-liner under Node's zlib, whose `crc32` applies the ISO-HDLC
 * pre/post-complement internally, so seeding it with all ones cancels the pre-inversion:
 *
 *   zlib.crc32(payload.subarray(0x1f, payload.length - 12), 0xffffffff)
 *
 * The table is built inline instead so this module stays runtime-independent.
 *
 * ## Covered region
 *
 * The message is exactly the region the neighbouring length field measures:
 * `payloadLength - 43` bytes beginning at 0x1F. That is the strongest evidence the
 * offset is right — check field and length field describe the same run of bytes, and
 * the region ends immediately before the check field itself.
 *
 * 0x1F is the first byte of a u32be counter that runs 0x1F..0x22, followed by the
 * constant tag F0 05 at 0x23 and then the object chain at 0x25. That counter ranges
 * from 258 to 1786 across the DN1 files and is 2520 on the DN2 file; its meaning is
 * still unidentified. It does not track payload size (the size-to-counter ratio spans
 * 13x to 111x), it does not appear anywhere else in the payload, and it is not the
 * occurrence count of any single byte or byte pair. It does track content: the related
 * projects 050 JAGGED and 052 JAGGED_PLAY carry the same value 1115 at different sizes.
 * Everything before
 * 0x1F — the container magic, format version, object version and project slot — is
 * outside the check, so editing the slot number does not invalidate a payload.
 *
 * Note that byte 0x1F is 0x00 in all 54 reference files, and feeding a zero byte to a
 * zero-initialised CRC-32 register is a no-op, so starting at 0x20 yields the same
 * value on every known file. 0x1F is used here because it is the offset that makes the
 * check field and the length field agree, which is far more likely to be the real
 * definition than a coincidental leading zero.
 *
 * ## Verification
 *
 * Recovered by algebraic search rather than by guessing: for each candidate polynomial,
 * reflection setting and byte range, the relation
 *
 *   check_i = crc0(M_i) ^ A(len_i)(init) ^ xorout
 *
 * is affine over GF(2) in the 64 unknown bits of (init, xorout), so the unknowns can be
 * solved for directly by Gaussian elimination instead of enumerated. The search was
 * first validated by planting a known CRC-32/BZIP2 in a synthetic corpus and confirming
 * it was recovered. Against the real corpus exactly one solution family survived, and
 * the system had full rank 64 while being consistent across all 54 reference files
 * (1728 simultaneous GF(2) equations), so the fit is not a coincidence.
 *
 * Confirmed independently against all 54 reference projects — 53 Digitone 1 files
 * (OS 1.42A) and 1 Digitone II file (OS 1.10E) — with a straight zlib implementation.
 * Payload sizes range from 18 KB to 230 KB.
 */

/** First byte of the payload covered by the check field. */
export const CHECK_REGION_START = 0x1f;

/** Number of trailing bytes excluded: the check field, the length field and the footer magic. */
export const CHECK_REGION_TRAILER = 12;

const REVERSED_POLY = 0xedb88320;
const INIT = 0x00000000;
const XOR_OUT = 0xffffffff;

const TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ REVERSED_POLY : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * The byte range the check field covers: `payloadLength - 43` bytes from 0x1F, which is
 * the same region the payload's length field measures.
 */
export function checkRegion(payload: Uint8Array): Uint8Array {
  const end = payload.length - CHECK_REGION_TRAILER;
  if (end <= CHECK_REGION_START) {
    throw new RangeError(`Payload too short to hold a check region (${payload.length} bytes)`);
  }
  return payload.subarray(CHECK_REGION_START, end);
}

/** Reflected CRC-32 with a zero initial register and a complemented result. */
export function crc32ZeroInit(data: Uint8Array): number {
  let crc = INIT;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return ((crc ^ XOR_OUT) >>> 0);
}

/** Compute the check field a payload should carry, as an unsigned 32-bit value. */
export function computeCheckField(payload: Uint8Array): number {
  return crc32ZeroInit(checkRegion(payload));
}

/** Read the check field stored in the payload footer. */
export function readCheckField(payload: Uint8Array): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getUint32(payload.length - CHECK_REGION_TRAILER, false);
}

/** Whether the stored check field matches the payload contents. */
export function isCheckValid(payload: Uint8Array): boolean {
  return readCheckField(payload) === computeCheckField(payload);
}

/**
 * Recompute the check field and write it into the payload in place.
 *
 * Call this last when building a payload: the check covers everything up to its own
 * offset, so any earlier edit invalidates it. The length field and footer magic sit
 * after the check field and are not covered, but they must already be sized correctly
 * because the region end is derived from `payload.length`.
 */
export function stampCheckField(payload: Uint8Array): number {
  const value = computeCheckField(payload);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(payload.length - CHECK_REGION_TRAILER, value, false);
  return value;
}
