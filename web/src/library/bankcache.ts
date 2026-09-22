/**
 * Remembering what a bank held, so switching away and back is free.
 *
 * ## The two costs are not comparable
 *
 * | | round trips | measured |
 * |---|---|---|
 * | listing a bank | **1** | milliseconds |
 * | reading its tags | **256** | ~6 seconds |
 *
 * Every bank switch used to pay both. Cycling A → B → A cost twelve seconds of round trips to
 * learn nothing, and the tag column emptied and refilled each time.
 *
 * ## Re-list always; re-read almost never
 *
 * A cache keyed on the bank letter and held for the session is fast and **wrong**: save a preset on
 * the instrument's front panel and the page keeps showing what was there before, with no way for
 * anyone to find out.
 *
 * So the listing is always fetched — it is one message, and it is the only thing that can tell us
 * anything changed. What it is compared against decides which *bodies* need reading again, and that
 * is where the seconds are. A bank nobody touched re-reads nothing; a bank with one new preset in
 * it re-reads one slot.
 *
 * ## What counts as changed, and what that misses
 *
 * A slot is unchanged if its **name, size, occupancy and writability** all match — the whole of
 * what `LibraryEntry` carries.
 *
 * **This is a proxy, not a proof.** Overwrite a slot with a different preset of the same name and
 * the same size and the listing is identical, so the cached tags survive and are wrong. Nothing in
 * a listing can rule that out — the only thing that could is the body, which is the read being
 * avoided. Hence `Refresh`, which drops the cache for the bank on screen and reads it all again.
 * A stale row is a real possibility here and the honest answer is a button, not a claim.
 *
 * ## The same listing answers "how many are in bank F"
 *
 * Occupancy is in the listing, so once a bank has been listed its count is already here and asking
 * again costs nothing. That is what puts a number on every bank tab rather than on the one being
 * looked at: one round trip a bank, not 256 reads a bank. `bankCounts` reads what is held,
 * `banksToCount` says which banks have not been listed yet, and `rememberListing` stores a listing
 * taken for the count alone.
 *
 * A bank missing from `bankCounts` has not been listed, which is not the same as empty. The tab
 * must not print a zero for it: zero is a measurement and nobody has taken it.
 */

import {
  type LibraryBank,
  type LibraryEntry,
  type LibraryKind,
} from "@noiseandmatter/dnx-core/device/library.js";
import { type TagName } from "@noiseandmatter/dnx-core/project/tags.js";

/** What a body read produced for one slot. */
export interface SlotFacts {
  tags: TagName[];
  machine: string | undefined;
}

/** One bank as it was last seen, and what its slots turned out to hold. */
export interface CachedBank {
  entries: LibraryEntry[];
  facts: Map<number, SlotFacts>;
}

/** Keyed by collection and letter, because `/kits/A` and `/soundbanks/A` are different banks. */
export type BankCache = Map<string, CachedBank>;

export function cacheKey(kind: LibraryKind, bank: string): string {
  return `${kind}/${bank}`;
}

/**
 * Everything about a slot that `LibraryEntry` can tell us.
 *
 * Name, size, occupancy and writability — which is the whole of the type. The raw permission
 * trailer would be a stronger signal, since most of its bits are unassigned and any of them moving
 * is still a change; `listLibraryBank` does not carry it this far, and reaching past the type it
 * publishes to get at one would couple this module to the listing parser for a marginal gain.
 *
 * What that costs is stated where somebody will read it: at the top of this file, and on the
 * Refresh button it argues for.
 */
function fingerprint(entry: LibraryEntry): string {
  return [entry.name, entry.size, entry.occupied, entry.writable].join(" ");
}

export interface CacheDecision {
  /** Slots whose bodies must be read: new, changed, or never read. */
  toRead: number[];
  /** Facts worth keeping, for slots the listing says are untouched. */
  reuse: Map<number, SlotFacts>;
}

/**
 * Decide what a fresh listing means for what we already know.
 *
 * Returns the work rather than doing it, so "which slots changed" is answerable in a test — the
 * alternative is switching banks on a real instrument and counting round trips by eye.
 */
