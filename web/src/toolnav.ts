import { SOURCE_URL, renderSettingsLink } from "./settings.js";
import { installOtherTrafficWarning } from "./othertraffic.js";
import { renderHelpLink } from "./helpview.js";
import { renderReportLink } from "./reportissue.js";
import { installHelpMarkers } from "./helpmarker.js";
import { renderWriteEnable } from "./writeenable.js";
import { PREFERENCES_CHANGED, readHideProbe } from "./probevisibility.js";

/**
 * The tool titles, which are also the navigation between tools.
 *
 * ## The row never reorders
 *
 * Expander, manager, library, probe — always in that order, on every page. Settled by the user against a
 * most-recently-used ordering, which was the first sketch and is worse: MRU turns the row into a
 * history stack, so going back and forth between two tools swaps positions 2 and 3 every time and
 * the thing you just clicked is no longer where it was. A fixed row makes each tool a permanent
 * screen position, and therefore muscle memory, which is worth more than expressing recency.
 *
 * So **none of the motion is in the titles**. The highlight moves, nothing reflows, and the page
 * itself slides.
 *
 * **The probe is hidden by default** (Settings → Hide the probe, asked for 2026-09-15). It is the last
 * position, so hiding it moves no other tool, and the shortcuts count only the tools that are shown.
 *
 * ## Why the slide is on arrival only
 *
 * These are three separate documents, so a two-sided carousel means animating the old page out and
 * the new one in. Animating the departure means holding navigation until a transition finishes, and
 * a page left mid-transform when that goes wrong — a blocked navigation, a back-button restore out
 * of the bfcache — looks broken in a way no user can fix.
 *
 * The browser already shows the old page until the new one paints, so animating the arrival alone
 * produces exactly the lateral displacement that was asked for, and cannot strand anything. The
 * direction survives the navigation in `sessionStorage`, which is the only state that has to.
 *
 * ## The shortcut, and the one conflict that is not obvious
 *
 * `Ctrl`+`Alt`+`←` / `→` for previous and next: free in Chrome and Edge, where `Ctrl`+digit and
 * `Ctrl`+`Tab` belong to the browser's own tabs and `Alt`+arrow is history. The arrows match the
 * direction the page moves, so the shortcut and the animation say the same thing.
 *
 * **`Ctrl`+`Alt` is AltGr on Windows.** On a Spanish, German or UK-extended layout `AltGr`+`2` types
 * `@` and `AltGr`+`1` types `|` — so the digit shortcuts collide with ordinary typing, and this page
 * is full of text fields. They are therefore **ignored while an editable element has focus**, which
 * costs nothing (nobody navigates while naming a project) and keeps typing an `@` from also
 * changing tools. The arrows need no such guard: `AltGr`+arrow types nothing on any layout.
 */

/**
 * Fixed order. Changing it changes where every tool lives on screen, so it changes muscle memory.
 *
 * `library` sits third, before `probe`: the first three are tools for making music with, and the
 * probe is the one you open when something is wrong. Appending it to the end would have been less
 * disruptive to anyone's habits — but it would put an instrument-debugging tool in the middle of the
 * musical ones, and the row is meant to read as an order of work.
 */
export const TOOLS = [
  { id: "expander", href: "expander.html", label: "expander" },
  { id: "manager", href: "manager.html", label: "manager" },
  { id: "library", href: "library.html", label: "library" },
  { id: "probe", href: "probe.html", label: "probe" },
] as const;

export type ToolId = (typeof TOOLS)[number]["id"];

/**
 * What page the row is being drawn on.
 *
 * `"landing"` is the site root, which is **not a tool** — it is where the tools are listed. The row
 * still appears there so a reader can go straight on, with nothing marked as the current page and
 * no arrow or digit counted from it. Everything below compares against `current` by equality, so a
 * value that matches no tool falls out correctly: `visibleTools` shows the ordinary set,
 * `findIndex` gives `-1`, and `stepFrom(-1, 1)` lands on the first tool, which is where somebody
 * pressing right from the front page should go.
 */
export type PageId = ToolId | "landing";

/**
 * Where the row is now, or a thrown error naming what it was asked about.
 *
 * **A silent `-1` here is indistinguishable from wrapping.** `findIndex` returns it for an id that
 * is not in the row, and `-1 + 1` is `0` — so "next" from an unknown position lands on the leftmost
 * tool, which looks exactly like the row cycling round. Every id is written in the same repository
 * as the row, so an unknown one is a bug to fix rather than a case to handle.
 */
