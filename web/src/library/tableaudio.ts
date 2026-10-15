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
 *
 * ## The level is one knob for the page, not one per audition
 *
 * A gain node that outlives the sources, so turning it down stays turned down for the next table
 * and for the staged import's own Play. Set while a note is sounding it ramps rather than steps:
 * a gain written straight to `value` mid-note is a click, and a click in a tool for judging
 * waveforms is indistinguishable from a fault in the table.
 *
 * ## It says when it started, so a drawing can follow it
 *
 * `currentAudition` reports the clock the sound is on. The pane uses it to move the preview's
 * marker with a sweep, which is the only honest way to animate: the drawing follows the audio
 * rather than a timer started beside it that drifts.
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
let level: GainNode | undefined;
let volume = 0.8;
let sounding: Audition | undefined;

/** What is sounding, for a drawing that wants to follow it. */
export interface Audition {
  /** `AudioContext.currentTime` when it started. */
  startedAt: number;
  seconds: number;
  sweep: boolean;
  /** The held frame, for an audition that is not sweeping. */
  frame: number;
  waves: number;
}

/**
 * The output every audition goes through.
 *
 * Made on first use rather than at import: constructing it would build an `AudioContext` on a page
 * that may never play anything, and a context made without a gesture starts suspended anyway.
 */
function output(): GainNode {
  const audio = sharedAudioContext();
  if (!level) {
    level = audio.createGain();
    level.gain.value = volume;
    level.connect(audio.destination);
  }
  return level;
}

/** `0` to `1`. Ramped rather than stepped, so changing it mid-note does not click. */
export function setAuditionVolume(next: number): void {
  volume = Math.min(1, Math.max(0, next));
  if (!level) return;
  const audio = sharedAudioContext();
  level.gain.cancelScheduledValues(audio.currentTime);
  level.gain.setTargetAtTime(volume, audio.currentTime, 0.015);
}

export function auditionVolume(): number {
  return volume;
}

/**
 * How far through the audition is, `0` to `1`, or `undefined` when nothing is sounding.
 *
 * Read from the audio clock rather than from `Date.now()`: the two drift, and a marker that
 * finishes travelling before the sound does is worse than one that does not move at all.
 */
export function auditionProgress(): number | undefined {
  if (!sounding || !playing) return undefined;
  const elapsed = sharedAudioContext().currentTime - sounding.startedAt;
  return Math.min(1, Math.max(0, elapsed / sounding.seconds));
}

/** The frame sounding right now, fractional, or `undefined` when nothing is. */
export function auditionFrame(): number | undefined {
  const progress = auditionProgress();
  if (progress === undefined || !sounding) return undefined;
  if (!sounding.sweep) return sounding.frame;
  return progress * (sounding.waves - 1);
}

/** What is sounding, or `undefined`. */
export function currentAudition(): Audition | undefined {
  return playing ? sounding : undefined;
}

/** Stop the current audition. Safe when nothing is playing. */
export function stopAudition(): void {
  if (!playing) return;
  const source = playing;
  playing = undefined;
  sounding = undefined;
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
  source.connect(output());
  source.onended = () => {
    if (playing === source) {
      playing = undefined;
      sounding = undefined;
    }
    source.disconnect();
    onEnded?.();
  };

  playing = source;
  sounding = {
    startedAt: audio.currentTime,
    seconds: rendered.length / audio.sampleRate,
    sweep,
    frame: options.frame ?? 0,
    waves: table.waves,
  };
  source.start();
  return true;
}
