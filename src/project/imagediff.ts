/**
 * What changed between two readings of the same project, and where it sits.
 *
 * ## Why this exists
 *
 * The Digitone II's song table has never been located. It is somewhere in ~63,620 unidentified tail
 * bytes, which is why `SongState` returns `unknown` for the DN2 and why the rearrange guard is blind
 * there.
 *
 * The first attempt at finding it was a statistical scanner: index recurring values, measure the
 * gaps, propose a stride. It could be made to work on synthetic data and kept failing its own
 * examination against the Digitone 1, whose table is known independently. **It was solving a harder
 * problem than we have.**
 *
 * The easier problem: save a project, change one thing on the instrument, save again, and diff.
 * Whatever moved *is* the thing. No inference, no ranking, no confidence — the bytes either changed
 * or they did not.
 *
 * ## The null save, which is the part that is easy to skip
 *
 * A project re-saved with no changes at all is **not** guaranteed to be byte-identical. Save
 * counters, timestamps and checksums move on their own. So the first diff to take is
 * *original → saved unchanged*, and that is the **noise floor**: every byte in it changes for
 * reasons that have nothing to do with what is being investigated.
 *
 * `subtractNoise` exists so a later diff can have that floor removed rather than being read with it
 * still in. Attributing a save counter to a song row is exactly the sort of confident wrong answer
 * this codebase keeps paying for.
 *
 * ## Runs, not bytes
 *
 * A changed record shows up as thousands of individual differing bytes and as one run. Runs are what
 * a person can read, and the gap tolerance means a record with a few unchanged bytes in the middle
 * still reports as one region rather than forty.
 */

import { type ImageLayout, layoutFor } from "./dn2image.js";

/** A contiguous stretch of changed bytes. */
export interface Run {
  from: number;
  /** Exclusive. */
  to: number;
  get length(): number;
}

/** A run, with what part of the image it lands in. */
export interface LabelledRun {
  from: number;
  to: number;
  length: number;
  /** Which structure it falls in — `pattern 12`, `kit 3`, `pool sound 47`, `tail +0x2efc`. */
  where: string;
  /** Offset from the start of the region named in `where`. */
  offsetInRegion: number;
}

export class DiffError extends Error {}

/**
 * Changed byte runs between two images of the same size.
 *
 * `gapTolerance` joins runs separated by a short stretch of identical bytes: a changed record is one
 * finding, not one per differing byte, and a field that happens to keep its value in the middle of a
 * record should not split the report.
 */
export function changedRuns(a: Uint8Array, b: Uint8Array, gapTolerance = 16): Run[] {
  if (a.length !== b.length) {
    throw new DiffError(
      `images are ${a.length.toLocaleString()} and ${b.length.toLocaleString()} bytes. Only two ` +
        `readings of the same project can be diffed; a different size is a different thing.`,
    );
  }

  const runs: { from: number; to: number }[] = [];
  let from = -1;
  let lastDiff = -1;

  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (from < 0) {
      from = i;
    } else if (i - lastDiff > gapTolerance) {
      runs.push({ from, to: lastDiff + 1 });
      from = i;
    }
    lastDiff = i;
  }
  if (from >= 0) runs.push({ from, to: lastDiff + 1 });

  return runs.map((r) => ({ ...r, get length() { return this.to - this.from; } }));
}

/**
 * Remove the runs a null save produces.
 *
 * A run is dropped when it lies entirely inside a noise run. Overlap is deliberately **not** treated
 * as noise: a song row that happens to start inside a region the save also touches is a real
 * finding, and silently swallowing it would be the worst possible failure for this tool.
 */
export function subtractNoise(runs: readonly Run[], noise: readonly Run[]): Run[] {
  return runs.filter((r) => !noise.some((n) => r.from >= n.from && r.to <= n.to));
}

/** Where in the image an offset falls, in the words the format documents use. */
export function locate(at: number, layout: ImageLayout): { where: string; offsetInRegion: number } {
  if (at < layout.headerSize) return { where: "image header", offsetInRegion: at };

  if (at < layout.kitBase) {
    const i = Math.floor((at - layout.headerSize) / layout.patternSize);
    return { where: `pattern ${i}`, offsetInRegion: (at - layout.headerSize) % layout.patternSize };
  }

  if (at < layout.tailBase) {
    const i = Math.floor((at - layout.kitBase) / layout.kitSize);
    return { where: `kit ${i}`, offsetInRegion: (at - layout.kitBase) % layout.kitSize };
  }

  // The tail. Its interior is only partly identified, so this reports an offset from `tailBase`
  // rather than inventing a structure — which is the whole point when hunting an unknown table.
  return { where: `tail +0x${(at - layout.tailBase).toString(16)}`, offsetInRegion: at - layout.tailBase };
}

export interface DiffOptions {
  gapTolerance?: number;
  /** Runs from a null save, to be discounted. */
  noise?: readonly Run[];
  layout?: ImageLayout;
}

/** Diff two images and say where each change landed. */
export function diffImages(a: Uint8Array, b: Uint8Array, options: DiffOptions = {}): LabelledRun[] {
  const layout = options.layout ?? layoutFor(a);
  let runs = changedRuns(a, b, options.gapTolerance ?? 16);
  if (options.noise) runs = subtractNoise(runs, options.noise);

  return runs.map((r) => {
    const { where, offsetInRegion } = locate(r.from, layout);
    return { from: r.from, to: r.to, length: r.to - r.from, where, offsetInRegion };
  });
}

/**
 * A summary that answers "did anything land outside the tail?" first.
 *
 * When hunting a song table, a change in a pattern record means the experiment was not clean — the
 * instrument was touched somewhere else too — and that has to be obvious rather than buried in a
 * list of two hundred runs.
 */
export function summarise(runs: readonly LabelledRun[], layout: ImageLayout): string[] {
  if (runs.length === 0) return ["No bytes differ. The two images are identical."];

  const bytes = runs.reduce((n, r) => n + r.length, 0);
  const inTail = runs.filter((r) => r.from >= layout.tailBase);
  const elsewhere = runs.filter((r) => r.from < layout.tailBase);

  const out = [
    `${runs.length} changed region(s), ${bytes.toLocaleString()} bytes.`,
    `${inTail.length} in the tail, ${elsewhere.length} elsewhere.`,
  ];

  if (elsewhere.length > 0) {
    out.push(
      `NOT a clean experiment for a tail hunt — ${elsewhere.length} region(s) outside the tail: ` +
        `${[...new Set(elsewhere.map((r) => r.where))].slice(0, 6).join(", ")}.`,
    );
  }

  if (inTail.length > 0) {
    const first = inTail[0]!;
    const last = inTail[inTail.length - 1]!;
    out.push(
      `Tail changes span +0x${(first.from - layout.tailBase).toString(16)} to ` +
        `+0x${(last.to - layout.tailBase).toString(16)} ` +
        `(${(last.to - first.from).toLocaleString()} bytes end to end).`,
    );
  }
  return out;
}
