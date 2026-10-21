/**
 * Turning a file the person dropped into mono samples, at the file's own rate where possible.
 *
 * **One job: a `File` becomes samples and a report about them.** Choosing a geometry is `fit.ts`,
 * packing the result is `convert.ts`. This is the edge where an arbitrary file becomes numbers.
 *
 * ## WAV is read exactly, everything else goes through the browser
 *
 * `decodeAudioData` resamples to the `AudioContext`'s rate and cannot be told not to. A 64 x 2048
 * table exported at 48 kHz, decoded on a 44.1 kHz context, arrives as 120,422 samples: it stops
 * dividing by 2,048, the proposal falls to its inexact path, and a table that was already the right
 * shape gets resampled. It would still import and still sound about right, which is why it is worth
 * the WAV reader to avoid.
 *
 * So WAV bytes go to `readWavFile`, and anything else goes to the browser with `resampled` set, so
 * a pane can say the sample count is not the file's own. **Both paths report which was used**,
 * because "why did my 64-frame table import as 11 frames" is a question somebody will ask and the
 * answer has to be on screen rather than in this comment.
 *
 * ## Mono, and the cancellation it can cause
 *
 * The table format is mono. Channels are averaged rather than picked, which is exact for the usual
 * case of the same waveform on both, and keeps both where they differ. Opposite-phase channels
 * cancel, so the report carries the mono peak and the first channel's peak and says when they
 * disagree badly. A table that came out quiet for no visible reason is otherwise a long afternoon.
 */

import { sharedAudioContext } from "../audiocontext.js";
import { looksLikeWav, mixToMono, readWavFile } from "@noiseandmatter/dnx-core/audio/wavfile.js";

/** What a dropped file turned out to be. */
export interface DecodedFile {
  /**
   * The file's own bytes, kept for `PendingSlot.sourceHash`.
   *
   * The hash records **the file the table was made from**, so it has to be of these rather than of
   * the converted payload: the same WAV imported at two geometries is one source, and a re-import
   * of it at the same geometry should be recognisable as one.
   */
  bytes: Uint8Array;
  /** Mono, nominally -1..1, though float WAV may exceed it. */
  samples: Float32Array;
  /** The file's own rate on the WAV path, the context's on the fallback. */
  sampleRate: number;
  channels: number;
  seconds: number;
  /** Peak of the mono mix. 0 means silence, which is worth saying rather than importing. */
  peak: number;
  /** Peak of the first channel alone, for comparison with the mix. */
  firstChannelPeak: number;
  /**
   * Whether averaging the channels lost most of the signal.
   *
   * Half is the threshold: stereo material that merely differs loses a little, and material in
   * opposite phase loses nearly all of it. Either way this is reported, never acted on.
   */
  cancelled: boolean;
  /** Whether the sample count may not be the file's own, because the browser resampled it. */
  resampled: boolean;
  /** One phrase for the pane: `"24 bit PCM, 48000 Hz"`. */
  describedAs: string;
}

/** How much of the peak has to survive the mono mix before it counts as cancellation. */
const CANCELLED_BELOW = 0.5;

/**
 * Decode `file` to mono samples.
 *
 * Throws when the file cannot be decoded at all. A WAV that claims to be a WAV and is broken
 * throws its own message from the reader, which is more useful than the browser's, so the fallback
 * is only taken for files that are not WAV at all.
 */
export async function decodeTableFile(file: File): Promise<DecodedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (looksLikeWav(bytes)) {
    const wav = readWavFile(bytes);
    const { samples, peak, firstChannelPeak } = mixToMono(wav.channels);
    return {
      bytes,
      samples,
      sampleRate: wav.sampleRate,
      channels: wav.channels.length,
      seconds: wav.frames / wav.sampleRate,
      peak,
      firstChannelPeak,
      cancelled: firstChannelPeak > 0 && peak < firstChannelPeak * CANCELLED_BELOW,
      resampled: false,
      describedAs: `${wav.format}, ${wav.sampleRate.toLocaleString()} Hz`,
    };
  }

  const audio = sharedAudioContext();
  let buffer: AudioBuffer;
  try {
    // `decodeAudioData` detaches the buffer it is given, so it gets a copy of its own.
    buffer = await audio.decodeAudioData(bytes.slice().buffer);
  } catch (error: unknown) {
    throw new Error(
      `${file.name} is not a WAV and the browser could not decode it either: ${String(error)}`,
    );
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const { samples, peak, firstChannelPeak } = mixToMono(channels);

  return {
    bytes,
    samples,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    seconds: buffer.duration,
    peak,
    firstChannelPeak,
    cancelled: firstChannelPeak > 0 && peak < firstChannelPeak * CANCELLED_BELOW,
    resampled: true,
    describedAs: `decoded by the browser at ${buffer.sampleRate.toLocaleString()} Hz`,
  };
}
