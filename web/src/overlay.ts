/**
 * An overlay: something over the page, closed by Escape, a click outside, or its own button.
 *
 * ## Why this exists
 *
 * The settings sheet and the help view both need the same five things — a scrim, a panel, Escape to
 * close, a click outside to close, and focus returned to whatever opened it. Written twice they
 * were already drifting: one restored focus and the other was about to forget to, and the fifth
 * thing anyone adds an overlay for would have been a third copy.
 *
 * **Focus return is the part that gets dropped.** It is invisible when it works and only noticed as
 * "the next Tab went somewhere strange", which nobody reports as a bug.
 *
 * ## What it does not do
 *
 * It does not know what is inside it. A caller builds its own panel and hands it over, so this file
 * has no opinion about settings or help and never grows one.
 */

export interface Overlay {
  /** The panel a caller filled. Kept so a caller can re-render in place. */
  readonly panel: HTMLElement;
  close(): void;
  readonly open: boolean;
}

export interface OverlayOptions {
  /** Goes on the panel, e.g. `sheet` or `help-panel`. */
  className: string;
  /** Announced to a screen reader as the overlay's name. */
  label: string;
  /** `sheet-scrim` and `help-scrim` are styled differently; both dim the page. */
  scrimClassName?: string;
  /** Returned to when the overlay closes. */
  opener?: HTMLElement;
  /**
   * Escape and outside clicks are ignored while this returns true.
   *
   * For an overlay that opens something of its own on top, such as an enlarged screenshot: the
   * first Escape should close that, not the whole thing.
   */
  isBlocked?: () => boolean;
}

export function openOverlay(options: OverlayOptions): Overlay {
  const scrim = document.createElement("div");
  scrim.className = options.scrimClassName ?? "sheet-scrim";

  const panel = document.createElement("aside");
  panel.className = options.className;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", options.label);

  let open = true;

  const close = (): void => {
    if (!open) return;
    open = false;
    document.removeEventListener("keydown", onKey);
    panel.remove();
    scrim.remove();
    // Focus goes back where it came from. Dropping it to the document start makes the next Tab feel
    // like a different page.
    options.opener?.focus();
  };

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (options.isBlocked?.()) return;
    close();
  }

  scrim.addEventListener("click", () => { if (!options.isBlocked?.()) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(scrim, panel);

  return { panel, close, get open() { return open; } };
}
