/**
 * A shuffle: a reordering of slots, described before anything is written.
 *
 * Adapted from elk-herd's `Bank.Shuffle` (BSD 2-Clause, Mark Lentczner). The idea worth
 * borrowing is the separation of *intent* from *application*: a shuffle is a pure
 * description of where things move, so it can be inspected, previewed, merged with another
 * shuffle, and — crucially — used to **repair references** to the things that moved.
 *
 * Two directions matter and they are not symmetric:
 *
 * - `sourceOf(destination)` — "what ends up here?" Used when building the new image.
 * - `rereference(old)` — "where did the thing that was here go?" Used when fixing anything
 *   that *points* at a slot, such as a song row naming a pattern.
 *
 * Nothing here knows about Digitone bytes. It is index arithmetic, which is why it can be
 * reused unchanged for patterns now and for the sound pool later — the pool is the case
 * where `rereference` stops being theoretical, since sound locks address it by index.
 */

/** Where a slot's contents end up. `undefined` means discarded. */
export type Destination = number | undefined;
/** Where a slot's new contents come from. `undefined` means it is left empty. */
export type Origin = number | undefined;

export class ShuffleError extends Error {}

export interface Shuffle {
  /** Old index -> new index, or `undefined` where the contents are discarded. */
  readonly movesTo: ReadonlyMap<number, Destination>;
  /** New index -> old index, or `undefined` where the slot is emptied. */
  readonly cameFrom: ReadonlyMap<number, Origin>;
  /** True when nothing actually moves. */
  readonly isEmpty: boolean;
}

export interface Move {
  from: number;
  to: number;
}

function build(moves: readonly Move[], intra: boolean): Shuffle {
  const movesTo = new Map<number, Destination>();
  const cameFrom = new Map<number, Origin>();

  // Two sources landing on one slot would silently resolve to whichever was listed last,
  // quietly dropping the other. None of the constructors here can produce that, so it is a
  // caller's bug rather than a user's mistake, and it should be loud.
  const claimed = new Set<number>();
  for (const { from, to } of moves) {
    if (from === to) continue;
    if (claimed.has(to)) {
      throw new ShuffleError(
        `two sources both land on slot ${to}; one would be silently discarded`,
      );
    }
    claimed.add(to);
  }

  // Within one bank, a move vacates its source: the slot is emptied unless something else
  // lands on it. Across banks the source project is untouched, so no vacancy is implied.
  if (intra) {
    for (const { from, to } of moves) {
      if (from === to) continue;
      movesTo.set(to, undefined);
      cameFrom.set(from, undefined);
    }
  }

  for (const { from, to } of moves) {
    if (from === to) continue;
    movesTo.set(from, to);
    cameFrom.set(to, from);
  }

  return { movesTo, cameFrom, isEmpty: cameFrom.size === 0 };
}

/** A reordering inside one bank. Moving out of a slot leaves it empty. */
export function asShuffle(moves: readonly Move[]): Shuffle {
  return build(moves, true);
}

/** A copy from one bank into another. The source bank is unchanged. */
export function asImport(moves: readonly Move[]): Shuffle {
  return build(moves, false);
}

export const NULL_SHUFFLE: Shuffle = asShuffle([]);

/**
 * What lands in `index` once the shuffle is applied.
 *
 * Returns `index` itself when nothing touches it — an untouched slot keeps its contents —
 * and `undefined` when the slot is emptied. Callers must distinguish those two: one means
 * "leave it alone", the other means "write a blank here".
 */
export function sourceOf(shuffle: Shuffle, index: number): Origin {
  if (!shuffle.cameFrom.has(index)) return index;
  return shuffle.cameFrom.get(index);
}

/**
 * Where the contents of `index` end up, for repairing references to it.
 *
 * Returns `index` when it does not move, and `undefined` when its contents are discarded —
 * at which point any reference to it is dangling and the caller has to decide what that
 * means rather than silently repointing it somewhere plausible.
 */
export function rereference(shuffle: Shuffle, index: number): Destination {
  if (!shuffle.movesTo.has(index)) return index;
  return shuffle.movesTo.get(index);
}

/** Slots whose contents are going somewhere, in ascending order. */
export function movedSlots(shuffle: Shuffle): number[] {
  return [...shuffle.movesTo.entries()]
    .filter(([, to]) => to !== undefined)
    .map(([from]) => from)
    .sort((a, b) => a - b);
}

/** Slots that will be written, in ascending order. */
export function touchedSlots(shuffle: Shuffle): number[] {
  return [...shuffle.cameFrom.keys()].sort((a, b) => a - b);
}

/**
 * Combine two shuffles, with `later` winning where they disagree.
 *
 * Deliberately a plain overlay rather than a composition: composing would need to decide
 * what a two-step move means for a slot emptied in between, and no caller needs that yet.
 */
export function mergeShuffles(earlier: Shuffle, later: Shuffle): Shuffle {
  const movesTo = new Map([...earlier.movesTo, ...later.movesTo]);
  const cameFrom = new Map([...earlier.cameFrom, ...later.cameFrom]);
  return { movesTo, cameFrom, isEmpty: cameFrom.size === 0 };
}

