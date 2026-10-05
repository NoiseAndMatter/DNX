/**
 * Big-endian field access, which both records need and neither owns.
 *
 * Extracted when the second caller appeared, which is the rule: the superblock and the index entry
 * read and write the same two widths, and a second copy of `putBe32` is a second place for an
 * off-by-one to live.
 *
 * **Scoped to the Waverider store deliberately.** `device/storage.ts` has a `u32`, `project/dn2song.ts`
 * has a local `u16` and `putU16`, and `project/dn2image.ts` has its own again. Consolidating those
 * is worth doing and is a different job from this one — doing it here would put a core-wide
 * refactor inside a feature branch.
 */

export const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;

export const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

export function putBe16(b: Uint8Array, at: number, value: number): void {
  b[at] = (value >>> 8) & 0xff;
  b[at + 1] = value & 0xff;
}

export function putBe32(b: Uint8Array, at: number, value: number): void {
  b[at] = (value >>> 24) & 0xff;
  b[at + 1] = (value >>> 16) & 0xff;
  b[at + 2] = (value >>> 8) & 0xff;
  b[at + 3] = value & 0xff;
}
