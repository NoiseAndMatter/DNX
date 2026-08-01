/**
 * The slot grid, shared by every tool that asks *"which slots?"*.
 *
 * ## Why this is a module
 *
 * The manager answers that question with a grid you select and drag on. The expander answered it
 * with a text box you typed `A1` into — two tools, one question, two languages, and the typed one
 * was worse than inconsistent: it made you choose **blind**, and you found out the slot was occupied
 * from a refusal rather than from looking at it.
 *
 * So the grid comes out of the manager and both use it. Extracting rather than copying, for the same
 * reason `devicesource.ts` moved up a level once two pages needed it.
 *
 * ## What is shared and what is not
 *
 * **Shared:** how a slot looks, how selection behaves (click, shift for a range, ctrl to toggle),
 * and the drag plumbing — start, hover, refuse, drop.
 *
 * **Not shared: what a drop means.** The manager's drop moves patterns inside one project; the
 * expander's takes patterns from a Digitone 1 and lands them in a Digitone II. Those are different
 * operations and the difference belongs to the caller, so `GridDrag` asks rather than decides.
 *
 * That split is also what makes **cross-grid** dragging work: one `GridDrag` bound to two grids
 * knows which one a drag started in, and the caller's policy decides whether that is allowed.
 */

// Shared with `src/`, which is where the platform-free copy has to live. This module used to carry
// its own, and it was the one that did not escape quotes.
import { escapeHtml } from "../../src/sheet/html.js";
import { type DropAction, type DropModifiers } from "./dropaction.js";

/** One cell, already reduced to what it displays. */
export interface SlotView {
  index: number;
  /** `A1`, `T12` — whatever the caller's naming says. */
  id: string;
  /** The pattern or track name, or a placeholder. */
  name: string;
  /** The line underneath: `12 trigs · 3 locks`, `empty`, `unreadable version`. */
  detail: string;
  /**
   * A line between the name and the detail — the track grid's machine, `FM TONE` or `MIDI`.
   *
   * Omitted by the pattern grid, which has nothing to put there. Rendered only when present, so
   * one renderer serves both rather than two drifting apart.
   */
  machine?: string;
  /** Extra classes for this cell, e.g. `midi`. The stylesheet decides what they look like. */
  classes?: readonly string[];
  occupied: boolean;
  /**
   * False when the record's storage version is one we cannot read.
   *
   * Kept distinct from `occupied` because *"there is something here I cannot read"* and *"there is
   * nothing here"* must never look the same — one of them is somebody's work.
   */
  supported: boolean;
}

/** Where a drag came from. `grid` identifies which grid, so a cross-grid drop can be judged. */
export interface DragFrom {
  grid: string;
  indices: number[];
}

/** What hovering over a cell would do, or `undefined` when the drop is refused. */
export interface GridDropHint {
  /** Painted by the shared stylesheet from `data-action`. */
  action: DropAction;
  /** Drawn by CSS from `data-action`, rather than injected as a child that a re-render would eat. */
  label: string;
  /**
   * The sentence to show while hovering, if the caller wants one.
   *
   * Supplied by the caller rather than composed here: only it knows whether this is "move A1 A2 to
   * B3" or "merge 4 patterns from the Digitone 1 into E1".
   */
  status?: string;
}

/**
 * Modifier keys, as both a `MouseEvent` and a `DragEvent` supply them.
 *
 * Extends the rule vocabulary rather than restating it, and adds the one key the grid stores but
 * no rule consults.
 */
export interface GridModifiers extends DropModifiers {
  altKey?: boolean;
}

export interface GridDragPolicy {
  /**
   * Called before a drag begins, so the caller can bring the selection into line with it.
   *
   * Returns the indices actually being dragged. Dragging one of several selected slots should drag
   * the whole selection; dragging anything else should drag that one **and take the selection with
   * it**, so the two never disagree about what is happening.
   */
  onDragStart(grid: string, index: number): number[];
  hintFor(from: DragFrom, grid: string, index: number, modifiers: GridModifiers): GridDropHint | undefined;
  onDrop(from: DragFrom, grid: string, index: number, modifiers: GridModifiers): void;
  /** Told what is happening, or `""` when nothing is. */
  onStatus?(message: string, kind?: "info" | "warn"): void;
  /** Told why a drop was refused, when the caller wants to say so. */
  onRefused?(reason: string): void;
}

