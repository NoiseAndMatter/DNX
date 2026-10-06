/**
 * What the DSP's wavetable pool will actually play, which is narrower than what a slot holds.
 *
 * **One job: the gap between stored and playable.** `slotfile.ts` builds what the store takes and
 * `layout.ts` says where it goes; this says whether the instrument can currently make a sound with
 * it. They are separate because they move for different reasons: the store's limits are the
 * format's, and these are one firmware build's.
 *
 * ## The gap, and why DNX has to be the one to mention it
 *
 * | | the store | the pool |
 * |---|---|---|
 * | geometry | anything that fits a slot | 16 waves x 512 points only |
 * | size | up to 512 KiB | 16 KiB |
 * | how many | 256 slots | 127 entries, in slot order |
 *
 * So a 64 x 4,096 table imports, stores, verifies and stays silent, and `convert.ts` will happily
 * produce one. A user meeting that without warning would reasonably read it as a broken write
 * rather than an unplayed table, which makes it DNX's to say rather than the firmware's.
 *
 * The slot is 512 KiB on purpose even so: a table stored at full resolution is already right when
 * the pool's geometry widens, and nothing has to be re-imported. The size is a bet on the format,
 * and this module is the honesty about today.
 *
 * ## Slot order is the automatic pool, and soon it is only the default
 *
 * `poolPlacement` and `automaticEntries` describe the pool the firmware builds for a project that
 * has no pool of its own: every playable table in store-slot order. Every project does that today.
 * Once the `/wavepool` records land, a project with a record of its own ignores this entirely, so
 * these two functions answer *what a project with no record plays*, and `poolfile.ts` answers the
 * rest. They also say what shifts: an upload into a free store slot below the others moves every
 * later pool index, and only a stored record pins them.
 *
 * ## Timing
 *
 * **Only the boot fill waits.** Five seconds after boot, and then on the next UI pass after each
 * commit or delete through `/waverider`, which is about a second. A write is therefore briefly
 * silent after it lands, which is worth a word in a status line: silence straight after a
 * successful write is otherwise indistinguishable from a failure.
 *
 * Measured by the firmware session in the SHARC emulator, 2026-10-05, nine of nine. **The byte
 * order is still a hypothesis**: their check has store int16 big-endian agreeing with DDR int16
 * little-endian inside one implementation, which is self-consistency rather than a measurement.
 */

import { FORMAT_INT16_BE } from "./entries.js";

/** The only geometry the pool loads today. */
export const POOL_WAVES = 16;
export const POOL_POINTS = 512;

/** And therefore this many bytes, of a slot's 524,288. */
export const POOL_BYTES = POOL_WAVES * POOL_POINTS * 2;

/**
 * Pool entries the loader hands out, in slot order.
 *
 * **128 since 2026-10-06**, to match the 128-sound pool, which is the owner's reason for it. It
 * was 127, and a record written by a build from before that holds 127: `poolfile.ts` reads one of
 * those and reports the 128th as empty, so nothing above this line has to know which it came
 * from.
 */
export const POOL_ENTRIES = 128;

/** `TBL 0` and `TBL 1` are the baked tables; the pool starts here. */
export const FIRST_POOL_TBL = 2;

/**
 * Seconds after **boot** before the pool is filled.
 *
 * A commit or a delete refills it on the next UI pass instead, about a second, so this is the
 * figure for a power cycle and not for a write. The two were one number here until the firmware
 * session corrected it, and the write path was telling people to wait five times too long.
 */
export const POOL_BOOT_FILL_SECONDS = 5;

/** A geometry, as much of a table as this module needs to judge it. */
export interface Geometry {
  waves: number;
  points: number;
  sampleFormat?: number;
}

/**
 * Why the pool will not play this table, or `undefined` when it will.
 *
 * A sentence rather than a flag, because every caller that asks this wants to tell somebody, and a
 * boolean would have each of them writing the explanation again.
 */
export function unplayableReason(geometry: Geometry): string | undefined {
  const { waves, points } = geometry;
  const format = geometry.sampleFormat ?? FORMAT_INT16_BE;

  if (format !== FORMAT_INT16_BE) {
    return `sample format ${format} is not loaded; the pool reads format ${FORMAT_INT16_BE}`;
  }
  if (waves !== POOL_WAVES || points !== POOL_POINTS) {
    return (
      `${waves} x ${points} is stored but not played: the pool loads ${POOL_WAVES} x ` +
        `${POOL_POINTS} only. The table is kept at full resolution and will play unchanged if the ` +
        `pool's geometry widens.`
    );
  }
  return undefined;
}

/**
 * Which `TBL` number each used slot becomes, and which get no number at all.
 *
 * The pool is handed out in slot order, so the 128th used slot onward is stored, listed and never
 * played. `undefined` is that case, and it is the one a user filling the store would otherwise meet
 * without warning.
 *
 * Takes the slots that are **in use**, in any order; the ordering is applied here so a caller
 * cannot get it wrong by passing a listing in listing order.
 */
export function poolPlacement(usedSlots: Iterable<number>): Map<number, number | undefined> {
  const ordered = [...new Set(usedSlots)].sort((a, b) => a - b);
  const out = new Map<number, number | undefined>();
  ordered.forEach((slot, nth) => {
    out.set(slot, nth < POOL_ENTRIES ? FIRST_POOL_TBL + nth : undefined);
  });
  return out;
}

/**
 * The automatic pool as a pool record's entries: the **store slot** at each **pool index**.
 *
 * `poolPlacement` read the other way round, and the second caller that earns it: a read of
 * `/wavepool/<p>` for a project with no record of its own comes back with exactly this, synthesised
 * by the firmware, so DNX can say what a project plays before any record exists and can check a
 * read against what it expected.
 *
 * Takes the slots whose tables the pool will **play**, in any order, which is a narrower set than
 * the slots in use: `unplayableReason` is the judge, and a stored table of the wrong geometry is
 * not in the automatic pool at all.
 */
export function automaticEntries(playableSlots: Iterable<number>): (number | undefined)[] {
  const ordered = [...new Set(playableSlots)].sort((a, b) => a - b).slice(0, POOL_ENTRIES);
  const entries: (number | undefined)[] = new Array<number | undefined>(POOL_ENTRIES).fill(undefined);
  ordered.forEach((slot, index) => {
    entries[index] = slot;
  });
  return entries;
}