export function indexOfTool(tool: ToolId): number {
  const at = TOOLS.findIndex((t) => t.id === tool);
  if (at === -1) {
    throw new Error(`${tool} is not one of ${TOOLS.map((t) => t.id).join(", ")}`);
  }
  return at;
}

/**
 * The tool one step along, or `undefined` at either end.
 *
 * **The row does not wrap**, and this is where that is decided. A "next" that jumps from the last
 * tool back to the first is how you end up on the probe when you meant to leave the expander — and
 * because the row is three fixed positions, the end of it is a place you can feel rather than a
 * thing you have to read.
 *
 * Pure and exported so the rule is actually tested: it was previously three lines inside a keydown
 * listener, where nothing could reach it.
 */
export function stepFrom(at: number, direction: 1 | -1, length: number = TOOLS.length): number | undefined {
  const to = at + direction;
  return to < 0 || to >= length ? undefined : to;
}

/**
 * The tools the row shows, in the row's fixed order.
 *
 * The probe only when it is not hidden, **or when it is the page you are on**: a row that does not
 * name the page it sits on is a row you cannot find your way back through.
 */
export function visibleTools(current: PageId, hideProbe: boolean): (typeof TOOLS)[number][] {
  return TOOLS.filter((tool) => tool.id !== "probe" || !hideProbe || current === "probe");
}

/** Where the arriving page should slide in from. Set on the way out, read and cleared on arrival. */
const DIRECTION_KEY = "dnx-nav-direction";

/**
 * How long the arrival slide takes.
 *
 * "Smooth but snappy" — long enough to read as movement, short enough that a tool you use fifty
 * times a day never makes you wait for it.
 */
const SLIDE_MS = 220;

/**
 * Draw the tool row into a container and wire the shortcuts.
 *
 * The markup is built here rather than written into three HTML files, so the row cannot say
 * different things on different pages — which is the failure this project has already had with
 * `escapeHtml` and with the grid.
 */
export function renderToolNav(container: HTMLElement, current: PageId): void {
  const nav = document.createElement("nav");
  nav.className = "toolnav";
  nav.setAttribute("aria-label", "Tools");

  const links: HTMLAnchorElement[] = [];
  TOOLS.forEach((tool) => {
    const link = document.createElement("a");
    link.className = "tool";
    link.href = tool.href;
    link.textContent = tool.label;
    link.dataset["tool"] = tool.id;
    if (tool.id === current) {
      // `aria-current` rather than a class alone: the highlight is a statement about where you are,
      // and a screen reader has as much right to it as the stylesheet.
      link.setAttribute("aria-current", "page");
    }
    link.addEventListener("click", (event) => {
      // Left-click only, and never when a modifier says "open this somewhere else" — stealing
      // ctrl-click from a link is one of the rudest things a page can do.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      goTo(tool.id, current);
    });
    links.push(link);
    nav.append(link);
  });

  // Which tools show, and the shortcut each tooltip names, follow the settings sheet as it changes.
  const showTools = (): void => {
    const shown = visibleTools(current, readHideProbe());
    for (const link of links) {
      const at = shown.findIndex((tool) => tool.id === link.dataset["tool"]);
      link.hidden = at === -1;
      const label = link.textContent ?? "";
      const name = `${label[0]!.toUpperCase()}${label.slice(1)}`;
      // Discoverable, because a shortcut nobody can find is a shortcut nobody uses. A hidden tool has
      // no shortcut, so its title does not claim one.
      link.title = at === -1 ? name : `${name} — Ctrl+Alt+${at + 1}`;
    }
  };
  showTools();
  window.addEventListener(PREFERENCES_CHANGED, showTools);

  /*
   * **Before the source link and after the tools**, because it is the only control in this row that
   * changes what the application will do. It is on every page for the same reason the row is: a
   * person must be able to see whether writing is armed without remembering which tool they armed
   * it in.
   */
  renderWriteEnable(nav);
  renderHelpLink(nav, current);
  renderSettingsLink(nav);
  // Beside help and settings, because a problem is reported from wherever it was met and the tool
  // it was met in is what tags the issue.
  renderReportLink(nav, current);
  nav.append(sourceLink());
  container.append(nav);
  /*
   * Every page mounts the tool row, so a `?` is one attribute in the markup and never a second call
   * somebody has to remember. A page that builds controls later calls `installHelpMarkers` again.
   */
  installHelpMarkers();
  /*
   * **Here, because every page mounts this row.** The warning is about the MIDI port, which is a
   * property of the page rather than of the tool on it, and wiring it per page would mean the one
   * page somebody forgot is the one running the read that Transfer truncates.
   */
  installOtherTrafficWarning(container);
  wireShortcuts(current);
  slideIn();
}