/**
 * Drag state across one or more grids.
 *
 * One instance per page rather than per grid: a drag that starts in the source grid and ends in the
 * destination grid is one gesture, and two controllers would each see half of it.
 */
export class GridDrag {
  private from: DragFrom | undefined;
  private hovering: { cell: HTMLElement; grid: string; index: number } | undefined;
  private modifiers: GridModifiers = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

  constructor(private readonly policy: GridDragPolicy) {}

  /** What is being dragged, for a caller that needs to know mid-gesture. */
  get dragging(): DragFrom | undefined {
    return this.from;
  }

  /**
   * Repaint whatever is under the cursor.
   *
   * Needed because holding shift or ctrl changes what a drop would do **without** producing a
   * `dragover`, so the label under the cursor would otherwise go stale mid-gesture.
   */
  repaintHovered(modifiers?: GridModifiers): void {
    if (modifiers) this.modifiers = modifiers;
    if (!this.hovering || !this.from) return;
    paint(this.hovering.cell, this.policy.hintFor(this.from, this.hovering.grid, this.hovering.index, this.modifiers));
  }

  /** Give one cell click, drag and drop behaviour. */
  bind(cell: HTMLElement, grid: string, index: number): void {
    cell.draggable = true;

    cell.addEventListener("dragstart", (event) => {
      this.from = { grid, indices: this.policy.onDragStart(grid, index) };
      cell.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", this.from.indices.join(" "));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "all";
    });

    cell.addEventListener("dragend", () => {
      this.from = undefined;
      this.hovering = undefined;
      for (const el of document.querySelectorAll<HTMLElement>(".slot.dragging, .slot.target")) {
        el.classList.remove("dragging");
        clear(el);
      }
      this.policy.onStatus?.("");
    });

    cell.addEventListener("dragover", (event) => {
      this.modifiers = event;
      const hint = this.from ? this.policy.hintFor(this.from, grid, index, event) : undefined;

      // A refused drop is simply not accepted, which leaves the browser's own "no" cursor in place
      // — the clearest possible signal, and one we do not have to draw.
      if (!hint) {
        clear(cell);
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = hint.action === "copy" ? "copy" : "move";
      this.hovering = { cell, grid, index };
      paint(cell, hint);
      if (hint.status !== undefined) this.policy.onStatus?.(hint.status);
    });

    cell.addEventListener("dragleave", () => {
      if (this.hovering?.cell === cell) this.hovering = undefined;
      clear(cell);
    });

    cell.addEventListener("drop", (event) => {
      const from = this.from;
      this.hovering = undefined;
      clear(cell);
      // A drop with nothing in flight is a stray from outside the page, and silence is the right
      // response to it.
      if (!from) return;
      event.preventDefault();
      this.from = undefined;
      this.policy.onDrop(from, grid, index, event);
    });
  }
}

export interface RenderGridOptions {
  /** Indices currently selected in **this** grid. */
  selected: readonly number[];
  /** A cell to mark as drilled into — the manager's opened pattern. */
  opened?: number;
  onClick(index: number, event: MouseEvent): void;
  /** Omitted for a read-only grid. */
  drag?: { controller: GridDrag; grid: string };
}

/**
 * Draw a grid of slots into a container, replacing whatever was there.
 *
 * Rebuilds rather than patches. A grid is at most 128 cheap cells and the alternative is a
 * diffing scheme whose bugs would look exactly like the format bugs this project already hunts —
 * a cell showing the wrong slot's name is indistinguishable from a reader reading the wrong offset.
 */
export function renderGrid(
  container: HTMLElement,
  slots: readonly SlotView[],
  options: RenderGridOptions,
): void {
  container.innerHTML = "";

  for (const slot of slots) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "slot";
    if (!slot.supported) cell.classList.add("unsupported");
    else if (slot.occupied) cell.classList.add("occupied");
    if (slot.index === options.opened) cell.classList.add("opened");
    cell.setAttribute("aria-selected", String(options.selected.includes(slot.index)));

    for (const extra of slot.classes ?? []) cell.classList.add(extra);

    cell.innerHTML =
      `<span class="id">${escapeHtml(slot.id)}</span>` +
      `<span class="nm">${escapeHtml(slot.name)}</span>` +
      (slot.machine === undefined ? "" : `<span class="mc">${escapeHtml(slot.machine)}</span>`) +
      `<span class="tc">${escapeHtml(slot.detail)}</span>`;

    cell.addEventListener("click", (event) => {
      options.onClick(slot.index, event);
    });
    options.drag?.controller.bind(cell, options.drag.grid, slot.index);
    container.append(cell);
  }
}

