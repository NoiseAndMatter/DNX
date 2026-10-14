/**
 * A project's pool as a pane shows it: one cell per pool index, joined to the store's listing.
 *
 * **One job: the join.** `poolfile.ts` reads the record and `pool.ts` says what the DSP will play.
 * Neither can say what a *person* needs to see, because that needs both the record and a listing of
 * the store taken at the same moment — and the interesting states only exist in the gap between
 * them.
 *
 * No DOM, so the rules below are testable without a browser, and the CLI can print the same pane.
 *
 * ## The state that only exists in the join: MISSING
 *
 * An entry holds a store slot and nothing else. Delete that table and the entry still names the
 * slot, so the pool index plays the built-in Prim. — audibly wrong, and nothing in the record says
 * why. That is **MISSING**, and the rules were settled with the firmware session on 2026-10-06:
 *
 * | | |
 * |---|---|
 * | an entry naming a free store slot | reads **MISSING**, never as empty |
 * | the free count | **excludes** it — the slot is spoken for |
 * | freeing it | the user's choice, never DNX's repair |
 *
 * The firmware's own wavetable page briefly cleared a deleted slot's entry and that was reverted,
 * for a reason worth keeping: **ADD TO POOL fills the first free entry**, so clearing entry `j`
 * digs a hole the next add falls into, and every sound still pointing at pool index `j` then plays
 * an unrelated new table. A dangling entry plays Prim., which is obviously wrong and sends somebody
 * looking. A wrong table is plausible and may never be noticed.
 *
 * ## Two warnings that must not collapse into one
 *
 * An entry naming a **free** slot is *missing*. An entry naming a **stored** table of the wrong
 * geometry is stored, silent and unplayable, which is `unplayableReason`. A pane that merges them
 * tells somebody to re-import a table that is already there.
 *
 * This module can only report the first. **Geometry is not in a listing** — `/waverider` reports
 * every slot's size as the fixed 512 KiB extent — so judging playability costs one file read per
 * slot, and a cell says *stored* rather than claiming *playable*.
 *
 * ## Whether anybody wrote this pool changes what the numbers mean
 *
 * A project with no record of its own follows the store, and the firmware answers a read
 * of `/wavepool/<p>` with the entries it would synthesise. They are real — that is what the project
 * plays — but **an upload moves them**: a table landing in a free store slot below the others
 * shifts every later pool index, and every sound keeps its old coarse value. So `authored` is on
 * the summary, and a pane that does not say which it is has told somebody their pool is pinned when
 * it is not.
 */

import { POOL_ENTRIES, FIRST_POOL_TBL } from "./pool.js";
import { type PoolRecord, poolState } from "./poolfile.js";

/** How a pool index reads. */
export type PoolCellState =
  /** No entry. ADD TO POOL would fill the first of these. */
  | "empty"
  /** An entry naming a store slot that holds a table. */
  | "table"
  /** An entry naming a store slot that is free: the table was deleted. Plays Prim. */
  | "missing";

/** What this module needs from a `/waverider` listing. Deliberately not the device's `Entry`. */
export interface StoreSlotFacts {
  slot: number;
  /** As the listing gives it. Absent where the slot is free. */
  name?: string;
  occupied: boolean;
}

export interface PoolCell {
  /** Pool index, `0..127`: what the record holds. */
  index: number;
  /** `index + 1`: what both UIs display. The built-ins sit outside this numbering. */
  shown: number;
  /**
   * `2 + index`: what a sound **stores** in TBL1 / TBL2. See 8w on the three numbers.
   *
   * Not what the instrument shows. Its cell reads `coarse - 1`, which is `shown` — so anything
   * put in front of a person uses `shown`, and this is for bytes.
   */
  coarse: number;
  /** The store slot this entry names, absent on an empty cell. */
  storeSlot?: number;
  /** The table's name, from the listing. Absent on an empty cell **and on a missing one**. */
  name?: string;
  state: PoolCellState;
  /** Why this cell is worth a word, for the one or two that are. */
  note?: string;
}

export interface PoolSummary {
  projectSlot: number;
  /** `empty` no record and nothing plays, `follows-store` every stored table, `list` these slots. */
  kind: ReturnType<typeof poolState>;
  /**
   * Somebody wrote this pool, so its indices are pinned.
   *
   * False for `follows-store`, where an upload into a lower store slot moves every later index and
   * the sounds do not follow, and for `empty`, where there is nothing to pin.
   */
  authored: boolean;
  cells: PoolCell[];
  /** Entries naming a store slot that holds a table. */
  tables: number;
  /** Entries naming a free store slot. **Not free**, and not counted as tables either. */
  missing: number;
  /** Entries with nothing in them. Excludes `missing`, which is the whole point. */
  free: number;
  /** Which pool indices name each store slot, for the store list's own column. */
  byStoreSlot: Map<number, number[]>;
  /** Store slots named by more than one index. Legal, and worth showing. */
  repeated: number[];
}