export function planBankRead(
  cached: CachedBank | undefined,
  fresh: LibraryBank,
  options: { force?: boolean } = {},
): CacheDecision {
  const reuse = new Map<number, SlotFacts>();

  // A forced refresh reads everything occupied and keeps nothing. It exists for the case the
  // listing cannot see — a slot overwritten by something of the same name and size.
  if (options.force || !cached) {
    return { toRead: fresh.entries.filter((e) => e.occupied).map((e) => e.index), reuse };
  }

  const before = new Map(cached.entries.map((e) => [e.index, fingerprint(e)]));

  const toRead: number[] = [];
  for (const entry of fresh.entries) {
    // Empty slots are never read: there is nothing in them to have tags. This is the same
    // distinction `filter.ts` draws — empty is an answer, unread is the absence of one.
    if (!entry.occupied) continue;

    const known = cached.facts.get(entry.index);
    if (known !== undefined && before.get(entry.index) === fingerprint(entry)) {
      reuse.set(entry.index, known);
      continue;
    }

    // Changed, new, or occupied-but-never-successfully-read. The last case matters: a slot whose
    // read failed last time has no facts, and must not be treated as cached simply because its
    // listing entry is unchanged.
    toRead.push(entry.index);
  }

  return { toRead, reuse };
}

/** Store what a completed pass learned, so the next visit to this bank can reuse it. */
export function remember(
  cache: BankCache,
  kind: LibraryKind,
  bank: LibraryBank,
  facts: Map<number, SlotFacts>,
): void {
  cache.set(cacheKey(kind, bank.bank), { entries: [...bank.entries], facts: new Map(facts) });
}

/**
 * Store a listing on its own, for a bank whose bodies nobody has read.
 *
 * This is how the other tabs get their counts. The bank on screen arrives through `remember` at the
 * end of its tag read; the seven nobody is looking at arrive here, one listing each.
 *
 * **Facts survive only where the listing says the slot did.** Overwriting the entries while keeping
 * every fact would defeat the fingerprint: a slot renamed on the front panel would come back with a
 * matching entry and its old tags beside it, and `planBankRead` would never ask for it again. So
 * the decision is `planBankRead`'s, which is the module's one answer to "what still holds".
 */
export function rememberListing(cache: BankCache, kind: LibraryKind, bank: LibraryBank): void {
  const { reuse } = planBankRead(cache.get(cacheKey(kind, bank.bank)), bank);
  cache.set(cacheKey(kind, bank.bank), { entries: [...bank.entries], facts: reuse });
}

/** What a listing alone says about a bank. No body is read to learn either number. */
export interface BankCount {
  /** Slots holding a preset or a kit. */
  used: number;
  /**
   * Slots in the bank.
   *
   * From the listing rather than from `BANK_SIZE`, so a collection whose bank size nobody has
   * measured on this device still shows the truth it just read.
   */
  total: number;
}

/**
 * The counts that can honestly go on bank tabs.
 *
 * Only banks with a listing appear. A caller drawing a tab for a letter that is absent must draw no
 * number at all: the alternatives, a zero or a dash, both read as "nothing in this bank" when what
 * is true is "nobody has asked".
 */
export function bankCounts(
  cache: BankCache,
  kind: LibraryKind,
  letters: readonly string[],
): Map<string, BankCount> {
  const out = new Map<string, BankCount>();
  for (const letter of letters) {
    const cached = cache.get(cacheKey(kind, letter));
    if (!cached) continue;
    out.set(letter, {
      used: cached.entries.filter((e) => e.occupied).length,
      total: cached.entries.length,
    });
  }
  return out;
}

/**
 * Which banks still need listing before their tab can say anything.
 *
 * `skip` is the bank on screen, which is being listed anyway and speaks for itself.
 *
 * `force` is `Refresh`. It re-lists the others without dropping what is known about their slots:
 * a listing is one message and it is the only thing that can notice somebody saving a preset on the
 * front panel, while the tags behind it cost 256 reads a bank and are still as good as the
 * fingerprint says they are. So a refresh buys new counts for the price of eight messages and
 * throws away no seconds of reading.
 */
export function banksToCount(
  cache: BankCache,
  kind: LibraryKind,
  letters: readonly string[],
  options: { skip: string; force: boolean },
): string[] {
  return letters.filter(
    (letter) =>
      letter !== options.skip && (options.force || !cache.has(cacheKey(kind, letter))),
  );
}

/** Forget one bank — what `Refresh` does. Forgetting all of them is `cache.clear()`. */
export function forget(cache: BankCache, kind: LibraryKind, bank: string): void {
  cache.delete(cacheKey(kind, bank));
}
