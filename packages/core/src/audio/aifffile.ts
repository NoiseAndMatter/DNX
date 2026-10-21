/**
 * Reading an AIFF or AIFF-C file's samples exactly.
 *
 * **One job: FORM bytes in, channels of floats out, at the file's own rate.** The same result
 * shape as `wavfile.ts`, so a caller treats the two alike.
 *
 * ## What it reads
 *
 * - AIFF: big-endian integer PCM, 8, 16, 24 or 32 bit.
 * - AIFF-C with compression `NONE` (big-endian), `sowt` (little-endian, what macOS writes),
 *   `fl32` or `fl64` (big-endian IEEE float).
 *
 * Anything else is refused by name. The sample rate is an 80-bit IEEE extended float in `COMM`,
 * read here without a library. Chunks are walked, not assumed to be in order.
 */

import { AudioError } from "./errors.js";
import type { WavAudio } from "./wavfile.js";

/** The same shape as a WAV's result: channels of floats at the file's rate. */
export type AiffAudio = WavAudio;

function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** Whether these bytes claim to be AIFF or AIFF-C, so a caller can choose a reader. */
export function looksLikeAiff(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || fourCC(bytes, 0) !== "FORM") return false;
  const kind = fourCC(bytes, 8);
  return kind === "AIFF" || kind === "AIFC";
}

/**
 * An 80-bit IEEE 754 extended float: a sign, a 15-bit exponent and a 64-bit mantissa with an
 * explicit integer bit. Only the rate uses it, so 53 bits of the mantissa are enough.
 */
export function readExtended(view: DataView, at: number): number {
  const signAndExponent = view.getUint16(at);
  const high = view.getUint32(at + 2);
  const low = view.getUint32(at + 6);
  const sign = signAndExponent & 0x8000 ? -1 : 1;
  const exponent = signAndExponent & 0x7fff;
  if (exponent === 0 && high === 0 && low === 0) return 0;
  const mantissa = high * 2 ** 32 + low;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

/** Read `bytes` as AIFF or AIFF-C. Throws `AudioError` for anything it cannot read exactly. */
export function readAiffFile(bytes: Uint8Array): AiffAudio {
  if (!looksLikeAiff(bytes)) throw new AudioError("this is not an AIFF or AIFF-C file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressed = fourCC(bytes, 8) === "AIFC";

  let channelCount = 0;
  let declaredFrames = 0;
  let bitsPerSample = 0;
  let sampleRate = 0;
  let compression = "NONE";
  let dataAt = -1;
  let dataBytes = 0;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = fourCC(bytes, at);
    const size = view.getUint32(at + 4);
    const body = at + 8;

    if (id === "COMM" && size >= 18) {
      channelCount = view.getUint16(body);
      declaredFrames = view.getUint32(body + 2);
      bitsPerSample = view.getUint16(body + 6);
      sampleRate = readExtended(view, body + 8);
      if (compressed && size >= 22) compression = fourCC(bytes, body + 18);
    } else if (id === "SSND" && size >= 8) {
      // SSND opens with an offset to the first sample and a block size, which is almost always 0.
      const offset = view.getUint32(body);
      dataAt = body + 8 + offset;
      dataBytes = Math.max(0, Math.min(size - 8 - offset, bytes.length - dataAt));
    }

    // Chunks are word-aligned, as in RIFF.
    at = body + size + (size % 2);
  }

  if (dataAt < 0) throw new AudioError("this AIFF has no SSND chunk");
  if (channelCount <= 0) throw new AudioError("this AIFF declares no channels");
  if (!(sampleRate > 0)) throw new AudioError(`this AIFF declares a sample rate of ${sampleRate}`);

  let read: (offset: number) => number;
  let width: number;
  let name: string;
  if (compression === "fl32" || compression === "FL32") {
    width = 4;
    read = (offset) => view.getFloat32(offset);
    name = "32 bit float";
  } else if (compression === "fl64" || compression === "FL64") {
    width = 8;
    read = (offset) => view.getFloat64(offset);
    name = "64 bit float";
  } else if (compression === "NONE" || compression === "sowt") {
    const little = compression === "sowt";
    width = Math.ceil(bitsPerSample / 8);
    if (width === 1) {
      // AIFF's 8-bit samples are signed, unlike WAV's.
      read = (offset) => view.getInt8(offset) / 128;
    } else if (width === 2) {
      read = (offset) => view.getInt16(offset, little) / 32_768;
    } else if (width === 3) {
      read = little
        ? (offset) =>
            ((view.getInt8(offset + 2) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset)) /
            8_388_608
        : (offset) =>
            ((view.getInt8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)) /
            8_388_608;
    } else if (width === 4) {
      read = (offset) => view.getInt32(offset, little) / 2_147_483_648;
    } else {
      throw new AudioError(`this AIFF declares ${bitsPerSample} bits per sample`);
    }
    name = `${bitsPerSample} bit PCM`;
  } else {
    throw new AudioError(
      `this AIFF-C is compressed as "${compression}". Export it as uncompressed AIFF or WAV and ` +
        `import that.`,
    );
  }

  const frameBytes = width * channelCount;
  const frames = Math.min(declaredFrames, Math.floor(dataBytes / frameBytes));
  if (frames === 0) throw new AudioError("this AIFF's SSND chunk holds no complete frames");

  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = dataAt + f * frameBytes;
    for (let c = 0; c < channelCount; c++) channels[c]![f] = read(base + c * width);
  }
  return { channels, sampleRate, frames, format: name };
}
