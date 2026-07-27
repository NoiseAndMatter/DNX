/**
 * Run-length encoding, used only to keep the blank patternKits in `blankdata.ts` small.
 *
 * A device-initialised pattern is mostly long runs — the 8,192-slot trigger array is
 * 0xFF-filled and most of the record is zero — so plain RLE takes the DN2's 99,840-byte
 * patternKit to about 15% of its size, and the DN1's 20,992 to about 25%.
 *
 * ## Why not gzip
 *
 * `DecompressionStream` would do noticeably better and is a platform API in both Node and
 * the browser, so it would add no dependency. It is also **asynchronous**, and that would
 * spread through every caller: `applyRearrange` would have to become async purely because
 * of how a constant is stored. A few extra kilobytes in a source file is the cheaper cost.
 *
 * Format: `[count varint][value byte]`, repeated. No literal mode — the data has no
 * incompressible stretches long enough to make one worth the complexity, and pure RLE is
 * small enough to check by eye.
 */

export class RleError extends Error {}

export function rleEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const value = data[i]!;
    let run = 1;
    while (i + run < data.length && data[i + run] === value) run++;

    let n = run;
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n, value);
    i += run;
  }
  return Uint8Array.from(out);
}

/**
 * Decode into a buffer of exactly `size` bytes.
 *
 * The expected size is required rather than inferred so a truncated or overlong stream is
 * caught here, where it is obviously a corrupt constant, rather than surfacing later as a
 * mysteriously malformed pattern.
 */
export function rleDecode(encoded: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  let i = 0;

  while (i < encoded.length) {
    let count = 0;
    let shift = 0;
    for (;;) {
      if (i >= encoded.length) throw new RleError("truncated run length");
      const b = encoded[i++]!;
      count |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new RleError("run length overflows");
    }
    if (i >= encoded.length) throw new RleError("run length with no value");
    if (at + count > size) {
      throw new RleError(`decoded ${at + count} bytes, expected ${size}`);
    }
    out.fill(encoded[i++]!, at, at + count);
    at += count;
  }

  if (at !== size) throw new RleError(`decoded ${at} bytes, expected ${size}`);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64, so the encoded blanks can live in a TypeScript source file. */
export function toBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new RleError(`bad base64 character ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}
