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
 * | geometry | anything that fits a slot | 16 x 512, or what `/modinfo` reports |
 * | size | up to 512 KiB | 16 KiB, or 2 x waves x points |
 * | how many | 256 slots | 128 entries, in slot order (127 before 2026-10-06) |
 *
 * So a 64 x 4,096 table imports, stores, verifies and stays silent, and `convert.ts` will happily
 * produce one. A user meeting that without warning would reasonably read it as a broken write
 * rather than an unplayed table, which makes it DNX's to say rather than the firmware's.
 *
 * ## The gap is one build's, so the numbers come from the build where it says so
 *
 * A build reporting the `playable` capability carries its own bounds in `/modinfo` bytes 248..251,
 * and `unplayableReason` applies those when a caller has them. Without the bit the pair below is
 * the rule, and that is the fallback the spec names rather than one chosen here.
 *
 * **The constants stay, and they are not the general answer.** `POOL_WAVES`, `POOL_POINTS` and
 * `POOL_BYTES` describe builds before the capability, which are the builds in the field; a caller
 * sizing a buffer for an arbitrary table wants `2 x waves x points`, not `POOL_BYTES`.
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

/** The only geometry a build without the `playable` capability loads. */
export const POOL_WAVES = 16;
export const POOL_POINTS = 512;

/** And therefore this many bytes, of a slot's 524,288. That build's figure, not every build's. */
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
 * What one build plays, as `/modinfo` bytes 248..251 report it.
 *
 * A range, where the rule above is a single pair, and that is the whole difference between the two
 * builds: before the `playable` capability a table played only at 16 x 512, and from it a table
 * plays at anything inside these bounds. `modinfo.ts` decodes them and never judges; this module
 * judges and never reads bytes.
 */
export interface PlayableBounds {
  /** The most waves a table the pool plays has. One is the fewest, always. */
  maxWaves: number;
  minPoints: number;
  maxPoints: number;
  /** Whether a table's points must be a power of two. */
  pointsPowerOfTwo: boolean;
}

/** `points` is a power of two. Zero is not, which matters because zero reaches here. */
function isPowerOfTwo(points: number): boolean {
  return points > 0 && (points & (points - 1)) === 0;
}

/**
 * What a build will play, in a person's words.
 *
 * Exported because the reason below is not the only place somebody is told: a probe page says
 * which rule it is about to apply *before* it judges anything, and a second hand-written copy of
 * the phrase is how one of them comes to say 4096 where the other says 4,096.
 */
export function playableGeometryPhrase(bounds?: PlayableBounds): string {
  if (!bounds) return `${POOL_WAVES} x ${POOL_POINTS} only`;
  const points =
    bounds.minPoints === bounds.maxPoints
      ? `${bounds.minPoints} points`
      : `${bounds.minPoints} to ${bounds.maxPoints} points`;
  return (
    `1 to ${bounds.maxWaves} waves of ${points}` +
    (bounds.pointsPowerOfTwo ? ", the points a power of two" : "")
  );
}

/**
 * Why the pool will not play this table, or `undefined` when it will.
 *
 * A sentence rather than a flag, because every caller that asks this wants to tell somebody, and a
 * boolean would have each of them writing the explanation again.
 *
 * **`bounds` omitted means the 16 x 512 rule**, which is a specified fallback and not a guess: a
 * build that does not report the `playable` capability is a build that plays that pair and nothing
 * else. So this is the opposite of `WaveriderFeatures.poolSlots`, where there is no honest default
 * and the absence has to be shown. A caller with a `/modinfo` record passes what it says; a caller
 * without one is talking to an older build and the older rule is the right one.
 */
export function unplayableReason(geometry: Geometry, bounds?: PlayableBounds): string | undefined {
  const { waves, points } = geometry;
  const format = geometry.sampleFormat ?? FORMAT_INT16_BE;

  if (format !== FORMAT_INT16_BE) {
    return `sample format ${format} is not loaded; the pool reads format ${FORMAT_INT16_BE}`;
  }

  const fits = bounds
    ? waves >= 1 &&
      waves <= bounds.maxWaves &&
      points >= bounds.minPoints &&
      points <= bounds.maxPoints &&
      (!bounds.pointsPowerOfTwo || isPowerOfTwo(points))
    : waves === POOL_WAVES && points === POOL_POINTS;

  if (!fits) {
    return (
      `${waves} x ${points} is stored but not played: this build plays ${playableGeometryPhrase(bounds)}. ` +
      `The table is kept at full resolution and will play unchanged if the pool's geometry widens.`
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
