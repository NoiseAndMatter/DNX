/**
 * Deciding which library rows to show — and **nothing else**.
 *
 * No DOM, no device, no state. A bank is up to 256 presets and the whole point of the table is to
 * find one of them, so the finding has to be answerable in a test rather than by scrolling a list
 * on screen and believing it.
 *
 * ## Tags compound, they do not accumulate
 *
 * Asked for as *"cummulative, so you can toggle multiple tags to compound a filter"*. That is
 * **AND**: two tags selected means rows carrying both, not rows carrying either. OR would grow the
 * result as you click, which is the opposite of what a filter is for — every click should narrow.
 *
 * ## A row whose tags have not been read is neither in nor out
 *
 * The listing gives a name, an index and a size. **Tags live in the object**, so knowing them means
 * reading each slot's body — up to 256 reads for one bank. Those arrive over seconds, which leaves
 * a window where a tag filter is being applied to rows nobody has read.
 *
 * Both obvious answers are lies:
 *
 * - **Hide them**, and the list starts empty and fills up, so an early answer of "nothing matches"
 *   is wrong and looks authoritative.
 * - **Show them**, and rows that will turn out not to match are presented as matches.
 *
 * So they are counted separately and returned as `unknown`. The page says *"9 match, 47 not read
 * yet"*, which is the true statement, and the number falls to zero as the reads land. This is the
 * one design decision in this module and it is why the return type is not an array.
 *
 * **An empty slot is not one of them.** It has no tags because there is nothing in it, not because
 * nobody has looked — so it fails a tag filter outright rather than counting as unread. Without
 * that distinction the number includes the ~200 free slots of a 256-slot bank and never reaches
 * zero, which is worse than not showing it.
 *
 * ## The same hazard, one level up: which tags are still reachable
 *
 * `tagOffers` answers what the cloud should offer once something is selected, and it inherits the
 * problem whole. A tag looks unreachable when no remaining row carries it, and during a bank's
 * read that is indistinguishable from *the rows carrying it have not been read yet*. So nothing is
 * dimmed while a single row is unread, and the counts say so rather than growing in silence.
 */

import { type TagName } from "@noiseandmatter/dnx-core/project/tags.js";

/** One slot, as the table shows it. */
export interface LibraryRow {
  index: number;
  name: string;
  occupied: boolean;
  /** The device protects saved work, so this is not the inverse of `occupied`. */
  writable: boolean;
  /** The object's size from the listing — constant across a collection. */
  size: number;
  /**
   * Undefined until the slot's body has been read.
   *
   * Distinct from `[]`, which means read and genuinely untagged. Collapsing the two would make an
   * untagged preset indistinguishable from one nobody has looked at.
   */
  tags?: readonly TagName[];
  /** The machine name, from the same read as the tags. */
  machine?: string;
}

export interface LibraryFilter {
  /** The omnibox. Space-separated terms, all of which must match somewhere. */
  query: string;
  /** Tags a row must carry **all** of. */
  tags: readonly TagName[];
  /** Hide free slots. */
  occupiedOnly: boolean;
}

export const NO_FILTER: LibraryFilter = { query: "", tags: [], occupiedOnly: false };

export interface FilterResult {
  rows: LibraryRow[];
  /**
   * Rows a tag filter could not be applied to, because their tags have not been read.
   *
   * Zero whenever no tag is selected — an unread row is only *unknown* with respect to a question
   * somebody asked.
   */
  unknown: number;
}

/**
 * Everything about a row that the omnibox can match.
 *
 * Occupancy is searchable as words because that is how somebody would ask for it — typing "free"
 * to find empty slots is the obvious move, and a filter that ignored it would look broken. The
 * index is included as bare digits so "12" finds slot 12.
 */
