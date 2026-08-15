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
 */
export function firstDifference(a: Uint8Array, b: Uint8Array): number | undefined {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return undefined;
}
