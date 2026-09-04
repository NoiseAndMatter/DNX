/**
 * Putting a chart on a page, and the one tooltip they all share.
 *
 * **The only module under `analysis/` that touches a document.** `charts.ts` and `model.ts` are
 * pure so they can be tested without a browser, which is exactly the split `selection.ts` was cut
 * out of `grid.ts` for; this is the other half, and it is deliberately tiny.
 */

import { TIP_SELECTOR } from "./charts.js";

/** How a chart is drawn: given the width it has, return the SVG for it. */
export type Draw = (width: number) => string;

/** Nothing narrower than this is worth drawing a chart into. */
const MIN_WIDTH = 360;

const widthOf = (el: HTMLElement) => Math.max(MIN_WIDTH, Math.floor(el.clientWidth));

/**
 * Render a chart at its container's real pixel width, and again whenever that changes.
 *
 * **This is why the type scale is trustworthy.** An SVG with a fixed viewBox scaled to fit its box
 * multiplies every font-size inside it by an arbitrary factor that moves with the window: a 10px
 * label became 12px on a 1600px screen and something else on a 1200px one, so the chart's type had
 * no fixed relationship to the page's. Matching the viewBox to the rendered width makes one unit
 * inside the SVG one CSS pixel.
 *
 * The width already drawn is remembered on the element, so the `ResizeObserver` firing at the same
 * width — which it does, on any layout change that does not resize this box — costs nothing.
 */
export function mount(el: HTMLElement, draw: Draw): void {
  const paint = () => {
    const w = widthOf(el);
    if (String(w) === el.dataset["w"]) return;
    el.dataset["w"] = String(w);
    el.innerHTML = draw(w);
  };
  paint();
  new ResizeObserver(paint).observe(el);
}

/**
 * Redraw a chart that is already mounted, at the width it already has.
 *
 * For a control change rather than a resize: the width has not moved, so `mount`'s own guard would
 * correctly decline to repaint. This clears the remembered width first, which is the difference
 * between "nothing changed" and "the same size, different content".
 */
export function repaint(el: HTMLElement, draw: Draw): void {
  const w = widthOf(el);
  el.innerHTML = draw(w);
  el.dataset["w"] = String(w);
}

/**
 * One tooltip for every chart on the page.
 *
 * Delegated from the document rather than bound per mark: a chart repaints by replacing its own
 * `innerHTML`, so listeners attached to the marks would be thrown away on every resize and every
 * control change. The document survives both.
 *
 * `innerHTML` is correct here and safe — see `tip()` in `charts.ts` for the escaping round trip
 * that makes it so.
 *
 * Returns a function that removes the listeners, for a page that tears its charts down.
 */
export function attachTooltip(tipEl: HTMLElement): () => void {
  const over = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.(TIP_SELECTOR) as HTMLElement | null;
    if (!el) return;
    tipEl.innerHTML = `<span class="t">${el.dataset["tipT"] ?? ""}</span>${el.dataset["tipB"] ?? ""}`;
    tipEl.classList.add("on");
  };
  const move = (e: PointerEvent) => {
    if (!tipEl.classList.contains("on")) return;
    // Kept inside the viewport on the right and never allowed above the top edge: a tooltip that
    // is off-screen is the same as no tooltip, and the marks near an edge are ordinary marks.
    tipEl.style.left =
      `${Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 6)}px`;
    tipEl.style.top = `${Math.max(6, e.clientY - tipEl.offsetHeight - 14)}px`;
  };
  const out = (e: PointerEvent) => {
    if ((e.target as Element | null)?.closest?.(TIP_SELECTOR)) tipEl.classList.remove("on");
  };
  document.addEventListener("pointerover", over);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerout", out);
  return () => {
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerout", out);
    tipEl.classList.remove("on");
  };
}
