/**
 * Import one audio file as a sample: read it, convert it, identify it.
 *
 * **One job: the three steps in order**, so every caller imports the same way. Adding the
 * result to a library, and storing its bytes, are the caller's next steps.
 */

import { readAudioFile } from "../audio/readaudio.js";
import { convertToStored, type ConvertOptions, type ConvertReport } from "./convert.js";
import type { StoredSample } from "./format.js";
import { identify, type SampleId } from "./identity.js";
import type { SampleObject } from "./library.js";

export interface ImportedSample {
  sample: StoredSample;
  id: SampleId;
  /** What a library records for it. */
  object: SampleObject;
  report: ConvertReport;
}

/** Import a WAV or AIFF file's bytes. Throws `AudioError` or `SampleError` with the reason. */
export function importAudioFile(bytes: Uint8Array, options: ConvertOptions = {}): ImportedSample {
  const audio = readAudioFile(bytes);
  const { sample, report } = convertToStored(audio, options);
  const id = identify(sample);
  return { sample, id, object: { id, channels: sample.channels, frames: sample.frames }, report };
}
