/**
 * The one `AudioContext` this application opens.
 *
 * **One job, and it exists because two would be a bug.** Browsers cap how many audio contexts a
 * page may hold, and a page that opens one per audition stops making any sound after a few dozen
 * clicks, silently and only for the person who clicked a lot. Decoding a file and auditioning a
 * table both need a context, so neither owns it.
 *
 * ## It starts suspended, and that is not an error
 *
 * A context created outside a user gesture begins `suspended` and produces silence until it is
 * resumed from inside one. `resumeAudio` is therefore called from the click handler that wants
 * sound, not at module load, and it is safe to call when the context is already running.
 *
 * The rate is the browser's own rather than a number we pick. Asking for a rate the output device
 * does not have makes the browser resample everything we render, which is the one thing worth
 * avoiding in a tool whose whole job is to be exact about sample counts.
 */

let context: AudioContext | undefined;

/** The shared context, created on first use. */
export function sharedAudioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

/**
 * Resume the context if the browser has it suspended.
 *
 * Call from inside the click that wants sound. Resolves either way: a context that cannot be
 * resumed is a thing to report where the sound was expected, not an exception to throw here.
 */
export async function resumeAudio(): Promise<boolean> {
  const audio = sharedAudioContext();
  if (isRunning(audio)) return true;
  try {
    await audio.resume();
  } catch {
    return false;
  }
  return isRunning(audio);
}

/**
 * Whether the context is running, asked about the context rather than about its `state`.
 *
 * Testing `audio.state` inline would narrow that property for the rest of `resumeAudio`, so the
 * second check is rejected as a comparison that can never hold: the compiler has no way to know
 * that `resume` is precisely what changes it. Passing the context keeps the narrowing inside here,
 * where there is nothing after it to spoil, and needs no cast to say so.
 */
function isRunning(audio: AudioContext): boolean {
  return audio.state === "running";
}
