/**
 * Play a stored sample, so the user hears what the device will hold.
 *
 * **It plays the converted master copy**, not the source file. So a preview carries the
 * resampling, the dither and any high-pass or normalising the import applied. Nothing is sent to
 * the device: DNX plays its own copy.
 *
 * The buffer is made at 48 kHz, the stored rate. The browser converts it to the output's rate as
 * it plays, which affects only the preview, never the stored bytes.
 */

import { SAMPLE_RATE, toFloatChannels, type StoredSample } from "@noiseandmatter/dnx-core/sample/format.js";
import { resumeAudio, sharedAudioContext } from "./audiocontext.js";

/** A preview in progress. `stop` ends it early, and `ended` settles when it ends either way. */
export interface Preview {
  stop(): void;
  ended: Promise<void>;
}

/** Start a preview. Call from inside the click that asked for sound. */
export async function previewSample(sample: StoredSample): Promise<Preview | undefined> {
  if (!(await resumeAudio())) return undefined;
  const context = sharedAudioContext();
  const buffer = context.createBuffer(sample.channels, sample.frames, SAMPLE_RATE);
  toFloatChannels(sample).forEach((channel, c) => buffer.getChannelData(c).set(channel));
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const ended = new Promise<void>((resolve) => source.addEventListener("ended", () => resolve(), { once: true }));
  source.start();
  return { stop: () => source.stop(), ended };
}
