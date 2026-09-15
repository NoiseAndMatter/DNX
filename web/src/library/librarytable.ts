/**
 * The +Drive library as a table — the rows, the omnibox and the tag chips.
 *
 * ## Why a table where the pool keeps its grid
 *
 * The two collections are not the same shape and pretending otherwise cost the library its
 * usability. A bank is **256 presets**; a pool is **128 slots**. The grid is right for the pool —
 * it shows occupancy at a glance and carries the lock counts, which is what somebody scans it for —
 * and wrong for a bank, where the question is *"where is the kick I made last week"* and the answer
 * is a name in a list of 256 squares.
 *
 * So this is deliberately not a shared component with `grid.ts`. Same app, same drag, different
 * question.
 *
 * ## The rows are still drag sources
 *
 * `GridDrag.bind` takes any element, so a `<tr>` drags onto a pool cell exactly as a square did.
 * That is the whole reason the table could replace the grid without redesigning the gesture — and
 * dragging is how a preset gets into a pool, per the standing rule that nothing in this app is
 * done by typing a slot name.
 *
 * ## Everything here draws; nothing here decides
 *
 * Which rows to show is `filter.ts`, and it is pure. This module renders whatever it is handed.
 */

import { type TagName } from "../../../src/project/tags.js";
import { type FilterResult, type LibraryFilter, type LibraryRow, tagCounts } from "./filter.js";
import { type GridDrag } from "../grid.js";
import { escapeHtml } from "../dom.js";

export interface TableHooks {
  /** A row was clicked. */
  onSelect: (index: number) => void;
  /**
   * The row that is selected, if it is in this bank.
   *
   * **Drawn, not just remembered.** Rename acts on the selection, and until 2026-09-15 the table never
   * showed one: the owner clicked a preset, saw nothing change, and could not tell what Rename would
   * rename. A control that acts on something the page does not show is guessing on the user's behalf.
   */
  selected?: number;
  /** A tag chip was pressed. The caller toggles and re-renders. */
  onToggleTag: (tag: TagName) => void;
  drag: GridDrag;
}

/**
 * Draw the rows.
 *
 * The whole table is rebuilt rather than patched. A bank is 256 rows of five short cells, which is
 * nothing to build, and the alternative — reconciling rows as tags arrive — is a diffing problem
 * nobody needs for a list this size.
 */
export function renderRows(host: HTMLElement, result: FilterResult, hooks: TableHooks): void {
  host.innerHTML = "";

  const table = document.createElement("table");
  table.className = "libtable";

  const head = document.createElement("thead");
  head.innerHTML =
    "<tr><th>#</th><th>Name</th><th>Machine</th><th>Tags</th><th>State</th></tr>";
  table.append(head);

  const body = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    tr.className = row.occupied ? "occupied" : "free";
    if (row.index === hooks.selected) {
      tr.classList.add("selected");
      tr.setAttribute("aria-selected", "true");
    }

    tr.append(
      cell(String(row.index), "n"),
      cell(row.occupied ? row.name || "—" : "—", "name"),
      cell(row.machine ?? "", "machine"),
      tagCell(row),
      // The device protects saved work, so an occupied slot reads as not writable. Shown because it
      // is what a future save would run into, not as a synonym for occupied.
      cell(row.occupied ? (row.writable ? "saved" : "saved · protected") : "free", "state"),
    );

    if (row.occupied) {
      hooks.drag.bind(tr, "library", row.index);
      tr.addEventListener("click", () => hooks.onSelect(row.index));
    }

    body.append(tr);
  }
  table.append(body);
  host.append(table);
}

/**
 * The tag cell.
 *
 * Three states, and they are not two: **unread** is not **untagged**. A slot nobody has read yet
 * says so, because a blank would claim the device was asked and answered nothing.
 */
function tagCell(row: LibraryRow): HTMLElement {
  const td = document.createElement("td");
  td.className = "tags";

  if (!row.occupied) return td;
  if (row.tags === undefined) {
    td.innerHTML = `<span class="unread">reading…</span>`;
    return td;
  }
  if (row.tags.length === 0) {
    td.innerHTML = `<span class="untagged">untagged</span>`;
    return td;
  }

  td.innerHTML = row.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
  return td;
}

function cell(text: string, className: string): HTMLElement {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

/**
 * The tag chips, each with what pressing it would leave.
 *
 * The count is the point. A bare list of tags makes somebody click to find out whether it narrows
 * to forty or to one; `KICK 12` answers that before the click, and a tag that would leave nothing
 * is not offered at all — `tagCounts` omits it.
 */
export function renderTagChips(
  host: HTMLElement,
  rows: readonly LibraryRow[],
  filter: LibraryFilter,
  onToggle: (tag: TagName) => void,
): void {
  host.innerHTML = "";

  // Selected tags first and always shown, even when they have narrowed the result to nothing —
  // otherwise the chip you just pressed disappears and there is no way to press it again.
  const counts = tagCounts(rows, filter);
  const offered = [
    ...filter.tags.map((tag) => ({ tag, count: counts.find((c) => c.tag === tag)?.count ?? 0 })),
    ...counts.filter((c) => !filter.tags.includes(c.tag)),
  ];

  for (const { tag, count } of offered) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tagchip";
    const on = filter.tags.includes(tag);
    chip.setAttribute("aria-pressed", String(on));
    chip.innerHTML = `${escapeHtml(tag)}<span class="n">${count}</span>`;
    chip.addEventListener("click", () => onToggle(tag));
    host.append(chip);
  }
}

/** What the table says about itself, above the rows. */
export function summarise(result: FilterResult, total: number, filtered: boolean): string {
  const shown = result.rows.length;
  const base = filtered ? `${shown} of ${total}` : `${total} slot(s)`;
  // The unread count is the honest half: a tag filter cannot speak for rows nobody has read, and
  // saying so is better than a number that quietly grows as the reads land.
  return result.unknown > 0 ? `${base} · ${result.unknown} not read yet` : base;
}
