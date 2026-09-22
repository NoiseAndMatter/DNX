/**
 * One open project, a history of what was done to it, and the ability to take it back.
 *
 * ## Why this exists at all, given the CLI does not need it
 *
 * `npm run rearrange --apply --out new.dn2prj` writes a new file and leaves the original
 * alone, so undo there is a `rm`. The value appears the moment a project is held in memory
 * across many operations and exported once — which is the manager, and the UI on top of it.
 * Building it as "an undo stack" would be designing against an imagined consumer; building
 * it as **the session** — what is open, what has been done, what can be taken back, what
 * gets exported — is the layer the UI actually drives, and undo falls out of it.
 *
 * ## What it costs, and why not whole snapshots
 *
 * elk-herd's `Undo.elm` keeps a whole copy of its model per step and bounds the history by
 * step count. That is affordable in Elm, where persistent data structures share everything
 * an operation did not touch. Our project is a flat `Uint8Array`, so "a whole copy" is
 * literally 12.9 MB on the DN2 — twenty steps would be a quarter of a gigabyte.
 *
 * So the history holds **patches**, not images, and is bounded by **bytes rather than
 * steps**. Measured on a real DN2 project:
 *
 * | Operation | History cost, both directions |
 * |---|---|
 * | swap two patterns | 179 KB |
 * | move one into an empty slot | 156 KB |
 * | clear one pattern | 118 KB |
 * | `--keep A1 A2`, blanking 126 slots | **15.5 MB** |
 *
 * A swap costs 1/70th of an image, and the default 64 MB budget holds about 366 of them. But
 * one `--keep` costs as much as 87 swaps — which is the whole argument against bounding by
 * step count. Twenty steps is either wasteful or useless depending on which twenty you got.
 *
 * ## Tags, taken from elk-herd
 *
 * Every step carries a `Tag` naming what the user did, so the history reads as an account of
 * the session rather than an anonymous stack — "Undo move A1 to C5", not "Undo". A
 * **combining** tag collapses a run of same-kind steps into one, which is what makes renaming
 * undo as a rename rather than one keystroke at a time. Both are elk-herd's design; the
 * detail worth copying is that undoing or redoing **cancels an entry's ability to combine**,
 * so typing, undoing, then typing again does not merge across the undo.
 */

import { type Patch, diffImages, isEmptyPatch, redoPatch, undoPatch } from "./patch.js";
import { type Device, deviceFor } from "./device.js";

/** What the user did, for the undo menu. */
export interface Tag {
  label: string;
  /** True when consecutive steps with the same label should collapse into one. */
  combining: boolean;
}

export function tag(label: string): Tag {
  return { label, combining: false };
}

/**
 * A tag whose consecutive uses merge.
 *
 * For anything where one user gesture produces many model changes — typing a name, dragging
 * a slider — so that undo takes back the gesture rather than the keystroke.
 */
export function combiningTag(label: string): Tag {
  return { label, combining: true };
}

interface Step {
  tag: Tag;
  patch: Patch;
  /** Cleared when this step is undone or redone, so a later step cannot merge across it. */
  combinable: boolean;
}

export interface HistoryEntry {
  label: string;
  bytes: number;
}

export interface SessionOptions {
  /**
   * How many bytes of history to keep. Default 64 MB, about 300 pattern moves on the DN2.
   *
   * Bounded by bytes because steps are not comparable: a swap is small, `--keep` rewrites
   * almost the whole image.
   */
  budgetBytes?: number;
}

const DEFAULT_BUDGET = 64 * 1024 * 1024;

/**
 * A project open for editing.
 *
 * The image is mutated in place and `image` hands out a view of it. Callers must not retain
 * it across an operation: after `apply`, `undo` or `redo` the same buffer holds different
 * bytes. Anything that needs a stable copy should ask for `snapshot()`.
 */
export class Session {
  private readonly buffer: Uint8Array;
  private readonly done: Step[] = [];
  private readonly undone: Step[] = [];
  private readonly budget: number;
  /** Bytes held by `done` and `undone` together. */
  private held = 0;
  /**
   * Steps dropped because the budget was reached.
   *
   * Surfaced rather than silent: a user who has done 400 operations and finds undo stops
   * partway deserves to be told the history was trimmed, not left to think it is broken.
   */
  private trimmed = 0;

  readonly device: Device;

  constructor(image: Uint8Array, options: SessionOptions = {}) {
    this.buffer = Uint8Array.from(image);
    this.device = deviceFor(this.buffer);
    this.budget = options.budgetBytes ?? DEFAULT_BUDGET;
  }

