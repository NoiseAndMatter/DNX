/**
 * The difference between two images, as the smallest thing that can undo it.
 *
 * ## Why a diff rather than a declaration
 *
 * The obvious design is for each operation to declare which regions it writes, and to
 * snapshot those. It is faster, and it is the wrong trade here for one reason: this project
 * keeps meeting the same bug class, where **a field nobody thought about silently keeps its
 * old value**. Three audible bugs shipped that way (`KNOWN-ISSUES.md`). An operation that
 * under-declares its regions would produce an undo that silently leaves part of the change
 * in place — the same failure, in a new place, and invisible until a user loses work.
 *
 * Deriving the patch by comparing before and after cannot under-declare. It works for any
 * operation without that operation knowing this module exists — which is what lets track
 * operations, touching sub-ranges inside a pattern record rather than whole slots, need no
 * redesign here.
 *
 * Measured on a DN2 project: **31–38 ms** for a pattern move, swap or clear, and 114 ms for
 * `--keep`, which rewrites 126 slots. Most of that is the two 12.3 MB copies rather than the
 * comparison. Imperceptible for a user action, and worth knowing before anyone puts it in a
 * loop over 128 slots.
 *
 * ## Why both directions are stored
 *
 * A patch holds `before` and `after` bytes for each changed run, so undo and redo are the
 * same operation pointed in opposite directions. The alternative — keep only `before` and
 * re-run the operation to redo — halves memory but requires every operation to be replayable
 * and deterministic, which couples this module to `Shuffle` and would have to be revisited
 * for anything that is not one. Bytes are cheap; a coupling that has to be undone later is
 * not.
 */

/** One contiguous run of bytes that changed. */
export interface Run {
  /** Offset into the image. */
  at: number;
  before: Uint8Array;
  after: Uint8Array;
}

export interface Patch {
  runs: Run[];
  /** Total bytes held, both directions. What a history budget is measured in. */
  bytes: number;
}

/**
 * Runs shorter than this are merged with their neighbour rather than recorded separately.
 *
 * A changed pattern record is not one solid block — it is thousands of small edits separated
 * by bytes that happen to match. Recording each as its own run costs two object headers and
 * two typed-array allocations for a handful of bytes, and can make the "patch" larger than
 * the region it describes. Bridging short gaps trades a few unchanged bytes for far fewer
 * allocations. 64 was chosen by measuring a real rearrangement, not by taste.
 */
const BRIDGE_GAP = 64;

/**
 * Derive the patch that turns `before` into `after`.
 *
 * Both images must be the same length — every operation here rewrites a fixed-size image in
 * place, and a length change would mean something has gone wrong that a patch cannot express.
 */
export function diffImages(before: Uint8Array, after: Uint8Array): Patch {
  if (before.length !== after.length) {
    throw new Error(
      `Cannot diff images of different sizes: ${before.length} and ${after.length}`,
    );
  }

  const runs: Run[] = [];
  let bytes = 0;
  let i = 0;

  while (i < before.length) {
    if (before[i] === after[i]) {
      i++;
      continue;
    }

    const start = i;
    let lastDiff = i;
    i++;

    // Extend through matching bytes shorter than the bridge, so one edited record does not
    // become a thousand runs.
    while (i < before.length) {
      if (before[i] !== after[i]) {
        lastDiff = i;
        i++;
      } else {
        let gap = i;
        while (gap < before.length && gap - i < BRIDGE_GAP && before[gap] === after[gap]) gap++;
        if (gap - i >= BRIDGE_GAP || gap >= before.length) break;
        i = gap;
      }
    }

    const end = lastDiff + 1;
    runs.push({
      at: start,
      before: before.slice(start, end),
      after: after.slice(start, end),
    });
    bytes += (end - start) * 2;
  }

  return { runs, bytes };
}

/** Apply the `after` side, moving an image forward through this patch. */
export function redoPatch(image: Uint8Array, patch: Patch): void {
  for (const run of patch.runs) image.set(run.after, run.at);
}

/** Apply the `before` side, moving an image back through this patch. */
export function undoPatch(image: Uint8Array, patch: Patch): void {
  for (const run of patch.runs) image.set(run.before, run.at);
}

/** True when nothing changed, which is worth not recording as a history step. */
export function isEmptyPatch(patch: Patch): boolean {
  return patch.runs.length === 0;
}

/** The byte range a patch touches, for reporting. Undefined when it touches nothing. */
export function patchExtent(patch: Patch): { from: number; to: number } | undefined {
  if (patch.runs.length === 0) return undefined;
  const first = patch.runs[0]!;
  const last = patch.runs[patch.runs.length - 1]!;
  return { from: first.at, to: last.at + last.before.length };
}
