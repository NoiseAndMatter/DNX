/**
 * One image, filling the window, closed by a click or Escape.
 *
 * Nothing here knows about help. It was written inside the help view, which meant an image viewer
 * lived in a file about documentation and the next caller would have copied it — and the caller
 * after that would have had two that behaved differently.
 *
 * `isOpen` exists because a caller that also closes on Escape has to know something is above it.
 * Asking for a CSS class by name would make every such caller depend on this file's markup.
 */

let open: HTMLElement | undefined;

/** True while an image is enlarged. */
export function lightboxOpen(): boolean {
  return open !== undefined;
}

export function showImage(src: string, alt: string): void {
  if (open) return;

  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", alt);

  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  box.append(img);

  const close = (): void => {
    box.remove();
    document.removeEventListener("keydown", onKey);
    open = undefined;
  };
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  open = box;
}
