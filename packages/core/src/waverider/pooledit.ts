/**
 * Changing a pool's entries: putting a store slot at a pool index.
 *
 * **One job: the arithmetic of a pool edit.** `poolfile.ts` owns the bytes, `poolview.ts` joins a
 * record to a listing for a reader, and this answers the one question a writer has — *given these
 * entries, what are the entries after the edit, and what did it displace*. Nothing here talks to
 * an instrument, so a test can state a pool and read the answer.
 *
 * ## Free means empty, and a MISSING entry is not free
 *
 * An entry is free when it holds nothing. An entry naming a store slot whose table was deleted is
 * **not** free, even though it plays the built-in Prim. and looks spare: the instrument's own ADD
 * TO POOL skips it and fills the first empty index, and `poolview.ts` argues at length for why
 * clearing one on somebody's behalf is wrong — it digs a hole the next add falls into, and every
 * sound still set to that index then plays an unrelated table. So the order of preference is not a
 * judgement this module makes. Empty, in index order, and nothing else.
 *
 * Reusing a MISSING index is still available by naming it, which is a person deciding to.
 *
 * ## It does not know, and must not say, what the write means
 *
 * The entries handed in may be the firmware's own, synthesised to answer a read of a project that
 * **follows the store**. Placing into those and writing them is what converts that project to a
 * list of its own, which is a real change to how it behaves and needs saying in words to whoever
 * pressed the button. It is not said here: this module would have to guess from entries alone, and
 * `poolState` already answers it properly from the record. The caller holds the record.
 *
 * ## A store slot at two indices is legal
 *
 * Not refused, not deduplicated. The firmware allows it, `summarisePool` reports it as `repeated`,
 * and one table answering two TBL numbers is a thing somebody may want. Two *requests* naming the
 * same index is a different matter and is refused, because one of them would silently win.
 */

import { WaveriderError } from "./errors.js";
import { INDEX_ENTRIES } from "./layout.js";
import { POOL_ENTRIES } from "./pool.js";

/** One table to place. */
export interface PlaceRequest {
  /** The store slot holding the table, `0..255`. */
  storeSlot: number;
  /** The pool index to put it at. **Omitted means the first free index.** */
  index?: number;
}

/** Where one request landed. */
export interface Placed {
  storeSlot: number;
  index: number;
  /** The store slot that index named before, when it named one. The replaced entry. */
  replaced?: number;
}

export interface Placement {
  /** The entries to write: always `POOL_ENTRIES` long, as `buildPoolFile` wants them. */
  entries: (number | undefined)[];
  /** One per request, in the order given, so a caller can name every move it made. */
  placed: Placed[];
}

/** Indices holding nothing, in index order. See the module note on what *free* excludes. */
export function freeIndices(entries: readonly (number | undefined)[]): number[] {
  const free: number[] = [];
  for (let index = 0; index < POOL_ENTRIES; index++) {
    if (entries[index] === undefined) free.push(index);
  }
  return free;
}

/**
 * Put each request's table at its index, or at the first free index.
 *
 * Returns a new array; the entries handed in are not touched. Throws rather than reporting a
 * partial answer: a caller that cannot place everything it asked for has a question for a person,
 * not a half-written pool to send.
 */
export function placeInPool(
  entries: readonly (number | undefined)[],
  requests: readonly PlaceRequest[],
): Placement {
  if (requests.length === 0) {
    throw new WaveriderError("placeInPool was given nothing to place");
  }

  const out: (number | undefined)[] = new Array<number | undefined>(POOL_ENTRIES).fill(undefined);
  for (let index = 0; index < POOL_ENTRIES; index++) out[index] = entries[index];

  const claimed = new Set<number>();
  const placed: Placed[] = [];

  /*
   * **Explicit indices are taken first.** Otherwise a request with no index could be handed the
   * free slot a later explicit request names, and the explicit one would then replace it — the
   * person asked for two placements and would get one, with no error anywhere.
   */
  const order = [...requests.keys()].sort((a, b) => {
    const left = requests[a]!.index === undefined ? 1 : 0;
    const right = requests[b]!.index === undefined ? 1 : 0;
    return left - right || a - b;
  });

  for (const at of order) {
    const request = requests[at]!;
    const { storeSlot } = request;

    if (!Number.isInteger(storeSlot) || storeSlot < 0 || storeSlot >= INDEX_ENTRIES) {
      throw new WaveriderError(
        `a pool entry names a store slot 0..${INDEX_ENTRIES - 1}, and this one names ${storeSlot}`,
      );
    }

    let index = request.index;
    if (index === undefined) {
      // The first index free **now**, so two requests without indices take two different ones.
      index = freeIndices(out).find((candidate) => !claimed.has(candidate));
      if (index === undefined) {
        throw new WaveriderError(
          `this pool has no free slot for the table in store slot ${storeSlot}. All ` +
            `${POOL_ENTRIES} are in use, so a table can only go in by naming the slot it replaces.`,
        );
      }
    } else {
      if (!Number.isInteger(index) || index < 0 || index >= POOL_ENTRIES) {
        throw new WaveriderError(`a pool index is 0..${POOL_ENTRIES - 1}, and this one is ${index}`);
      }
      if (claimed.has(index)) {
        throw new WaveriderError(
          `pool slot ${index + 1} was asked for twice in one edit, so one of the two tables ` +
            `would be dropped without a word`,
        );
      }
    }

    const was = out[index];
    out[index] = storeSlot;
    claimed.add(index);
    placed[at] = { storeSlot, index, ...(was === undefined ? {} : { replaced: was }) };
  }

  return { entries: out, placed };
}

