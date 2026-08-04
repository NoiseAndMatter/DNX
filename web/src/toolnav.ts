/**
 * The tool titles, which are also the navigation between tools.
 *
 * ## The row never reorders
 *
 * Expander, manager, probe — always, on every page. Settled by the user against a
 * most-recently-used ordering, which was the first sketch and is worse: MRU turns the row into a
 * history stack, so going back and forth between two tools swaps positions 2 and 3 every time and
 * the thing you just clicked is no longer where it was. A fixed row makes each tool a permanent
 * screen position, and therefore muscle memory, which is worth more than expressing recency.
 *
 * So **none of the motion is in the titles**. The highlight moves, nothing reflows, and the page
 * itself slides.
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

/** Fixed order. Changing it changes where every tool lives on screen, so it changes muscle memory. */
export const TOOLS = [
  { id: "expander", href: "index.html", label: "expander" },
  { id: "manager", href: "manager.html", label: "manager" },
  { id: "probe", href: "probe.html", label: "probe" },
] as const;

export type ToolId = (typeof TOOLS)[number]["id"];

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
export function renderToolNav(container: HTMLElement, current: ToolId): void {
  const nav = document.createElement("nav");
  nav.className = "toolnav";
  nav.setAttribute("aria-label", "Tools");

  TOOLS.forEach((tool, at) => {
    const link = document.createElement("a");
    link.className = "tool";
    link.href = tool.href;
    link.textContent = tool.label;
    // Discoverable, because a shortcut nobody can find is a shortcut nobody uses.
    link.title = `${tool.label[0]!.toUpperCase()}${tool.label.slice(1)} — Ctrl+Alt+${at + 1}`;
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
      goTo(at, current);
    });
    nav.append(link);
  });

  container.append(nav);
  wireShortcuts(current);
  slideIn();
}

/** Navigate to a tool by position, remembering which way the page should appear to move. */
function goTo(to: number, current: ToolId): void {
  const from = TOOLS.findIndex((tool) => tool.id === current);
  if (to === from || !TOOLS[to]) return;
  try {
    sessionStorage.setItem(DIRECTION_KEY, to > from ? "right" : "left");
  } catch {
    // Private mode, or storage disabled. The page still navigates; it simply arrives without the
    // slide, which is a missing flourish rather than a missing feature.
  }
  location.href = TOOLS[to].href;
}

function wireShortcuts(current: ToolId): void {
  const at = TOOLS.findIndex((tool) => tool.id === current);

  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const to = at + (event.key === "ArrowRight" ? 1 : -1);
      // **Stops at the ends rather than wrapping.** The row is a fixed line of three, and a
      // "next" that jumps from the last back to the first is how you end up on the probe when
      // you meant to leave the expander.
      if (to < 0 || to >= TOOLS.length) return;
      event.preventDefault();
      goTo(to, current);
      return;
    }

    // See the note above: Ctrl+Alt is AltGr, and on several layouts these digits are how you type
    // `@` and `|`. Typing wins wherever typing is what is happening.
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > TOOLS.length) return;
    if (isEditable(event.target)) return;
    event.preventDefault();
    goTo(digit - 1, current);
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
 * Slide the arriving page in from whichever side it came.
 *
 * The class is removed on a timer as well as on `transitionend`, because a `transitionend` that
 * never arrives — the tab was in the background when the page loaded, so nothing animated — would
 * otherwise leave the body permanently offset. **An animation must not be able to break the page it
 * decorates.**
 */
function slideIn(): void {
  let direction: string | null = null;
  try {
    direction = sessionStorage.getItem(DIRECTION_KEY);
    sessionStorage.removeItem(DIRECTION_KEY);
  } catch {
    return;
  }
  if (direction !== "left" && direction !== "right") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const body = document.body;
  body.classList.add(direction === "right" ? "slide-from-right" : "slide-from-left");

  // Two frames: one for the browser to paint the offset start state, one to remove it so the
  // transition has something to interpolate. Removing it in the same frame is a no-op.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      body.classList.add("sliding");
      body.classList.remove("slide-from-right", "slide-from-left");
      setTimeout(() => body.classList.remove("sliding"), SLIDE_MS + 60);
    });
  });
}
