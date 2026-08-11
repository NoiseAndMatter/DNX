/**
 * One parameter-lock slot: two bytes, and what they mean.
 *
 * A lock slot is `coarse | fine`, big-endian. For an ordinary 0-127 parameter the whole
 * value sits in `coarse` and `fine` is zero, which is why reading the pair as a plain
 * integer worked for as long as nothing with finer resolution was tested. It is not a
 * plain integer: `fine` adds 1/128 of a coarse step.
 *
 * VERIFIED on hardware 2026-07-26, by sweeping an LFO depth (range -128.00 to +127.98)
 * across a pattern and reading the bytes back — see `docs/dn2-pattern-format.md` §4:
 *
 *     -128.00  00 00      -1.00  3f 7f      +0.01  40 01      +127.98  7f fe
 *      -64.00  20 00      -0.01  3f ff      +1.00  40 81
 *
 * Which interpretation applies is a property of the *parameter*, not of the slot, so this
 * module offers the readings and leaves the choice to the caller. `lockCoarse` is the one
 * that is always meaningful.
 *
 * The DN1 uses the same slot layout. That is inferred rather than measured — no DN1 sweep was
 * captured — and the reassurance that used to sit here, that "conversion transfers both bytes
 * together, so a wrong reading could not corrupt a converted project", was wrong twice over.
 * Conversion did **not** transfer them together: `expand/convert.ts` read the DN1 pair as a
 * little-endian integer and wrote it back big-endian, swapping the two bytes of every lock it
 * converted. Coarse became zero, and for a bipolar parameter zero is not a near-miss but the
 * bottom of the range — a pan-locked trig played hard left, on hardware, for months.
 *
 * **Read and write a slot the same way round, or copy the two bytes. Never let one end name an
 * endianness the other end does not.**
 */

/** Slot value meaning "this step is not locked". Also marks an unused record header. */
export const LOCK_UNSET = 0xffff;

/** True when the step carries a lock at all. */
export function isLockSet(raw: number): boolean {
  return raw !== LOCK_UNSET;
}

/** The coarse byte — the whole value for any 0-127 parameter. */
export function lockCoarse(raw: number): number {
  return (raw >>> 8) & 0xff;
}

/** The fine byte — 1/128 of a coarse step each, zero for parameters without fine resolution. */
export function lockFine(raw: number): number {
  return raw & 0xff;
}

/** Assemble a slot from its two bytes. */
export function lockRaw(coarse: number, fine: number): number {
  return ((coarse & 0xff) << 8) | (fine & 0xff);
}

/**
 * A bipolar byte parameter, e.g. delay WID or the sidechain filter frequency.
 *
 * Bipolar values are stored **offset by +64, not in two's complement** — verified across
 * the A3 and A4 captures. That is what keeps -1 away from `0xFFFF` and lets the sentinel
 * mean what it says.
 */
export function lockBipolar(raw: number): number {
  return lockCoarse(raw) - 64;
}

/**
 * A fine-resolution parameter spanning `min` to `min + 255.99`, in 1/128 steps.
 *
 * The default range is the LFO depth's, the only one swept on hardware. The quantum is
 * 1/128 = 0.0078, which the device displays rounded to two places — so the smallest
 * non-zero depth reads `0.01`, and the maximum `32766/128 - 128` reads `127.98`. Both
 * match what the device showed.
 */
export function lockFineValue(raw: number, min = -128): number {
  return raw / 128 + min;
}
