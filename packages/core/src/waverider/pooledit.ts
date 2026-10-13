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
