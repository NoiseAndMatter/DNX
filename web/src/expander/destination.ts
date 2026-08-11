/**
 * The Digitone II project being expanded into: what it is, where it came from, and what may be
 * done to it.
 *
 * ## Origin is not a label, it is a capability
 *
 * The four origins look like provenance and behave like permissions:
 *
 * | origin | where from | can it be written back? |
 * |---|---|---|
 * | `blank` | a donor template | no — export it |
 * | `file` | a `.dn2prj` on disk | no — export it |
 * | `device` | the instrument's **active** project | **yes** |
 * | `drive` | any of the 128 stored projects | no — a write goes to the *active* one |
 *
 * That last row is the one worth stating. A write goes to whatever the instrument has loaded, so
 * sending edits made to slot 47 would land them in slot 3. It is a property of the write path, not
 * of this page, and the manager marks the identical case read-only for the identical reason.
 *
 * **The rule is expressed as a missing baseline, not a flag.** A write diffs against `handle`; a
 * project that cannot be written back simply has none. There is no state where a caller can be
 * holding permission and nothing to send, because they are the same field.
 *
 * ## One step of undo, deliberately
 *
 * A full history belongs to the manager's session, which has undo, redo and a log. Here the mistake
 * worth covering is the last drop, and a second stack that behaved almost like the manager's would
 * be worse than none.
 *
 * ## No DOM and no MIDI in this file
 *
 * Which is what makes it answerable in a test — `planning.ts` was extracted the same way and for
 * the same payoff. Reading a project off an instrument and writing one back still live in
 * `main.ts`; they need a connection, and they hand the result here.
 */

/*
 * **No import of `devicesource.js`, deliberately.** This module never looks inside a handle — it
 * only asks whether there is one — so taking the type from there would drag `MIDIInput` into every
 * program that imports a destination, and a Node test of these rules would fail `tsc` on types it
 * never asked for. That has now happened twice (`devicesource.ts`, and again here), so the handle
 * is a type parameter instead: `main.ts` supplies the real one and keeps its type safety.
 */

export type Origin = "blank" | "file" | "device" | "drive";

/** A destination as it stands, including every merge applied so far. */
export interface Opened<Handle = unknown> {
  image: Uint8Array;
  origin: Origin;
  label: string;
  /**
   * The instrument this came from, when a write can go back to it.
   *
   * Carries `original` — the baseline a write diffs against — so accumulated merges all reach the
   * device rather than only the most recent. Absent for every origin but `device`.
   */
  handle?: Handle;
  /**
   * Source patterns merged in so far, in the order they landed.
   *
   * The expansion report is about **what is in this project**, not what the source could offer, so
   * it needs to know what actually went in — and nothing else records that.
   */
  merged: number[];
}

export class Destination<Handle = unknown> {
  #open: Opened<Handle> | undefined;
  /** The image as it was before the last apply. One step; see the note above. */
  #previous: Uint8Array | undefined;

  constructor(private readonly onChange: () => void) {}

  get open(): Opened<Handle> | undefined {
    return this.#open;
  }

  get image(): Uint8Array | undefined {
    return this.#open?.image;
  }

  get merged(): readonly number[] {
    return this.#open?.merged ?? [];
  }

  /** True when **Write to instrument** has somewhere to write to. See the table above. */
  get writable(): boolean {
    return this.#open?.handle !== undefined;
  }

  get canUndo(): boolean {
    return this.#previous !== undefined;
  }

  /** Adopt a destination, however it arrived. Discards any undo step: it belonged to the old one. */
  fill(next: Opened<Handle>): void {
    this.#open = next;
    this.#previous = undefined;
    this.onChange();
  }

  /**
   * Fold a planned result in.
   *
   * `merged` accumulates for a pattern merge and is *replaced* for a whole-project conversion,
   * because that mode does not add to what is there — it produces the project.
   */
  apply(image: Uint8Array, landed: readonly number[], mode: "merge" | "whole"): void {
    const open = this.#open;
    if (!open) return;
    this.#previous = open.image;
    this.#open = {
      ...open,
      image,
      merged: mode === "merge" ? [...open.merged, ...landed] : [...landed],
    };
    this.onChange();
  }

  undo(): void {
    const open = this.#open;
    if (!open || !this.#previous) return;
    this.#open = { ...open, image: this.#previous };
    this.#previous = undefined;
    this.onChange();
  }

  /** What to say once something has been applied — the difference is what to do next. */
  whatNext(): string {
    return this.#open?.origin === "device"
      ? "Write it back, or merge more first."
      : "Merge more, or export.";
  }
}

/**
 * How a destination describes where it came from.
 *
 * The `drive` line says why the write button is unavailable, because a grey button is a fact and
 * the reason is a different thing to read.
 */
export function describeOrigin(origin: Origin): string {
  switch (origin) {
    case "device":
      return "read from the instrument — a write goes back to its ACTIVE project";
    case "drive":
      return "read from the +Drive — export it as a file; a write would land in the ACTIVE project";
    case "blank":
      return "a blank project — export it as a file when you are done";
    case "file":
      return "a project file";
  }
}
