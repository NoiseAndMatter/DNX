/**
 * Whether this browser can run DNX, and what to say when it cannot.
 *
 * **The owner's decision, 2026-09-16: Chromium only for now, and say so rather than let somebody
 * discover it a feature at a time.**
 *
 * ## Why, concretely
 *
 * Two things DNX is built on are not evenly implemented:
 *
 * - **Web MIDI with SysEx.** Every instrument conversation is SysEx. Firefox has no Web MIDI at
 *   all and Safari has none either, so on those two DNX cannot see an instrument, which is most
 *   of what it does.
 * - **The File System Access API.** The DNX folder needs `showDirectoryPicker`, which is Chromium
 *   only. Without it every file becomes a download.
 *
 * A page that half works is worse than a page that says what it needs: somebody would get as far
 * as connecting an instrument before finding out.
 *
 * ## Feature detection, not the user agent string
 *
 * The user agent lies by design and has for twenty years. **What DNX needs is what DNX asks
 * for**: does this browser have `requestMIDIAccess`. A Chromium fork that has it passes, and a
 * browser that claims to be Chrome and has not, correctly fails.
 */

/** What the two APIs DNX is built on say about this browser. */
export interface BrowserSupport {
  /** Web MIDI, which every instrument conversation needs. */
  midi: boolean;
  /** The directory picker, which the DNX folder needs. */
  folder: boolean;
  /** False when DNX cannot do its main job here. */
  usable: boolean;
}

export function browserSupport(nav: Navigator = navigator, win: Window = window): BrowserSupport {
  const midi = typeof (nav as { requestMIDIAccess?: unknown }).requestMIDIAccess === "function";
  const folder = "showDirectoryPicker" in win;
  // **MIDI is the one that decides.** Without the folder, files download and DNX still works;
  // without MIDI there is no instrument, and three of the four tools have nothing to talk to.
  return { midi, folder, usable: midi };
}

/** What to tell somebody whose browser cannot run this. Empty when it can. */
export function unsupportedMessage(support: BrowserSupport): string {
  if (support.usable) return "";
  return (
    "DNX needs a Chromium browser — Chrome, Edge, Brave, Arc or another. This one has no Web MIDI, " +
    "so it cannot see a Digitone at all. Firefox and Safari do not implement it."
  );
}

/** The narrower note for a browser that has MIDI but cannot keep a folder. Empty when it can. */
export function folderNote(support: BrowserSupport): string {
  if (!support.usable || support.folder) return "";
  return "Files will go to your downloads: this browser has no directory picker.";
}
