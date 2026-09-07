/**
 * The help view: a side-nav of pages, and one page of sections at a time.
 *
 * ## The layout, which is CommentLab's
 *
 * - A section's **body is on the left and its screenshot on the right**, stacking to one column on a
 *   narrow window. A section with no image is full width.
 * - A screenshot that is not on disk yet renders a labelled **placeholder carrying its alt text**,
 *   rather than a broken-image rectangle. A page half-captured then reads as deliberate, which it
 *   is: sections are written before the shots are taken.
 * - Clicking a screenshot **enlarges it**. Escape or a click closes.
 *
 * ## Why this is a view rather than the existing dialog
 *
 * `help.ts` puts a `?` on a control and opens one topic in a modal. That is the right shape for
 * *"what is this button"* and the wrong one for *"what does this tool do"* — eight sections with
 * screenshots is not a modal, and a person reading it wants to move between pages.
 *
 * Both stay. The `?` markers answer a question about one control; this answers a question about a
 * tool, and `openHelp` takes a page key so a `?` can hand over to it.
 */

import { HELP_FOR_TOOL, HELP_PAGES, type HelpImage, type HelpPage } from "./helppages.js";
import { mdToHtml } from "./markdown.js";
import { lightboxOpen, showImage } from "./lightbox.js";
import { openOverlay, type Overlay } from "./overlay.js";

let overlay: Overlay | undefined;
let current = HELP_PAGES[0]!.key;
/** A section to scroll to and mark once the page is drawn. */
let target: string | undefined;

function pageFor(key: string): HelpPage {
  return HELP_PAGES.find((p) => p.key === key) ?? HELP_PAGES[0]!;
}

/**
 * A screenshot, or a labelled space where one will go.
 *
 * The `error` handler is the whole mechanism: nothing here knows which files exist, and asking
 * would mean a second source of truth to keep in step with the directory.
 */
function figure(image: HelpImage): HTMLElement {
  const wrap = document.createElement("figure");
  wrap.className = "help-shot";

  const img = document.createElement("img");
  img.src = image.src;
  img.alt = image.alt;
  img.loading = "lazy";
  img.addEventListener("click", () => showImage(image.src, image.alt));
  img.addEventListener("error", () => {
    const pending = document.createElement("div");
    pending.className = "help-pending";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Screenshot pending";
    const alt = document.createElement("span");
    alt.textContent = image.alt;
    pending.append(label, alt);
    wrap.replaceChildren(pending);
  });

  wrap.append(img);
  return wrap;
}

function render(): void {
  if (!overlay) return;
  const page = pageFor(current);

  const nav = document.createElement("nav");
  nav.className = "help-nav";
  nav.setAttribute("aria-label", "Help pages");
  for (const entry of HELP_PAGES) {
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = entry.title;
    if (entry.key === current) link.setAttribute("aria-current", "page");
    link.addEventListener("click", () => { current = entry.key; render(); });
    nav.append(link);
  }

  const body = document.createElement("div");
  body.className = "help-body";

  const title = document.createElement("h2");
  title.textContent = page.title;
  body.append(title);

  if (page.intro) {
    const intro = document.createElement("div");
    intro.className = "help-intro help-md";
    intro.innerHTML = mdToHtml(page.intro);
    body.append(intro);
  }

  for (const section of page.sections) {
    const block = document.createElement("section");
    block.className = "help-section";
    if (section.id) block.dataset["section"] = section.id;

    const heading = document.createElement("h3");
    heading.textContent = section.heading;
    block.append(heading);

    const row = document.createElement("div");
    row.className = section.image ? "help-row has-shot" : "help-row";
    const prose = document.createElement("div");
    prose.className = "help-md";
    prose.innerHTML = mdToHtml(section.body);
    row.append(prose);
    if (section.image) row.append(figure(section.image));
    block.append(row);
    body.append(block);
  }

  const header = document.createElement("header");
  const label = document.createElement("h2");
  label.textContent = "Help";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "help-close";
  close.textContent = "Close";
  close.addEventListener("click", () => closeHelp());
  header.append(label, close);

  const columns = document.createElement("div");
  columns.className = "help-columns";
  columns.append(nav, body);

  overlay.panel.replaceChildren(header, columns);
  body.scrollTop = 0;

  /*
   * **Scrolled to and marked, not just scrolled to.** A `?` that jumps you into the middle of a
   * long page leaves you working out which paragraph answered your question. The mark fades on its
   * own, so it says "this one" without leaving the page looking permanently annotated.
   */
  if (target) {
    const found = body.querySelector<HTMLElement>(`[data-section="${target}"]`);
    target = undefined;
    if (found) {
      found.scrollIntoView({ block: "start" });
      found.classList.add("help-landed");
      setTimeout(() => found.classList.remove("help-landed"), 1600);
    }
  }
}

/** Open the help, on `key` if given, on the current tool's page otherwise. */
export function openHelp(key?: string, from?: HTMLElement, section?: string): void {
  if (overlay) return;
  if (key) current = pageFor(key).key;
  target = section;

  overlay = openOverlay({
    className: "help-panel",
    scrimClassName: "help-scrim",
    label: "Help",
    ...(from === undefined ? {} : { opener: from }),
    // An enlarged screenshot is on top. The first Escape closes that, not the help.
    isBlocked: lightboxOpen,
    // Escape and a click outside close it without going through `closeHelp`, and a stale reference
    // here makes the guard above refuse every later open.
    onClose: () => { overlay = undefined; },
  });
  render();
  overlay.panel.querySelector<HTMLElement>("button")?.focus();
}

export function closeHelp(): void {
  overlay?.close();
  overlay = undefined;
}

export function helpOpen(): boolean {
  return overlay?.open === true;
}

/**
 * The link in the tool row, on every page.
 *
 * It opens the page for the tool you are on, because that is the question you have when you press
 * it. The side-nav is how you get anywhere else.
 */
export function renderHelpLink(container: HTMLElement, tool: string): HTMLElement {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "helplink";
  link.textContent = "help";
  link.title = `Help for the ${tool}, and every other tool`;
  link.addEventListener("click", () => openHelp(HELP_FOR_TOOL[tool], link));
  container.append(link);
  return link;
}
