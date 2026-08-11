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
 * ## Motion: the system decides, unless you have said otherwise
 *
 * `prefers-reduced-motion` is honoured by default, and that is the right default — an operating
 * system asking applications not to animate is answering for someone who may have a reason. But it
 * is a *default*, not a verdict, and it was silently costing this app its navigation animation for
 * a user who wanted it. Windows ships **Animation effects** off often enough that "no slide, ever,
 * and nothing says why" is a poor way to express a preference nobody set deliberately.
 *
 * So: `localStorage["dnx-motion"]` outranks the system when it is set.
 *
 * | value | meaning |
 * |---|---|
 * | `always` | animate, whatever the system says |
 * | `never` | do not animate, whatever the system says |
 * | `system` or unset | follow `prefers-reduced-motion` — the default |
 *
 * Settable from the URL — `?motion=always` — because there is no settings surface yet and a
 * preference you can only change from a console is not a preference anybody has. The parameter is
 * stored and then **removed from the address bar**, so it configures rather than decorating every
 * link thereafter.
 *
 * ## Why the preference logic lives in this file
 *
 * It is a second responsibility and it would rather be its own module. It cannot be: a classic
 * script cannot `import`, and this must stay classic to run before paint. Duplicating it into a
 * second `<script>` tag would be two files that have to agree — the exact failure this row has
 * already had three times. One file, and the constraint written down.
 *
 * ## It cannot break the page
 *
 * If storage throws, if nothing was stored, or if the value is not one of the two directions,
 * nothing is stamped and the page is exactly as it was. The offset is also released
 * unconditionally by a timer in `toolnav.ts`, so a module that never runs cannot leave the page
 * permanently pushed off-screen. An animation must not be able to break the thing it decorates.
 */

(function () {
  "use strict";

  var DIRECTION_KEY = "dnx-nav-direction";
  var MOTION_KEY = "dnx-motion";

  /** `?motion=always` sets the preference, then leaves the address bar as it found it. */
  function adoptFromUrl() {
    var wanted;
    try {
      wanted = new URLSearchParams(location.search).get("motion");
    } catch (error) {
      return;
    }
    if (wanted !== "always" && wanted !== "never" && wanted !== "system") return;

    try {
      localStorage.setItem(MOTION_KEY, wanted);
    } catch (error) {
      // Storage refused. The parameter still applies to this page load, below.
    }
    try {
      var url = new URL(location.href);
      url.searchParams.delete("motion");
      history.replaceState(null, "", url.toString());
    } catch (error) {
      // Leaving it in the address bar is untidy, not broken.
    }
    return wanted;
  }

  /** True when this page load should animate. */
  function shouldAnimate(fromUrl) {
    var setting = fromUrl;
    if (!setting) {
      try {
        setting = localStorage.getItem(MOTION_KEY);
      } catch (error) {
        setting = null;
      }
    }
    if (setting === "always") return true;
    if (setting === "never") return false;

    try {
      return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (error) {
      return false;
    }
  }

  var fromUrl = adoptFromUrl();
  if (!shouldAnimate(fromUrl)) return;

  var direction = null;
  try {
    direction = sessionStorage.getItem(DIRECTION_KEY);
  } catch (error) {
    // Private mode, or storage disabled. The page still navigates; it simply arrives without the
    // slide, which is a missing flourish rather than a missing feature.
    return;
  }
  if (direction !== "left" && direction !== "right") return;

  document.documentElement.classList.add(
    direction === "right" ? "slide-from-right" : "slide-from-left",
  );
})();
