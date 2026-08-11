/*
 * The arriving page starts offset — and this has to happen **before the first paint**.
 *
 * ## Why this is not in `toolnav.ts` with the rest of the slide
 *
 * It was, and that is why the slide never appeared. Every page's logic is a
 * `<script type="module">`, and module scripts are *always* deferred: they run after the document
 * is parsed, and the browser is free to have painted before that. So `toolnav.ts` was adding the
 * offset to a page the browser had already drawn at rest — either too late to see, or visible as a
 * jump 3.5rem sideways followed by a slide back, which is a glitch rather than a flourish.
 *
 * A classic script in `<head>` is the only thing that runs early enough. It is parsed and executed
 * synchronously, before the body exists and before anything is painted, so the very first frame the
 * browser draws is already offset. `toolnav.ts` keeps the other half: it releases the offset, which
 * is the part that has to happen after the DOM is there.
 *
 * Splitting one animation across two files is not ideal and is not a choice — one half must run
 * before paint and the other after the body exists. The division is at least honest: **this file
 * says where the page arrives from, `toolnav.ts` says that it settles.**
 *
 * ## Why the class goes on `<html>`
 *
 * `document.body` does not exist yet. `documentElement` always does, so the state is stamped there
 * and `toolnav.css` reaches the body through it.
 *
 * ## It cannot break the page
 *
 * If `sessionStorage` throws, if nothing was stored, or if the value is not one of the two
 * directions, nothing is stamped and the page is exactly as it was. The offset is also released
 * unconditionally by a timer in `toolnav.ts`, so a module that never runs cannot leave the page
 * permanently pushed off-screen. An animation must not be able to break the thing it decorates.
 */

(function () {
  "use strict";

  var KEY = "dnx-nav-direction";
  var direction = null;

  try {
    direction = sessionStorage.getItem(KEY);
  } catch (error) {
    // Private mode, or storage disabled. The page still navigates; it simply arrives without the
    // slide, which is a missing flourish rather than a missing feature.
    return;
  }
  if (direction !== "left" && direction !== "right") return;

  // Asked here rather than in the module, because by the time the module runs the offset would
  // already have been painted — and honouring the preference has to mean never showing it at all.
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (error) {
    return;
  }

  document.documentElement.classList.add(
    direction === "right" ? "slide-from-right" : "slide-from-left",
  );
})();
