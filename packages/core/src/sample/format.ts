/**
 * A sample as DNX keeps it: the form every other sample module works on.
 *
 * **16-bit integer PCM at 48 kHz, mono or interleaved stereo.** That is the Digitakt II's sample
 * format, and the owner chose it for the DN2 on 2026-10-21. The DT2 and the DN2 both carry the
 * capability keys `sample_file.sample_rates`, `sample_file.mono_support` and
 * `sample_file.interleaved_stereo_support`, with the string `48000` beside them. Neither unit has
 * been asked those keys yet, so the rate is the owner's reading and not a device answer.
 *
 * ## The master copy, not the device's bytes
 *
 * DNX holds the master copy, and the device holds a cache. This module defines the master copy
 * only. How the device lays a sample out on its storage (a header, a trailer, byte order) is not
 * agreed yet, and lives behind `devicestore.ts` when it is.
 *
 * **The identity is computed over the master copy's canonical bytes:** the interleaved samples as
 * little-endian `int16`, nothing else. So the link from a sound to a sample does not depend on the
 * device's layout, the file's name, its folder or the source it came from. See `identity.ts`.
 */

import { SampleError } from "./errors.js";

/** The one rate a stored sample has. */
export const SAMPLE_RATE = 48_000;

/** Bytes per sample point: 16-bit. */
export const BYTES_PER_POINT = 2;

export type ChannelCount = 1 | 2;

/** One converted sample, ready to hash, plan, preview and send. */
export interface StoredSample {
  channels: ChannelCount;
  /** Frames per channel. */
  frames: number;
  /** `frames * channels` points, interleaved L R L R for stereo. */
  pcm: Int16Array;
}

/** Build a stored sample, checking that its parts agree. */
export function storedSample(channels: number, pcm: Int16Array): StoredSample {
  if (channels !== 1 && channels !== 2) {
    throw new SampleError(`a stored sample is mono or stereo, and this has ${channels} channels`);
  }
  if (pcm.length === 0) throw new SampleError("a stored sample has at least one frame");
  if (pcm.length % channels !== 0) {
    throw new SampleError(`${pcm.length} points do not divide into ${channels} channels`);
  }
  return { channels, frames: pcm.length / channels, pcm };
}

/** The size in bytes of the stored samples: what the identity's size field holds. */
export function storedBytes(sample: StoredSample): number {
  return sample.pcm.length * BYTES_PER_POINT;
}

/** The length in seconds. */
export function seconds(sample: StoredSample): number {
  return sample.frames / SAMPLE_RATE;
}

/**
 * The canonical bytes: interleaved little-endian `int16`.
 *
 * Written byte by byte rather than by viewing the `Int16Array`'s buffer, because the buffer's
 * order is the platform's. Every platform DNX runs on today is little-endian, and the identity
 * must not depend on that.
 */
export function canonicalBytes(sample: StoredSample): Uint8Array {
  const out = new Uint8Array(sample.pcm.length * 2);
  for (let i = 0; i < sample.pcm.length; i++) {
    const v = sample.pcm[i]!;
    out[2 * i] = v & 0xff;
    out[2 * i + 1] = (v >> 8) & 0xff;
  }
  return out;
}

/**
 * The stored sample as floats, one array per channel, scaled as a reader on the device would:
 * `value / 32768`. What a preview plays.
 */
export function toFloatChannels(sample: StoredSample): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < sample.channels; c++) out.push(new Float32Array(sample.frames));
  for (let f = 0; f < sample.frames; f++) {
    for (let c = 0; c < sample.channels; c++) {
      out[c]![f] = sample.pcm[f * sample.channels + c]! / 32_768;
    }
  }
  return out;
}
