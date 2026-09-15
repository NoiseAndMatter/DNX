/**
 * Whether the tool row shows the probe.
 *
 * The probe is for asking an instrument questions when something is wrong, and most people never
 * need it, so it stays out of the row until someone turns Settings → Hide the probe off. The owner
 * asked for it on 2026-09-15, ticked by default.
 *
 * **A page that is the probe always shows its own link**, so nobody is left on a page the row does
 * not name. Hiding it takes the last position off the row, so no other tool moves.
 *
 * A module of its own because the settings sheet and the tool row both read it, and the sheet must
 * not import the row, which imports the sheet.
 */

/** Stored only when the probe is shown. Absent, or anything but "false", means hidden. */
export const HIDE_PROBE_KEY = "dnx-hide-probe";

/** Fired on `window` when a preference that changes the page has changed. */
export const PREFERENCES_CHANGED = "dnx-preferences-changed";

export function readHideProbe(): boolean {
  try {
    return localStorage.getItem(HIDE_PROBE_KEY) !== "false";
  } catch {
    // Private mode, or storage disabled: the default, which is hidden.
    return true;
  }
}

export function writeHideProbe(hide: boolean): void {
  try {
    if (hide) localStorage.removeItem(HIDE_PROBE_KEY);
    else localStorage.setItem(HIDE_PROBE_KEY, "false");
  } catch {
    // The row still follows the switch for this page; the choice just does not outlive it.
  }
  announcePreferencesChanged();
}

export function announcePreferencesChanged(): void {
  window.dispatchEvent(new Event(PREFERENCES_CHANGED));
}
