/**
 * Read an audio file by what its bytes say it is, not by its name.
 *
 * WAV and AIFF only. A caller with other formats decodes them elsewhere, for example with the
 * browser's decoder, and hands the channels in directly.
 */

import { readAiffFile, looksLikeAiff } from "./aifffile.js";
import { AudioError } from "./errors.js";
import { looksLikeWav, readWavFile, type WavAudio } from "./wavfile.js";

export type DecodedAudio = WavAudio;

export function readAudioFile(bytes: Uint8Array): DecodedAudio {
  if (looksLikeWav(bytes)) return readWavFile(bytes);
  if (looksLikeAiff(bytes)) return readAiffFile(bytes);
  throw new AudioError("this is neither a WAV nor an AIFF file");
}