/**
 * Extend a selection the way every list in every application does.
 *
 * Shared because getting it subtly different in two tools is worse than either behaviour: shift
 * takes a range from the anchor, ctrl or meta toggles one, and a plain click replaces.
 */
export function nextSelection(
  selection: readonly number[],
  anchor: number | undefined,
  index: number,
  modifiers: GridModifiers,
): { selection: number[]; anchor: number } {
  if (modifiers.shiftKey && anchor !== undefined) {
    const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
    const range: number[] = [];
    for (let i = lo; i <= hi; i++) range.push(i);
    return { selection: range, anchor };
  }
  if (modifiers.ctrlKey || modifiers.metaKey) {
    const at = selection.indexOf(index);
    const next = at >= 0 ? selection.filter((i) => i !== index) : [...selection, index];
    return { selection: next, anchor: index };
  }
  return { selection: [index], anchor: index };
}

/** Decorate the hovered cell, or clear it when the drop would be refused. */
function paint(cell: HTMLElement, hint: GridDropHint | undefined): void {
  clear(cell);
  if (!hint) return;
  cell.classList.add("target", hint.action);
  cell.setAttribute("data-action", hint.label);
}

function clear(cell: HTMLElement): void {
  cell.classList.remove("target", "move", "copy", "swap", "merge");
  cell.removeAttribute("data-action");
}

// --- banks ---------------------------------------------------------------------------------------

/** `A`…`H`. Both families number their patterns in banks of sixteen. */
export const BANKS = "ABCDEFGH";

export const BANK_SIZE = 16;

/** How many banks a device of this many patterns has. */
export function bankCount(patternCount: number): number {
  return Math.ceil(patternCount / BANK_SIZE);
}

/**
 * The bank strip above a grid.
 *
 * Shared for the same reason the grid is: it is half of *"which slot?"*, and a tool that drew its
 * own would answer that question in its own way. The count on each tab is what makes a bank worth
 * clicking — it is the only thing on screen that says where the music is.
 */
export function renderBanks(
  container: HTMLElement,
  options: {
    patternCount: number;
    current: number;
    /** Occupied slots in a bank, for the badge. Omitted for a grid that cannot count. */
    countOccupied?: (bank: number) => number;
    onSelect(bank: number): void;
  },
): void {
  container.hidden = false;
  container.innerHTML = "";

  for (let bank = 0; bank < bankCount(options.patternCount); bank++) {
    const occupied = options.countOccupied?.(bank) ?? 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(bank === options.current));
    // The badge is empty rather than `0` for an empty bank: a row of zeroes is noise, and the
    // absence of a number already says it.
    button.innerHTML = `${BANKS[bank]}<span class="n">${occupied || ""}</span>`;
    button.addEventListener("click", () => {
      options.onSelect(bank);
    });
    container.append(button);
  }
}

/** The slots of one bank, ready for `renderGrid`. */
export function bankSlots(
  bank: number,
  patternCount: number,
  view: (index: number) => Omit<SlotView, "index">,
): SlotView[] {
  const from = bank * BANK_SIZE;
  const to = Math.min(from + BANK_SIZE, patternCount);
  const slots: SlotView[] = [];
  for (let index = from; index < to; index++) slots.push({ index, ...view(index) });
  return slots;
}
