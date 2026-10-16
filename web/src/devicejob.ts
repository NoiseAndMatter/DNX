/**
 * Which job holds the instrument on this page, so that only one does.
 *
 * **The +Drive takes one conversation at a time.** A backup reading 1,800 files, an erase
 * copying tables, and the library writing a pool each open, read and close files in sequence. Two
 * of them interleaved on one port stalled a write partway on 2026-09-21, and nothing stopped it
 * happening again: Settings guarded only its own two buttons, and only for the sheet it drew, so
 * closing and reopening the sheet re-enabled them while the first job was still running.
 *
 * So the claim lives here, once per page, and every job that talks to the +Drive for more than a
 * single exchange takes it. A job that cannot take it is told who holds it.
 *
 * DOM-free, so a test can reach it.
 */

let holder: string | undefined;
const listeners = new Set<() => void>();

/** What holds the instrument now, as a sentence's subject ("A backup"), or undefined. */
export function deviceJob(): string | undefined {
  return holder;
}

/**
 * Take the instrument for `what`. Returns the release, or undefined when another job holds it.
 *
 * The release is idempotent and releases only this claim.
 */
export function claimDevice(what: string): (() => void) | undefined {
  if (holder !== undefined) return undefined;
  holder = what;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holder = undefined;
    notify();
  };
}

/** The sentence a refused job shows. */
export function deviceJobRefusal(): string {
  return `${holder ?? "Another job"} is using the instrument. Try again when it finishes.`;
}

/** Called whenever the holder changes. Returns the unsubscribe. */
export function onDeviceJobChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}
