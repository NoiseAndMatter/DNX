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
 * **The only rearrangement that needs no blank record**, which is why it is the primitive
 * the librarian starts from. A true move leaves a hole, and filling a hole means writing an
 * empty pattern — bytes we refuse to invent and do not yet have a source for. elk-herd
 * solves that by embedding a compressed blank per storage version; until we do the same, a
 * swap onto an empty slot *is* a move, and it is lossless either way.
 */
export function swap(a: number, b: number): Shuffle {
  if (a === b) return NULL_SHUFFLE;
  return asShuffle([
    { from: a, to: b },
    { from: b, to: a },
  ]);
}

/** Copy one slot onto another, overwriting it and leaving the source in place. */
export function copyOnto(from: number, to: number): Shuffle {
  if (from === to) return NULL_SHUFFLE;
  return asImport([{ from, to }]);
}

/**
 * Validate a shuffle against a bank size, before anything reads a byte.
 *
 * Throws rather than returning a result: an out-of-range index is a programming error in
 * the caller, not a condition a user can be shown and asked about.
 */
export function assertWithin(shuffle: Shuffle, slotCount: number): void {
  const check = (i: number, what: string): void => {
    if (!Number.isInteger(i) || i < 0 || i >= slotCount) {
      throw new ShuffleError(`${what} ${i} is outside 0..${slotCount - 1}`);
    }
  };
  for (const [from, to] of shuffle.movesTo) {
    check(from, "source slot");
    if (to !== undefined) check(to, "destination slot");
  }
  for (const [to, from] of shuffle.cameFrom) {
    check(to, "destination slot");
    if (from !== undefined) check(from, "source slot");
  }
}
