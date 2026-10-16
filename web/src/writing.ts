/**
 * Whether a write to the instrument is under way on this page, and the guard that follows from it.
 *
 * **Leaving the page stops a write between two requests.** The tools are four documents, so a tool
 * link, `Ctrl`+`Alt`+arrow, a reload or a closed tab all unload the page, and the conversation
 * with the +Drive ends wherever it was. The backup taken first makes that recoverable, but the
 * instrument is left half-written until somebody restores it.
 *
 * So every write runs inside `whileWriting`, and while one does the page asks the browser to
 * confirm before it unloads. The browser shows its own question; a page cannot word it.
 *
 * A counter rather than a flag, because the settings erase and a tool's own write are separate
 * callers and either may finish first. Reads are not counted: a read stopped partway changes
 * nothing on the instrument.
 *
 * DOM-guarded, so a test can reach it.
 */

let writes = 0;

const hasWindow = typeof window !== "undefined";

function holdPage(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Still the only form some browsers act on.
  event.returnValue = "";
}

/** Whether a write is running now. */
export function isWriting(): boolean {
  return writes > 0;
}

/** Run `write`, holding the page until it settles, whether it resolves or throws. */
export async function whileWriting<T>(write: () => Promise<T>): Promise<T> {
  if (writes++ === 0 && hasWindow) window.addEventListener("beforeunload", holdPage);
  try {
    return await write();
  } finally {
    if (--writes === 0 && hasWindow) window.removeEventListener("beforeunload", holdPage);
  }
}