/**
 * Take tables out of a pool, leaving the slots empty.
 *
 * The other half of `placeInPool`, and the one with a consequence worth saying out loud: the table
 * stays in the store, the pool slot becomes empty, and **every sound set to that slot's number
 * plays the built-in Prim. from then on**. Nothing renumbers. The slots after it do not close up.
 *
 * ## Why this exists at all, having been argued against
 *
 * `poolview.ts` argues that DNX must not clear an entry *on somebody's behalf* — a hole dug under
 * them is a hole the next add drops into, and a sound still pointing at a later slot would then
 * play an unrelated table. That argument is about DNX deciding. It is not an argument against a
 * person deciding, and reading it as one left the Library able to add to a pool and never able to
 * take anything out. The owner said so on 2026-10-13: a manager that cannot remove is not a
 * manager.
 *
 * So the hole is still a hole — this does not shuffle the entries up, because renumbering a pool
 * would move every table a sound is already pointing at, which is a far larger change than the one
 * being asked for. The caller's job is to say what the empty slot will do.
 */
export function clearInPool(
  entries: readonly (number | undefined)[],
  indices: readonly number[],
): Placement {
  if (indices.length === 0) {
    throw new WaveriderError("clearInPool was given nothing to clear");
  }

  const out: (number | undefined)[] = new Array<number | undefined>(POOL_ENTRIES).fill(undefined);
  for (let index = 0; index < POOL_ENTRIES; index++) out[index] = entries[index];

  const placed: Placed[] = [];
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= POOL_ENTRIES) {
      throw new WaveriderError(`a pool index is 0..${POOL_ENTRIES - 1}, and this one is ${index}`);
    }
    if (seen.has(index)) {
      throw new WaveriderError(`pool slot ${index + 1} was named twice in one edit`);
    }
    seen.add(index);

    const was = out[index];
    if (was === undefined) {
      throw new WaveriderError(
        `pool slot ${index + 1} is already empty, so there is nothing to take out of it`,
      );
    }
    out[index] = undefined;
    // `storeSlot` is what *left*, which is what a caller naming the change needs. The shape is
    // shared with `placeInPool` so one renderer can describe either edit.
    placed.push({ storeSlot: was, index, replaced: was });
  }

  return { entries: out, placed };
}

/**
 * Which tables go where, for an "add these to the pool" gesture.
 *
 * **One decision for both ways of asking.** The Library offers two: drag a selection onto a pool
 * slot, or select and press a button. They were each working out the answer for themselves and
 * they disagreed twice — the drag dropped store slots that hold nothing, the button did not, and
 * the button laid a run consecutively over occupied slots where it used to fill free ones. Both
 * wrote entries nobody asked for, and the test that claimed the two gestures agreed passed
 * throughout, because it compared the call sites rather than the answers.
 *
 * Two rules, and the second is the one that differs by gesture:
 *
 * - **Only slots that hold a table.** A selection made with shift can run across empty store
 *   slots, and an entry naming an empty slot is a pool entry that reads MISSING the moment it is
 *   written. Dropped silently rather than refusing the whole run, because the person selected a
 *   range and meant the tables in it.
 * - **A named slot means consecutive; no named slot means the free ones.** A drop points at a
 *   slot, so the run starts there and takes the slots after it, whatever is in them — anything
 *   else makes a drop of five land in places nobody could predict from the screen. A press points
 *   at nothing, so it fills free slots one at a time and overwrites nothing, which is also what
 *   ADD TO POOL on the instrument does.
 */
export function planAdd(
  chosen: readonly number[],
  occupied: ReadonlySet<number>,
  at?: number,
): PlaceRequest[] {
  const holding = [...chosen].filter((slot) => occupied.has(slot)).sort((a, b) => a - b);
  if (at === undefined) return holding.map((storeSlot) => ({ storeSlot }));
  return holding.map((storeSlot, nth) => ({ storeSlot, index: at + nth }));
}
