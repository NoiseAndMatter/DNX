/**
 * Waverider's two original tables, as files DNX can put in the store.
 *
 * A build that reports the `poolOnly` capability has no tables of its own: `TBL` item 0 is silence
 * and every table comes from the pool. The firmware never writes the +Drive, so DNX offers these.
 *
 * **Copied, never converted.** `convertTable` normalises, and the point of these tables is that
 * they are the frames the firmware used to ship. The PCM goes across unchanged and the gain is 1.
 *
 * **Recognised by name.** The listing gives names, and comparing contents would read 256 slots on
 * every connect. A person's own table called `Prim.` therefore counts as installed, and a renamed
 * original counts as missing. Both end in a question the person can answer, not in a lost table.
 */

import { readWavFile } from "../audio/wavfile.js";
import { WaveriderError } from "./errors.js";
import type { StoreSlotFacts } from "./poolview.js";
import type { PendingSlot } from "./slotfile.js";
import { xxHash32 } from "./xxhash32.js";

/** Store name, and the file's name under `web/vendor/tables/`. */
export const ORIGINAL_TABLES = [
  { name: "Prim.", file: "Prim.wav" },
  { name: "Harm.", file: "Harm.wav" },
] as const;

export type OriginalTableName = (typeof ORIGINAL_TABLES)[number]["name"];

const WAVES = 16;
const POINTS = 512;
const RATE = 48_000;
const POOL_LAST = 127;

/** The store slot holding this name, in the listing given. */
export function originalTableSlot(
  store: readonly StoreSlotFacts[],
  name: OriginalTableName,
): number | undefined {
  return store.find((slot) => slot.occupied && slot.name?.trim() === name)?.slot;
}

/** The originals the listing does not hold, in install order. */
export function missingOriginalTables(
  store: readonly StoreSlotFacts[],
): (typeof ORIGINAL_TABLES)[number][] {
  return ORIGINAL_TABLES.filter((table) => originalTableSlot(store, table.name) === undefined);
}

/** The lowest free store slots, skipping any slot something else has claimed. */
export function freeStoreSlots(
  store: readonly StoreSlotFacts[],
  count: number,
  claimed: ReadonlySet<number> = new Set(),
): number[] {
  const free = store
    .filter((slot) => !slot.occupied && !claimed.has(slot.slot))
    .map((slot) => slot.slot);
  if (free.length < count) {
    throw new WaveriderError(
      `The store has ${free.length} free slot(s), and ${count} are needed. Delete a table first.`,
    );
  }
  return free.slice(0, count);
}

/** One original table, ready to write to `slot`. Refuses a file that is not the expected shape. */
export function originalTablePending(name: string, wav: Uint8Array, slot: number): PendingSlot {
  const audio = readWavFile(wav);
  const channel = audio.channels[0];
  const samples = WAVES * POINTS;
  if (
    audio.channels.length !== 1 ||
    audio.sampleRate !== RATE ||
    audio.format !== "16 bit PCM" ||
    channel?.length !== samples
  ) {
    throw new WaveriderError(
      `${name} must be mono 16-bit ${RATE} Hz with ${samples} samples, and this file is not.`,
    );
  }

  const table = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const word = Math.round(channel[i]! * 0x8000) & 0xffff;
    table[i * 2] = word >>> 8;
    table[i * 2 + 1] = word & 0xff;
  }
  return {
    slot,
    name,
    waves: WAVES,
    points: POINTS,
    interpolate: true,
    table,
    sourceHash: xxHash32(wav),
    sourceSize: wav.length,
    gain: 1,
  };
}

/**
 * The pool that keeps an older project's saved `TBL` values on the tables they played.
 *
 * Older builds: coarse 0 and 1 are Prim. and Harm., and coarse `c >= 2` is pool index `c - 2`.
 * A pool-only build: coarse 0 is silence, and coarse `c >= 1` is pool index `c - 1`. So Harm. at
 * index 0 and everything else up one keeps every value but 0. Coarse 0 stays silent, because only
 * a rewrite of the project's sounds could change it.
 *
 * **Nothing marks a pool as older than this**, and on a newer project this moves every sound to a
 * different table. A caller runs it only on an explicit, confirmed request. Harm. already at
 * index 0 is refused, which stops the same press from shifting a project twice.
 */
export function keepOldTblValues(
  entries: readonly (number | undefined)[],
  harmSlot: number,
): (number | undefined)[] {
  if (entries[0] === harmSlot) {
    throw new WaveriderError("Pool slot 1 already holds Harm., so nothing moves.");
  }
  if (entries[POOL_LAST] !== undefined) {
    throw new WaveriderError(
      `Pool slot ${POOL_LAST + 1} holds a table, so the pool cannot move up. Remove that table first.`,
    );
  }
  return [harmSlot, ...entries.slice(0, POOL_LAST)];
}

/** What a sound plays when its `TBL` number names no table, for use in a sentence. */
export function emptyEntryPlays(poolOnly: boolean): string {
  return poolOnly ? "nothing" : "the built-in Prim.";
}