/**
 * Exchange two slots.
 *
 * The only rearrangement that needs no blank record, which is why the librarian started
 * here. It is still the right choice when both slots hold work, because it is lossless in
 * both directions — but `move` and `clear` are now available too, since `blank.ts` supplies
 * a captured empty patternKit to fill a vacated slot.
 *
 * **Deliberately not batched.** Move, copy and clear all generalise to many sources because
 * "these things go there" still means something. A swap of several sources against several
 * targets does not have one obvious reading, so offering it would be inventing a semantic
 * rather than exposing one. Two slots, exchanged.
 */
export function swap(a: number, b: number): Shuffle {
  if (a === b) return NULL_SHUFFLE;
  return asShuffle([
    { from: a, to: b },
    { from: b, to: a },
  ]);
}

/**
 * Land a run of sources at consecutive slots starting from `to`, keeping their given order.
 *
 * Sources may overlap the destinations freely — `applyRearrange` reads every source from the
 * original image, so `[4, 3] -> 3` is a swap rather than a slot read twice.
 *
 * Contiguous placement is deliberately the simple rule. elk-herd's `dragAndDrop` does
 * something richer: it fills empty slots and *pushes* occupied ones further down the bank,
 * which is nicer to use and much harder to predict from a command line. Worth adopting when
 * there is a UI to drag in; wrong to guess at now.
 */
function run(froms: readonly number[], to: number): Move[] {
  return froms.map((from, i) => ({ from, to: to + i }));
}

/**
 * Copy slots, overwriting the destinations and leaving the sources as they were.
 *
 * Batch by nature: pass one source or many.
 */
export function copyMany(froms: readonly number[], to: number): Shuffle {
  return asImport(run(froms, to));
}

/** Copy one slot onto another, overwriting it and leaving the source in place. */
export function copyOnto(from: number, to: number): Shuffle {
  return copyMany([from], to);
}

/**
 * Move slots, leaving the sources empty.
 *
 * Distinct from `swap` in what happens to the source: a swap gives it the destination's old
 * contents, a move blanks it. Both are lossy about the destination and neither is lossy
 * about the thing being moved.
 *
 * Batch by nature: pass one source or many.
 */
export function moveMany(froms: readonly number[], to: number): Shuffle {
  return asShuffle(run(froms, to));
}

/** Move a single slot's contents, leaving the source empty. */
export function move(from: number, to: number): Shuffle {
  return moveMany([from], to);
}

/**
 * Keep only these slots, packed to the front of the bank, and empty everything else.
 *
 * The building block for a clean test project: take the two patterns you care about, put
 * them in `A1` and `A2`, and blank the other 126.
 *
 * The subtlety worth naming, because it was a bug first: a slot that is **already in its
 * final position** must not be cleared. `asImport` drops identity moves as no-ops, which is
 * right on its own but wrong when merged over a blanket clear — the clear would win and the
 * pattern you asked to keep would vanish. So those slots are excluded from the clear rather
 * than rescued by a move.
 */
export function keepOnly(keep: readonly number[], slotCount: number): Shuffle {
  const stayingPut = new Set(keep.filter((from, i) => from === i));
  const toClear: number[] = [];
  for (let i = 0; i < slotCount; i++) if (!stayingPut.has(i)) toClear.push(i);

  return mergeShuffles(
    clear(...toClear),
    asImport(keep.map((from, i) => ({ from, to: i }))),
  );
}

/** Empty one or more slots, writing a blank into each. */
export function clear(...slots: readonly number[]): Shuffle {
  const movesTo = new Map<number, Destination>();
  const cameFrom = new Map<number, Origin>();
  for (const slot of slots) {
    movesTo.set(slot, undefined);
    cameFrom.set(slot, undefined);
  }
  return { movesTo, cameFrom, isEmpty: cameFrom.size === 0 };
}

/**
 * Slots referenced by the shuffle that fall outside the bank, in ascending order.
 *
 * Returned rather than thrown, because the usual cause is a person asking to move three
 * patterns to `H15` — off the end by one — and that deserves an explanation rather than a
 * stack trace.
 */
export function outOfRange(shuffle: Shuffle, slotCount: number): number[] {
  const bad = new Set<number>();
  const check = (i: number | undefined): void => {
    if (i === undefined) return;
    if (!Number.isInteger(i) || i < 0 || i >= slotCount) bad.add(i);
  };
  for (const [from, to] of shuffle.movesTo) {
    check(from);
    check(to);
  }
  for (const [to, from] of shuffle.cameFrom) {
    check(to);
    check(from);
  }
  return [...bad].sort((a, b) => a - b);
}

/** Throwing form, for callers that treat an out-of-range slot as their own bug. */
export function assertWithin(shuffle: Shuffle, slotCount: number): void {
  const bad = outOfRange(shuffle, slotCount);
  if (bad.length > 0) {
    throw new ShuffleError(`slot(s) ${bad.join(", ")} are outside 0..${slotCount - 1}`);
  }
}
