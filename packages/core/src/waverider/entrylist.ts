/**
 * A person's way of writing a pool list: `0-77, 0-46, 20, 4, 46`.
 *
 * **One job: text in, entries out.** A pool holds 128 store slots and nobody is typing 128
 * numbers, so the full-pool test — 78 distinct tables, 47 repeats, three chosen ones at the top —
 * has to be expressible in a line somebody can read back and check. That is the whole purpose:
 * **auditable**, not merely short. `0-77, 0-46, 20, 4, 46` can be counted by eye; a button
 * labelled *fill the pool* cannot.
 *
 * It lives in core rather than in the page because the CLI will want it and because a parser with
 * edge cases belongs where a test can reach it without a DOM.
 *
 * ## The grammar, which is three things
 *
 * - **`N`** — store slot `N`, one entry.
 * - **`A-B`** — the slots from `A` to `B`, ascending or descending, one entry each.
 * - **`.`** — one entry holding nothing.
 *
 * Separated by commas or spaces or both. Shorter than the pool is padded with empty entries;
 * longer is refused rather than truncated, because a list that was silently cut is a pool whose
 * last tables are missing for no visible reason.
 *
 * ## Duplicates are allowed, and that is deliberate
 *
 * The instrument skips a table already in the pool. This does not, because a record naming a slot
 * twice is a legal record and the full-pool test needs fifty repeats to reach 128 entries from 78
 * tables. Refusing them here would make the test unwritable.
 *
 * Whether a *user* should be allowed to create one is a question for the pane, which should match
 * the instrument. The same split `entries.ts` makes for the index: the encoder writes what it is
 * given, and the policy lives where somebody can see it.
 */

import { WaveriderError } from "./errors.js";
import { INDEX_ENTRIES } from "./layout.js";
import { POOL_ENTRIES } from "./pool.js";

/** One entry holding nothing, as a person writes it. */
export const EMPTY_TOKEN = ".";

/**
 * Parse a pool list.
 *
 * Returns exactly `POOL_ENTRIES` entries, `undefined` where the pool holds nothing. Throws with a
 * message naming the token at fault, because the caller's next move is to show it to somebody.
 */
export function parseEntryList(text: string): (number | undefined)[] {
  const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
  const entries: (number | undefined)[] = [];

  for (const token of tokens) {
    if (token === EMPTY_TOKEN) {
      entries.push(undefined);
      continue;
    }

    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (const n of [from, to]) {
        if (n >= INDEX_ENTRIES) {
          throw new WaveriderError(
            `"${token}": store slot ${n} is outside 0..${INDEX_ENTRIES - 1}`,
          );
        }
      }
      const step = from <= to ? 1 : -1;
      for (let n = from; ; n += step) {
        entries.push(n);
        if (n === to) break;
      }
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new WaveriderError(
        `"${token}" is not a store slot, a range like 3-9, or "${EMPTY_TOKEN}" for an empty entry`,
      );
    }
    const n = Number(token);
    if (n >= INDEX_ENTRIES) {
      throw new WaveriderError(`store slot ${n} is outside 0..${INDEX_ENTRIES - 1}`);
    }
    entries.push(n);
  }

  if (entries.length > POOL_ENTRIES) {
    throw new WaveriderError(
      `that is ${entries.length} entries and a pool holds ${POOL_ENTRIES}. Refused rather than ` +
        `cut: a list silently truncated is a pool whose last tables are missing for no visible ` +
        `reason.`,
    );
  }

  while (entries.length < POOL_ENTRIES) entries.push(undefined);
  return entries;
}

/** What a parsed list amounts to, for a confirmation somebody has to answer. */
export interface EntryListSummary {
  used: number;
  distinct: number;
  /** Store slots named more than once, ascending. The instrument would have skipped these. */
  repeated: number[];
}

export function summariseEntryList(entries: readonly (number | undefined)[]): EntryListSummary {
  const counts = new Map<number, number>();
  for (const slot of entries) {
    if (slot === undefined) continue;
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  return {
    used: entries.filter((s) => s !== undefined).length,
    distinct: counts.size,
    repeated: [...counts.entries()].filter(([, n]) => n > 1).map(([slot]) => slot).sort((a, b) => a - b),
  };
}

/** One pool entry that differs between two lists, as the pane reports a conflict. */
export interface EntryChange {
  index: number;
  before: number | undefined;
  after: number | undefined;
}

/**
 * What changed between the record we read and the record we found.
 *
 * **The instrument writes several entries in one generation step** — ADD TO POOL places every
 * ticked table at once — so a refused write can cover six additions. Reporting *the pool changed*
 * leaves somebody choosing between reload and overwrite with no idea what overwrite discards.
 */
export function diffEntries(
  before: readonly (number | undefined)[],
  after: readonly (number | undefined)[],
): EntryChange[] {
  const out: EntryChange[] = [];
  const n = Math.max(before.length, after.length);
  for (let index = 0; index < n; index++) {
    if (before[index] !== after[index]) {
      out.push({ index, before: before[index], after: after[index] });
    }
  }
  return out;
}