/**
 * Where to get the source, on every page.
 *
 * **This is a licence term, not a courtesy.** DNX is AGPL-3.0, and section 13 says that anyone
 * interacting with the program remotely must be offered the source of the version they are using.
 * A page served from GitHub Pages is exactly that case: nothing is ever distributed as a file, so
 * the offer has to be in the interface or it is nowhere.
 *
 * It lives in the tool row rather than in a footer because three of the four pages fill the
 * viewport and grow downwards, so a footer is a place a user reaches by accident or not at all.
 */


function sourceLink(): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "source";
  link.href = SOURCE_URL;
  link.textContent = "source";
  link.rel = "noopener";
  link.target = "_blank";
  link.title = "DNX is free software under the AGPL-3.0. Read, fork and modify it.";
  return link;
}

/** Navigate to a tool, remembering which way the page should appear to move. */
function goTo(tool: ToolId, current: PageId): void {
  // From the landing page every tool is to the right, because the landing page is before them all.
  const from = current === "landing" ? -1 : indexOfTool(current);
  const to = indexOfTool(tool);
  if (to === from) return;
  try {
    sessionStorage.setItem(DIRECTION_KEY, to > from ? "right" : "left");
  } catch {
    // Private mode, or storage disabled. The page still navigates; it simply arrives without the
    // slide, which is a missing flourish rather than a missing feature.
  }
  location.href = TOOLS[to]!.href;
}

function wireShortcuts(current: PageId): void {
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;

    // Counted over the tools the row shows now, so a hidden probe is neither Ctrl+Alt+4 nor the step
    // to the right of the library.
    const shown = visibleTools(current, readHideProbe());
    const at = shown.findIndex((tool) => tool.id === current);

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const to = stepFrom(at, event.key === "ArrowRight" ? 1 : -1, shown.length);
      // **Swallowed at the ends, not passed on.** Reported as wrapping from the hardware, and
      // whatever the cause, a modified arrow that reaches the browser from the last tool is one the
      // page has decided not to act on — so it should not act anywhere else either.
      event.preventDefault();
      if (to === undefined) return;
      goTo(shown[to]!.id, current);
      return;
    }

    // See the note above: Ctrl+Alt is AltGr, and on several layouts these digits are how you type
    // `@` and `|`. Typing wins wherever typing is what is happening.
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > shown.length) return;
    if (isEditable(event.target)) return;
    event.preventDefault();
    goTo(shown[digit - 1]!.id, current);
  });
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Release the offset `arrival.js` applied, so the page settles into place.
 *
 * **Only the second half of the slide lives here.** The first half — arriving offset — has to
 * happen before the browser's first paint, and a module script cannot: modules are deferred, so
 * this code runs after the page may already have been drawn at rest. That is why the slide never
 * appeared, and why `arrival.js` is a classic script in the head.
 *
 * `sessionStorage` is cleared here rather than there, because a direction that has been *used* is
 * what should be forgotten — clearing it before the release would lose the state if this never ran.
 *
 * The class is removed on a timer as well, because a `transitionend` that never arrives — the tab
 * was in the background when the page loaded, so nothing animated — would otherwise leave the body
 * permanently offset. **An animation must not be able to break the page it decorates.**
 */
function slideIn(): void {
  const root = document.documentElement;
  const from = root.classList.contains("slide-from-right")
    ? "slide-from-right"
    : root.classList.contains("slide-from-left")
      ? "slide-from-left"
      : undefined;

  try {
    sessionStorage.removeItem(DIRECTION_KEY);
  } catch {
    // Nothing to clean up, and nothing that stops the release below.
  }
  if (!from) return;

  // Two frames: one for the browser to paint the offset start state, one to remove it so the
  // transition has something to interpolate. Removing it in the same frame is a no-op.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add("sliding");
      root.classList.remove(from);
      setTimeout(() => document.body.classList.remove("sliding"), SLIDE_MS + 60);
    });
  });
}
