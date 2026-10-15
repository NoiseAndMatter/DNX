/**
 * Reading a fixed-width name field.
 *
 * Every name the instruments store is a run of latin1 bytes in a field of fixed size, ended by
 * the first NUL or by the field's end. Four modules carried their own copy of this until 2026-10-16.
 */

const latin1 = new TextDecoder("latin1");

/** The name in `size` bytes at `at`, stopping at the first NUL. */
export function readFixedName(data: Uint8Array, at: number, size: number): string {
  const raw = data.subarray(at, at + size);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul));
}