  /** The live image. Valid until the next mutation. */
  get image(): Uint8Array {
    return this.buffer;
  }

  /** An independent copy, safe to keep. */
  snapshot(): Uint8Array {
    return Uint8Array.from(this.buffer);
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Bytes of history currently held, for a UI that wants to show it. */
  get historyBytes(): number {
    return this.held;
  }

  /** Steps dropped to stay inside the budget. Non-zero means undo cannot reach the start. */
  get trimmedSteps(): number {
    return this.trimmed;
  }

  /** Most recent first, the way an undo menu lists them. */
  history(): HistoryEntry[] {
    return this.done
      .slice()
      .reverse()
      .map((s) => ({ label: s.tag.label, bytes: s.patch.bytes }));
  }

  /**
   * Steps that have been undone and could be redone, **newest first**.
   *
   * The mirror of `history()`, and it exists for the same reason: a control that can only step one
   * at a time makes the user click eleven times to reach a state they can see. Together the two
   * make a timeline — what has happened, and what would happen again — which is the thing somebody
   * actually wants to navigate.
   *
   * Newest first so the two lists concatenate into one ordering without either being reversed.
   */
  future(): HistoryEntry[] {
    return this.undone.map((s) => ({ label: s.tag.label, bytes: s.patch.bytes }));
  }

  /** What undo would take back, for labelling the control. */
  get undoLabel(): string | undefined {
    return this.done[this.done.length - 1]?.tag.label;
  }

  get redoLabel(): string | undefined {
    return this.undone[this.undone.length - 1]?.tag.label;
  }

  /**
   * Run an operation and record it.
   *
   * `mutate` receives a copy to work on and returns the resulting image; the difference
   * between the two becomes the history entry. Taking a copy rather than letting the caller
   * edit in place is what makes the diff possible at all, and it means an operation that
   * throws partway leaves the session untouched rather than half-applied.
   *
   * Returns false when nothing changed, in which case no history entry is made — an
   * operation that did nothing should not consume an undo step.
   */
  apply(t: Tag, mutate: (image: Uint8Array) => Uint8Array): boolean {
    const before = Uint8Array.from(this.buffer);
    const after = mutate(Uint8Array.from(this.buffer));
    const patch = diffImages(before, after);
    if (isEmptyPatch(patch)) return false;

    this.buffer.set(after);

    // A new action makes the redo branch unreachable.
    for (const step of this.undone) this.held -= step.patch.bytes;
    this.undone.length = 0;

    const previous = this.done[this.done.length - 1];
    if (
      t.combining &&
      previous &&
      previous.combinable &&
      previous.tag.combining &&
      previous.tag.label === t.label
    ) {
      // Merge: keep the older `before` so undo reaches the start of the gesture, and take the
      // newer `after`. Recomputing against the original is simpler than composing two patches
      // and cannot drift from what the bytes actually are.
      this.held -= previous.patch.bytes;
      this.done.pop();
      const merged = diffImages(this.beforeOf(previous, before), after);
      this.done.push({ tag: t, patch: merged, combinable: true });
      this.held += merged.bytes;
    } else {
      this.done.push({ tag: t, patch, combinable: true });
      this.held += patch.bytes;
    }

    this.trim();
    return true;
  }

  /** Reconstruct the image as it was before `step`, given the image just before this apply. */
  private beforeOf(step: Step, currentBefore: Uint8Array): Uint8Array {
    const image = Uint8Array.from(currentBefore);
    undoPatch(image, step.patch);
    return image;
  }

  /** Take back the last operation. Returns its label, or undefined when there is nothing. */
  undo(): string | undefined {
    const step = this.done.pop();
    if (!step) return undefined;
    undoPatch(this.buffer, step.patch);
    // Undoing ends a combining run: typing, undoing, then typing again must not merge.
    step.combinable = false;
    this.undone.push(step);
    return step.tag.label;
  }

  redo(): string | undefined {
    const step = this.undone.pop();
    if (!step) return undefined;
    redoPatch(this.buffer, step.patch);
    step.combinable = false;
    this.done.push(step);
    return step.tag.label;
  }

  /**
   * Drop the oldest steps until the history fits its budget.
   *
   * The oldest go first because they are the least likely to be wanted, and because dropping
   * a step from the middle would make the remaining patches describe transitions that no
   * longer connect.
   */
  private trim(): void {
    while (this.held > this.budget && this.done.length > 1) {
      const dropped = this.done.shift()!;
      this.held -= dropped.patch.bytes;
      this.trimmed++;
    }
  }
}
