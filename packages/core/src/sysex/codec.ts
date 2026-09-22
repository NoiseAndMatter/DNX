/**
 * Elektron 8-in-7 payload codec.
 *
 * SysEx data bytes may only use 7 bits, so Elektron packs 7 raw bytes into 8 wire
 * bytes. Each group is `[msb, d0..d6]`, where `msb` collects the high bits of the
 * seven data bytes that follow it.
 *
 * The bit order is MSB-first, which is NOT the more common Roland/Yamaha convention:
 *
 *   msb: [ 0  d0.7  d1.7  d2.7  d3.7  d4.7  d5.7  d6.7 ]
 *            bit6  bit5  bit4  bit3  bit2  bit1  bit0
 *
 * A trailing partial group is allowed: n raw bytes encode to n+1 wire bytes.
 * Verified against Digitone 1 sound banks and Digitone II pattern dumps.
 */

const GROUP_RAW = 7;
const GROUP_ENCODED = 8;

/** Pack raw bytes into 7-bit-safe SysEx data bytes. */
export function encode87(raw: Uint8Array): Uint8Array {
  const fullGroups = Math.floor(raw.length / GROUP_RAW);
  const remainder = raw.length % GROUP_RAW;
  const out = new Uint8Array(fullGroups * GROUP_ENCODED + (remainder > 0 ? remainder + 1 : 0));

  let src = 0;
  let dst = 0;
  while (src < raw.length) {
    const n = Math.min(GROUP_RAW, raw.length - src);
    let msb = 0;
    for (let i = 0; i < n; i++) {
      const b = raw[src + i]!;
      msb |= (b >> 7) << (6 - i);
      out[dst + 1 + i] = b & 0x7f;
    }
    out[dst] = msb;
    src += n;
    dst += n + 1;
  }
  return out;
}

/** Unpack 7-bit SysEx data bytes back into raw bytes. Exact inverse of `encode87`. */
export function decode87(enc: Uint8Array): Uint8Array {
  const fullGroups = Math.floor(enc.length / GROUP_ENCODED);
  const remainder = enc.length % GROUP_ENCODED;
  if (remainder === 1) {
    // A lone msb byte with no data bytes behind it cannot have been produced by encode87.
    throw new Error(`Malformed 8-in-7 payload: trailing group of 1 byte (length ${enc.length})`);
  }
  const out = new Uint8Array(fullGroups * GROUP_RAW + (remainder > 0 ? remainder - 1 : 0));

  let src = 0;
  let dst = 0;
  while (src < enc.length) {
    const n = Math.min(GROUP_ENCODED, enc.length - src) - 1;
    const msb = enc[src]!;
    for (let i = 0; i < n; i++) {
      out[dst + i] = enc[src + 1 + i]! | (((msb >> (6 - i)) & 1) << 7);
    }
    src += n + 1;
    dst += n;
  }
  return out;
}
