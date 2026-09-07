/**
 * The `?` that attaches an explanation to the thing it explains.
 *
 * ## What it replaces
 *
 * This was a second help system. `help.ts` put a `?` on a control and opened a per-page
 * `<template>` in its own dialog; the help pages opened a different view with different content.
 * Two mechanisms answering one question is how they drift, and only the probe ever had the first
 * one — three topics, on a page whose help is now four sections of the Probe page.
 *
 * So the marker stays and its destination changes. A `?` opens the help **at the section that
 * explains that control**.
 *
 * ## The contract
 *
 * `data-help="<page>/<section>"`, e.g. `data-help="manager/grid"`. Both halves must exist:
 * `test/helppages.test.ts` checks every marker resolves and that every section carrying an `id` is
 * pointed at by something, because a `?` opening on nothing and a section nobody can reach both
 * fail silently.
 *
 * ## Unintrusive, and still discoverable
 *
 * Three states, and the middle one is the whole design:
 *
 * | | |
 * |---|---|
 * | at rest | dim, small, and taking no layout it did not already have |
 * | **hovering the block it belongs to** | **it lifts to full strength** |
 * | hovering or focusing the `?` itself | outlined, unmistakable |
 *
 * A permanently loud `?` on every panel is visual noise on a page somebody uses for hours. One that
 * appears only on hover cannot be found by a keyboard or a touch screen, and cannot be found at all
 * by somebody who does not already suspect it is there. Dim-at-rest is visible enough to notice
 * once and quiet enough to stop noticing, and revealing on the block's hover is what makes it
 * obvious the moment anybody goes looking.
 */

import { openHelp } from "./helpview.js";

/** Where a marker points. */
export interface HelpTarget {
  page: string;
  section: string;
}

/** `"manager/grid"` to its two halves, or `undefined` when it is neither. */
export function parseTarget(value: string): HelpTarget | undefined {
  const [page, section, ...rest] = value.split("/");
  if (!page || !section || rest.length > 0) return undefined;
  return { page, section };
}

function marker(target: HelpTarget, about: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "helpq";
  button.textContent = "?";
  // The block's own words, so a screen reader says which help this is rather than "help" eleven
  // times on one page.
  button.setAttribute("aria-label", about ? `What this does: ${about}` : "Help for this");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openHelp(target.page, button, target.section);
  });
  return button;
}

/**
 * Give every `[data-help]` on the page a `?`.
 *
 * A marker whose target does not parse is **left off rather than added broken**, and the element
 * keeps its `data-help` so the test can still name it.
 */
export function installHelpMarkers(root: ParentNode = document): number {
  let added = 0;
  root.querySelectorAll<HTMLElement>("[data-help]").forEach((host) => {
    if (host.querySelector(":scope > .helpq")) return;
    const target = parseTarget(host.dataset["help"] ?? "");
    if (!target) return;

    const about = (host.textContent ?? "").trim().slice(0, 60);
    host.append(marker(target, about));
    // The block that reveals it on hover. Set here rather than asked of every page's markup, so
    // adding a `?` is one attribute and never two.
    host.classList.add("has-helpq");
    added++;
  });
  return added;
}
