/*
 * The only script on the page that is not a module — which is the entire point of it.
 *
 * ## What goes wrong without this
 *
 * Every page here is a `<script type="module">`. Modules fail in two ways that leave the page
 * looking *fine* and doing *nothing*:
 *
 * 1. **Opened over `file://`.** Chrome refuses to load a module from a file URL — it is a
 *    cross-origin request to a null origin — so not one listener is ever bound. Buttons click, file
 *    pickers open and choose, and nothing responds. That has now been reported twice as
 *    "doesn't load the file", and both times the page was never running.
 * 2. **A throw at module top level.** Everything below it goes unbound, so half the page works and
 *    half is inert. `app.ts` carries a note about this; it has been paid for before.
 *
 * In both cases the browser writes to a console nobody has open, and the page says nothing.
 *
 * ## Why a classic script
 *
 * A module cannot report that modules are broken. This one is parsed and run by any browser, from
 * any origin, before the module is even fetched — so it is still standing when the module is not.
 * It touches no page-specific ids and adds nothing to the DOM unless something is wrong.
 */

(function () {
  "use strict";

  var STYLE =
    "position:fixed;left:0;right:0;top:0;z-index:9999;padding:.8rem 1rem;" +
    "background:#3a1d1d;color:#ffd9d4;border-bottom:2px solid #cf6f62;" +
    'font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif';

  function shout(title, detail) {
    function show() {
      if (document.getElementById("boot-error")) return;
      var bar = document.createElement("div");
      bar.id = "boot-error";
      bar.setAttribute("style", STYLE);
      bar.innerHTML =
        "<strong>" + title + "</strong><br>" + detail;
      document.body.insertBefore(bar, document.body.firstChild);
    }
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show);
  }

  // **The one failure that can be predicted rather than caught.** Chrome will not load a module
  // over file://, so there is no error to listen for — the page simply never starts. Said up front,
  // because by the time anyone notices, the symptom is a control that does nothing.
  if (location.protocol === "file:") {
    shout(
      "This page is open from a file, so none of it will work.",
      "Browsers refuse to load JavaScript modules over <code>file://</code>, so every button on " +
        "this page is inert — it is not broken, it was never started. Run <code>npm run web</code> " +
        "in the DNX folder and open the address it prints.",
    );
    return;
  }

  // A module that throws while loading takes every listener below it with it. The browser reports
  // that as an `error` event on the window, which is the only place it is visible without a console.
  window.addEventListener("error", function (event) {
    var where = event.filename ? event.filename.split("/").pop() : "the page";
    shout(
      "This page did not finish loading, so some controls will do nothing.",
      "<code>" +
        String(event.message || "script error") +
        "</code> in <code>" +
        where +
        (event.lineno ? ":" + event.lineno : "") +
        "</code>. Reload after fixing it; until then, anything wired after that point is inert.",
    );
  });
})();