function haystack(row: LibraryRow): string {
  return [
    row.name,
    String(row.index),
    row.machine ?? "",
    ...(row.tags ?? []),
    row.occupied ? "saved" : "free",
    row.writable ? "" : "protected",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Apply a filter.
 *
 * Order is deliberate: occupancy, then text, then tags. The tag test is last because it is the only
 * one that can be *unanswerable*, and a row already excluded by its name should not be counted as
 * an unread unknown — that number is meant to say "there is more to find here", and inflating it
 * with rows nobody wanted makes it useless.
 */
export function filterRows(rows: readonly LibraryRow[], filter: LibraryFilter): FilterResult {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);

  const out: LibraryRow[] = [];
  let unknown = 0;

  for (const row of rows) {
    if (filter.occupiedOnly && !row.occupied) continue;

    if (terms.length > 0) {
      const text = haystack(row);
      if (!terms.every((t) => text.includes(t))) continue;
    }

    if (filter.tags.length > 0) {
      // **An empty slot is not unread, it is empty.** There is nothing in it to read and never will
      // be, so it fails a tag filter outright. Counting it as unknown was the first version, and it
      // put ~200 of a 256-slot bank into a number meant to say "there is more to find here" — which
      // would never have reached zero, on any bank, however long the reads ran.
      if (!row.occupied) continue;

      // Captured, because narrowing a property does not survive into a callback — and the `!`
      // that would silence it is the assertion this codebase spends its comments avoiding.
      const carried = row.tags;
      if (carried === undefined) {
        unknown++;
        continue;
      }
      if (!filter.tags.every((t) => carried.includes(t))) continue;
    }

    out.push(row);
  }

  return { rows: out, unknown };
}

/**
 * Toggle one tag in a selection.
 *
 * Here rather than in the page because "already selected" has to mean the same thing to the button
 * that draws itself pressed and to the filter that uses it, and two answers to that is how a
 * toggle ends up looking on while filtering as off.
 */
export function toggleTag(tags: readonly TagName[], tag: TagName): TagName[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
}

/** One tag chip, as the cloud should draw it. */
export interface TagOffer {
  tag: TagName;
  /**
   * Rows that would remain with this tag applied **on top of the current selection**.
   *
   * Not the number of rows carrying the tag. With KICK already chosen, `SOFT 1` means one row is
   * both, which is what pressing SOFT would leave. A selected chip therefore shows the size of the
   * result on screen, because it is already part of it.
   *
   * The count before this was the number of rows carrying the tag with the selection ignored, so a
   * second chip promised 12 and delivered 2. That was defensible while chips did not compound;
   * they compound now, and the number has to answer the same question the click does.
   */
  count: number;
  /** In the current selection, so the chip draws pressed. */
  selected: boolean;
  /**
   * Whether pressing it does anything. A chip that is not available is dimmed and disabled.
   *
   * True for a selected tag whatever its count: pressing it removes it, which always widens the
   * result, and a filter you cannot undo is a trap. True as well while any row is unread, see
   * below.
   */
  available: boolean;
}

export interface TagOffers {
  /** Selected tags first, in the order they were chosen, then by what each would leave. */
  offers: TagOffer[];
  /**
   * Occupied rows the tag question cannot be put to yet, because their bodies have not been read.
   *
   * **While this is above zero nothing is dimmed.** A tag can look unreachable purely because the
   * slots carrying it are among the unread, and dimming on that is a lie the page would tell with
   * a straight face: the chip greys out, the reads land, and it silently becomes reachable with
   * nobody watching. The counts are undercounts for the same reason, so the page marks them as
   * provisional rather than presenting a number that will quietly grow.
   *
   * The same distinction `filterRows` draws, asked of the tag cloud instead of the table: an empty
   * slot is not unread, it is empty, and it is not counted here.
   */
  unread: number;
}

/**
 * Which tags to offer, what each would leave, and which of them still lead anywhere.
 *
 * Asked for as *"picking a tag narrows the list, and the tag cloud then shows the tags still
 * reachable"*. A cloud that goes on offering KICK after PAD has been chosen sends somebody
 * clicking to find an empty table, and the bank is 256 presets, so that is the whole question the
 * cloud exists to answer.
 *
 * **Dimmed, not removed.** A chip that vanished would move the ones beside it under the pointer,
 * and the cloud is also a map of what this bank holds. Unreachable tags stay where they are and
 * stop responding.
 *
 * Tags nothing in the bank carries are still omitted entirely: the vocabulary is 32 values and a
 * bank uses a handful, so listing all of them would bury the live ones behind two rows of dead
 * buttons. What is offered is what the rows surviving the omnibox actually carry, plus whatever is
 * selected, which must be offered even when it has narrowed the result to nothing.
 */
export function tagOffers(rows: readonly LibraryRow[], filter: LibraryFilter): TagOffers {
  // The pool a tag is offered against: everything the omnibox and the used-only box keep, with the
  // tag selection lifted. Counting against the whole bank instead would promise 40 and deliver 2
  // as soon as anything else was set.
  const pool = filterRows(rows, { ...filter, tags: [] }).rows;
  const selected = new Set(filter.tags);

  const counts = new Map<TagName, number>();
  const carriedHere = new Set<TagName>();
  let unread = 0;

  for (const row of pool) {
    // A free slot never survives a tag filter, so it is neither a candidate nor an unknown. Every
    // offer implies at least one tag applied.
    if (!row.occupied) continue;

    // Captured, because narrowing a property does not survive into a callback.
    const carried = row.tags;
    if (carried === undefined) {
      unread++;
      continue;
    }

    for (const tag of carried) carriedHere.add(tag);

    // Only rows the current selection keeps can contribute to what a further tag would leave.
    if (!filter.tags.every((t) => carried.includes(t))) continue;
    for (const tag of carried) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const offer = (tag: TagName): TagOffer => {
    const count = counts.get(tag) ?? 0;
    const isSelected = selected.has(tag);
    return { tag, count, selected: isSelected, available: isSelected || count > 0 || unread > 0 };
  };

  const rest = [...carriedHere]
    .filter((tag) => !selected.has(tag))
    .map(offer)
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return { offers: [...filter.tags.map(offer), ...rest], unread };
}
