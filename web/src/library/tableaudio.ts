/**
 * Auditioning a table through the speakers.
 *
 * **One job: push what `renderTable` produced at the output, and stop whatever was playing.** The
 * arithmetic that decides what the table sounds like is `waverider/oscillator.ts`, in core, where a
 * test can check it against an analytic sine without a browser. This is the twenty lines of Web
 * Audio that cannot be tested that way, kept apart so that is all they are.
 *
 * ## One audition at a time
 *
 * Clicking Play on a second table while the first is still sounding has to stop the first, not
 * layer onto it. Two tables at once is not a comparison, it is a chord, and the whole point of the
 * control is hearing one table clearly. The current source is held here and stopped on the way in.
 *
 * ## The rendered buffer is played once, not looped
 *
 * A loop would need the fade removed to join seamlessly, and without the fade the buffer clicks at
 * each wrap. An audition is a second or two of sound to answer "did that import come out right",
 * so playing it once and letting it end is both simpler and what the control implies.
 */

import { resumeAudio, sharedAudioContext } from "../audiocontext.js";
import { renderTable, type TableSamples } from "@noiseandmatter/dnx-core/waverider/oscillator.js";

/** What to play, and how. */
export interface AuditionOptions {
  /** Hertz. Middle C by default, which is where a wavetable's character reads most clearly. */
  frequency?: number;
  /** Seconds. A sweep gets longer by default, because it has further to travel. */
  seconds?: number;
  /** Which frame to hold, zero-based and fractional. Ignored when sweeping. */
  frame?: number;
  /** Travel from the first frame to the last over the whole audition. */
  sweep?: boolean;
}

const MIDDLE_C = 261.63;
const HELD_SECONDS = 1.4;
const SWEPT_SECONDS = 3;

let playing: AudioBufferSourceNode | undefined;

/** Whether an audition is sounding right now, so a pane can show Play or Stop. */
export function isAuditioning(): boolean {
  return playing !== undefined;
}

/** Stop the current audition. Safe when nothing is playing. */
export function stopAudition(): void {
  if (!playing) return;
  const source = playing;
  playing = undefined;
  // `onended` has already been cleared by the assignment above, so this does not re-enter.
  source.onended = null;
  try {
    source.stop();
  } catch {
    // A source that has already ended throws on stop. Nothing to do about it and nothing to say.
  }
  source.disconnect();
}

/**
 * Play `table`, stopping anything already playing.
 *
 * Resolves when the sound has been started, not when it has finished: the caller is a click
 * handler and the pane stays usable while the note sounds. Returns `false` when the browser would
 * not give us a running audio context, which is a thing to say on screen rather than to throw.
 *
 * `onEnded` is called when the audition finishes on its own or is stopped, so a Play/Stop button
 * can go back to Play without polling.
 */
export async function auditionTable(
  table: TableSamples,
  options: AuditionOptions = {},
  onEnded?: () => void,
): Promise<boolean> {
  stopAudition();

  if (!(await resumeAudio())) return false;
  const audio = sharedAudioContext();
  const sweep = options.sweep === true;

  const rendered = renderTable(table, {
    sampleRate: audio.sampleRate,
    frequency: options.frequency ?? MIDDLE_C,
    seconds: options.seconds ?? (sweep ? SWEPT_SECONDS : HELD_SECONDS),
    frame: options.frame,
    sweep,
  });

  const buffer = audio.createBuffer(1, rendered.length, audio.sampleRate);
  // `set` on the channel rather than `copyToChannel`, whose signature wants a `Float32Array` over a
  // plain `ArrayBuffer` and rejects one whose buffer type is merely `ArrayBufferLike`.
  buffer.getChannelData(0).set(rendered);

  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.onended = () => {
    if (playing === source) playing = undefined;
    source.disconnect();
    onEnded?.();
  };

  playing = source;
  source.start();
  return true;
}
