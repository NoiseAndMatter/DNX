/**
 * Reading a WAV file's samples exactly, without going through the browser's decoder.
 *
 * **One job: RIFF bytes in, channels of floats out, at the file's own rate.**
 *
 * ## Why not `decodeAudioData` for this
 *
 * `decodeAudioData` resamples to the `AudioContext`'s sample rate, and there is no way to ask it
 * not to. A 64 x 2048 wavetable exported at 48 kHz, decoded through a 44.1 kHz context, arrives as
 * 120,422 samples instead of 131,072 — so it no longer divides by 2,048, `proposeGeometry` falls to
 * its inexact path, and the import resamples a table that was already the right shape. The file
 * would still import and would still sound roughly right, which is what makes it worth avoiding:
 * nobody would know.
 *
 * WAV is the format wavetable packs ship in, so reading it here covers the case that matters and
 * everything else can still go through the browser. The web layer tries this first and falls back,
 * and says which it used.
 *
 * ## What it reads
 *
 * Uncompressed PCM, 8, 16, 24 or 32 bit integer, and 32 or 64 bit IEEE float. `WAVE_FORMAT_
 * EXTENSIBLE` is read through to its sub-format, because that is what several exporters write for
 * plain 24-bit material. Anything else is refused by name rather than guessed at: a compressed
 * payload read as PCM is loud noise, and that is a bad first impression of an importer.
 *
 * Chunks are walked rather than assumed to be in order. `fmt ` usually precedes `data`, and files
 * with `LIST`, `cue ` or a broadcast extension between them are common enough that seeking to a
 * fixed offset would fail on real material.
 */

import { AudioError } from "./errors.js";

/** One file's samples, by channel, at the rate the file itself declares. */
export interface WavAudio {
  /** One `Float32Array` per channel, each the same length, nominally -1..1. */
  channels: Float32Array[];
  sampleRate: number;
  /** Frames per channel. */
  frames: number;
  /** What the file said it was, for the report: `"16 bit PCM"`, `"32 bit float"`. */
  format: string;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** Whether these bytes even claim to be a WAV, so the caller can fall back without a throw. */
export function looksLikeWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && fourCC(bytes, 0) === "RIFF" && fourCC(bytes, 8) === "WAVE";
}

/**
 * Read `bytes` as a WAV file.
 *
 * Throws `AudioError` for anything it cannot read exactly. The caller is expected to have
 * checked `looksLikeWav` first and to treat a throw here as "this is a WAV and it is broken or
 * compressed", which is a different message from "this is not a WAV".
 */
export function readWavFile(bytes: Uint8Array): WavAudio {
  if (!looksLikeWav(bytes)) {
    throw new AudioError("this is not a RIFF/WAVE file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let formatTag = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataAt = -1;
  let dataBytes = 0;

  // Walk the chunk list from just past "WAVE".
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = fourCC(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;

    if (id === "fmt " && size >= 16) {
      formatTag = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === FORMAT_EXTENSIBLE && size >= 40) {
        // The real format is the first two bytes of the sub-format GUID.
        formatTag = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataAt = body;
      /*
       * A `data` size that overruns the file is clamped rather than refused. Recorders killed
       * mid-write leave exactly this, and the samples before the cut are perfectly good; refusing
       * the file would be the less useful of the two honest answers.
       */
      dataBytes = Math.min(size, bytes.length - body);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte that is not counted in it.
    at = body + size + (size % 2);
  }

  if (dataAt < 0) throw new AudioError("this WAV has no data chunk");
  if (channelCount <= 0) throw new AudioError("this WAV declares no channels");
  if (sampleRate <= 0) throw new AudioError(`this WAV declares a sample rate of ${sampleRate}`);

  const bytesPerSample = bitsPerSample >> 3;
  if (bytesPerSample <= 0) {
    throw new AudioError(`this WAV declares ${bitsPerSample} bits per sample`);
  }

  let read: (offset: number) => number;
  let name: string;
  if (formatTag === FORMAT_FLOAT && bitsPerSample === 32) {
    read = (offset) => view.getFloat32(offset, true);
    name = "32 bit float";
  } else if (formatTag === FORMAT_FLOAT && bitsPerSample === 64) {
    read = (offset) => view.getFloat64(offset, true);
    name = "64 bit float";
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 8) {
    // 8-bit WAV is unsigned, alone among the integer widths.
    read = (offset) => (view.getUint8(offset) - 128) / 128;
    name = "8 bit PCM";
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 16) {
    read = (offset) => view.getInt16(offset, true) / 32_768;
    name = "16 bit PCM";
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 24) {
    read = (offset) => {
      const low = view.getUint8(offset);
      const mid = view.getUint8(offset + 1);
      const high = view.getInt8(offset + 2);
      return ((high << 16) | (mid << 8) | low) / 8_388_608;
    };
    name = "24 bit PCM";
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 32) {
    read = (offset) => view.getInt32(offset, true) / 2_147_483_648;
    name = "32 bit PCM";
  } else {
    throw new AudioError(
      `this WAV is format ${formatTag} at ${bitsPerSample} bits, which is not uncompressed PCM or ` +
        `IEEE float. Export it as 16, 24 or 32 bit WAV and import that.`,
    );
  }

  const frameBytes = bytesPerSample * channelCount;
  const frames = Math.floor(dataBytes / frameBytes);
  if (frames === 0) throw new AudioError("this WAV's data chunk holds no complete frames");

  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = dataAt + f * frameBytes;
    for (let c = 0; c < channelCount; c++) {
      channels[c]![f] = read(base + c * bytesPerSample);
    }
  }

  return { channels, sampleRate, frames, format: name };
}

/**
 * Mix channels down to one.
 *
 * **Averaged, not first-channel.** A stereo wavetable export is nearly always the same waveform on
 * both channels, where averaging is exact and taking channel one is equally exact; where they
 * differ, an average keeps both and a pick silently discards half the material.
 *
 * The cost is that content in opposite phase cancels, so the result reports both peaks and lets the
 * caller say so. That is better than either choice made silently, because the symptom of
 * cancellation is a table that is quiet or empty for no visible reason.
 */
export function mixToMono(channels: readonly Float32Array[]): {
  samples: Float32Array;
  peak: number;
  firstChannelPeak: number;
} {
  if (channels.length === 0) throw new AudioError("there are no channels to mix");
  const frames = channels[0]!.length;
  const samples = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (const channel of channels) sum += channel[f]!;
    samples[f] = sum / channels.length;
  }

  let peak = 0;
  let firstChannelPeak = 0;
  for (let f = 0; f < frames; f++) {
    peak = Math.max(peak, Math.abs(samples[f]!));
    firstChannelPeak = Math.max(firstChannelPeak, Math.abs(channels[0]![f]!));
  }
  return { samples, peak, firstChannelPeak };
}