/**
 * Join a pool record to a listing of the store.
 *
 * `store` is a listing taken at the same time as the record. One taken earlier is what makes a
 * MISSING cell appear that is not there, so a caller reads both in the same pass.
 */
export function summarisePool(
  record: PoolRecord,
  store: readonly StoreSlotFacts[],
): PoolSummary {
  const facts = new Map(store.map((slot) => [slot.slot, slot]));
  const kind = poolState(record);

  const cells: PoolCell[] = [];
  const byStoreSlot = new Map<number, number[]>();
  let tables = 0;
  let missing = 0;

  for (let index = 0; index < POOL_ENTRIES; index++) {
    const shown = index + 1;
    const coarse = FIRST_POOL_TBL + index;
    const storeSlot = record.entries[index];

    if (storeSlot === undefined) {
      cells.push({ index, shown, coarse, state: "empty" });
      continue;
    }

    byStoreSlot.set(storeSlot, [...(byStoreSlot.get(storeSlot) ?? []), index]);

    const fact = facts.get(storeSlot);
    /*
     * **A slot absent from the listing is not a free slot.** A short listing and a deleted table
     * would otherwise read the same, and one of those is a reason to tell somebody their sound is
     * broken. `/waverider` lists all 256, so absence means the listing was cut.
     */
    if (fact === undefined) {
      missing++;
      cells.push({
        index, shown, coarse, storeSlot, state: "missing",
        note: `store slot ${storeSlot} is not in the listing, so what it holds is not known`,
      });
      continue;
    }

    if (!fact.occupied) {
      missing++;
      cells.push({
        index, shown, coarse, storeSlot, state: "missing",
        note: `store slot ${storeSlot} is empty: the table is missing from the +Drive.`,
      });
      continue;
    }

    tables++;
    cells.push({
      index, shown, coarse, storeSlot, state: "table",
      ...(fact.name === undefined ? {} : { name: fact.name }),
    });
  }

  return {
    projectSlot: record.projectSlot,
    kind,
    authored: kind === "list",
    cells,
    tables,
    missing,
    free: POOL_ENTRIES - tables - missing,
    byStoreSlot,
    repeated: [...byStoreSlot.entries()]
      .filter(([, indices]) => indices.length > 1)
      .map(([slot]) => slot)
      .sort((a, b) => a - b),
  };
}

/**
 * What the instrument's **TBL** cell reads for a pool index: `T:001` to `T:128`.
 *
 * **One place, because the arithmetic has already been got wrong once.** The value a sound stores
 * is `index + 2`; the unit displays `stored - 1` as `T:%03d`, which is the shown slot — so the
 * number on screen is the pool slot and nothing has to be added to it. DNX's help told people to
 * add one from the day it was written until the firmware session checked `csrc/waverider/page.c`
 * on 2026-10-13.
 *
 * Below `T:001` are the two built-ins, which read `PRIM` and `HARM` rather than numbers.
 */
export function tblLabel(index: number): string {
  return `T:${String(index + 1).padStart(3, "0")}`;
}

/**
 * The line above the grid: which kind of pool this is, and the counts.
 *
 * **A summary, not a lesson.** It used to explain what following the store does to a sound's TBL
 * when a table is written below it — three sentences of behaviour that is the firmware's, and
 * which the help already covers under *Three kinds of pool*. The owner's rule, 2026-10-14: the UI
 * states what is true and the help explains it, so this says the kind and the numbers and stops.
 *
 * Here rather than in the page because it is the one place the three kinds are put into words, and
 * a second wording would eventually disagree with this one about what following the store means.
 */
export function describePool(summary: PoolSummary): string {
  const where = summary.projectSlot === 0 ? "the working project" : `project slot ${summary.projectSlot}`;
  const counts =
    `${summary.tables} table(s), ${summary.free} free` +
    (summary.missing === 0 ? "" : `, ${summary.missing} missing`);

  switch (summary.kind) {
    // **Said rather than left to the counts.** A project with no record of its own plays nothing,
    // and "0 table(s), 128 free" alone reads as an empty pool somebody could fill rather than as
    // silence. The owner separated this from follows-the-store on 2026-10-13.
    case "empty":
      return `${where} — no pool of its own, so it plays no wavetables. ${counts}.`;
    case "follows-store":
      return `${where} — follows the store. ${counts}.`;
    default:
      return `${where} — a pool of its own. ${counts}.`;
  }
}
