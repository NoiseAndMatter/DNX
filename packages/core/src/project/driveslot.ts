/**
 * The parts of a +Drive project write that involve no device.
 *
 * Split out because `driveproject.ts` reaches Web MIDI through `devicesource.ts`, and importing it
 * from a test drags `MIDIInputMap` into the **Node** typecheck that runs over `test/`. The same trap
 * `songview.ts` hit with `grid.ts`: a browser module pulled in for one function.
 *
 * So the two functions that need nothing but bytes live here, and both the write path and its tests
 * use them.
 */

/** Where a project slot lives. The device turns the last segment into a number. */
export function projectPath(slot: number): string {
  return `/projects/${slot}`;
}

/**
 * Where two images first differ, or `undefined` when they do not.
 *
 * Used to check a write by comparing **decoded images**, never payload bytes: LZ4 is a deterministic
 * format and not a deterministic encoding, so a correct write reads back as different bytes and the
 * same project.
 *
 * **It short-circuits on a length mismatch and returns the shorter length without comparing a
 * single byte.** That is deliberate and it is a trap for a caller that prints the number as an
 * offset: see `compareImages`, which is what a verdict should use.
 */
export function firstDifference(a: Uint8Array, b: Uint8Array): number | undefined {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return undefined;
}

/**
 * How a read-back relates to what was sent: equal, differing at a byte, or one a prefix of the
 * other.
 *
 * `longer` and `shorter` are **measured, not assumed** — the overlap is compared byte by byte
 * before the lengths are reported, which is the whole difference between this and
 * `firstDifference`.
 */
export type ImageComparison =
  | { kind: "equal" }
  | { kind: "differs"; at: number }
  /** Every byte sent read back unchanged, and the stored form carries `by` more after them. */
  | { kind: "longer"; by: number }
  /** The read-back agrees as far as it goes and then stops `by` bytes early. */
  | { kind: "shorter"; by: number };

/**
 * Compare a read-back against what was sent.
 *
 * Written after a write that was reported as *"decodes to a different image, first difference at
 * byte 12,889,604 of 12,889,604"*. Those two numbers being equal is the tell: the index was the
 * shorter length, no byte had been looked at, and the project was fine. A verdict has to say which
 * of the four things happened, because *the bytes differ* and *there are more bytes* call for
 * opposite responses from whoever reads it.
 */
export function compareImages(back: Uint8Array, sent: Uint8Array): ImageComparison {
  const overlap = Math.min(back.length, sent.length);
  for (let i = 0; i < overlap; i++) {
    if (back[i] !== sent[i]) return { kind: "differs", at: i };
  }
  if (back.length === sent.length) return { kind: "equal" };
  return back.length > sent.length
    ? { kind: "longer", by: back.length - sent.length }
    : { kind: "shorter", by: sent.length - back.length };
}
