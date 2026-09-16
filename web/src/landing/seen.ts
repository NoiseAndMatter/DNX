/**
 * Has DNX been opened on this browser before, and does the reader want the boot screen at all.
 *
 * Two questions, one module, because the landing page and the settings sheet both ask and the
 * sheet must not import the page.
 *
 * ## The first run is the long one
 *
 * The owner's decision: **7,000 ms the very first time the app is ever opened, 3,500 ms after
 * that.** "The very first time" is defined as *no data about a previous run can be found* — which
 * is the same question first-run setup asks before offering the DNX folder, so one check answers
 * both and the two cannot disagree.
 *
 * **A cleared browser is a first run again, and that is correct.** Somebody who has wiped their
 * site data has also lost the folder they chose, so they need the setup step as much as a new
 * arrival does. Storage that says nothing is not the same as storage that says "seen it".
 */

/** Written the first time the boot screen finishes. Absent means nobody has been here. */
export const SEEN_KEY = "dnx-seen";

/** Written when the reader asks not to see the boot screen. Absent means show it. */
export const SKIP_KEY = "dnx-skip-boot";

/** How long the reveal runs when nothing here has been seen before. */
export const FIRST_RUN_MS = 7_000;

/** How long it runs on every later visit. */
export const RETURN_MS = 3_500;

/** True when no previous run left anything behind. */
export function isFirstRun(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === null;
  } catch {
    /*
     * Private window, or site data off. **Treated as a first run**, which means the long reveal
     * and the folder offer — the two things somebody with no stored state actually needs. The
     * alternative, assuming they have been here, hides the setup from the one reader who has
     * nothing set up.
     */
    return true;
  }
}

/** How long the reveal should run, in milliseconds. */
export function bootDurationMs(): number {
  return isFirstRun() ? FIRST_RUN_MS : RETURN_MS;
}

/** Remember that somebody has been here. */
export function rememberSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    // Then every visit is a first visit. The page still works; it is just longer than it needs.
  }
}

/** True when the reader has asked to go straight to the tools. */
export function readSkipBoot(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSkipBoot(skip: boolean): void {
  try {
    if (skip) localStorage.setItem(SKIP_KEY, "true");
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    // The choice applies to this page and does not outlive it. Saying so would be noise about a
    // browser setting the reader already made.
  }
}
