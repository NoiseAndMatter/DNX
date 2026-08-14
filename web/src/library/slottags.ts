/**
 * Reading the tags off a bank, one slot at a time, without freezing the page.
 *
 * ## Why this is a whole module
 *
 * A `0x53` listing gives a name, an index, an occupancy flag and a size. **It does not give tags.**
 * Tags live at `+8` of the sound object, which means reading each slot's body: up to 256 round
 * trips for one bank, against an instrument that answers a 407-byte preset in about 16 ms.
 *
 * That is seconds, not milliseconds, and it is the difference between a table that appears and a
 * table that arrives. So the reads are:
 *
 * - **after the fact.** The table renders from the listing immediately, with a tag column that
 *   fills in. Nobody waits for a column to look at a name.
 * - **abandonable.** Switching banks mid-read must stop the old one, or two runs fight over the
 *   same transport and the second bank's rows are filled with the first bank's tags. Generation
 *   counting rather than cancellation tokens, because the transport has no notion of abandoning a
 *   request already sent — the reply is simply ignored on arrival.
 * - **skipped for empty slots**, which is most of a bank. Reading 200 free slots to learn they
 *   have no tags would be most of the time spent.
 *
 * ## Failures are per slot, and are not fatal
 *
 * One unreadable slot must not stop the other 255 — the same lesson the dump reader paid for. A
 * slot that fails is left with `tags` undefined, which is exactly the state it was already in and
 * which the filter already knows how to describe.
 */

import { type ApiTransport } from "../../../src/device/storagesession.js";
import { type LibraryKind, readLibraryObject } from "../../../src/device/library.js";
import { type TagName, decodeTags } from "../../../src/project/tags.js";
import { SOUND_MACHINE_OFFSET, machineName } from "../../../src/project/machine.js";

/** Where the tag bitfield sits in a sound object. `docs/` has the derivation of the table itself. */
const TAG_BITS_OFFSET = 8;

/**
 * Ids one slot's read may consume: open, its chunks, close.
 *
 * A preset is 407 bytes and arrives in two chunks, so four is comfortable. It must be a **ceiling**
 * rather than a measurement — running past it puts the next slot's requests on ids this one is
 * still waiting on.
 */
const IDS_PER_SLOT = 8;

export interface SlotTags {
  index: number;
  tags: TagName[];
  machine: string | undefined;
}

export interface ReadTagsOptions {
  transport: ApiTransport;
  kind: LibraryKind;
  bank: string;
  /** Occupied slots only — the caller filters, because it holds the listing. */
  indices: readonly number[];
  /** Called as each slot lands, so the table can fill in rather than appear at the end. */
  onSlot: (slot: SlotTags) => void;
  /** Return false to stop. Checked before every read, so switching bank abandons within one slot. */
  keepGoing: () => boolean;
  msgId?: number;
}

/**
 * Read the tags for a list of slots.
 *
 * Resolves when the run finishes or is abandoned; the results arrive through `onSlot` rather than
 * in the return value, because the point is that they are usable before the run is over.
 */
export async function readBankTags(options: ReadTagsOptions): Promise<{ read: number; failed: number }> {
  let read = 0;
  let failed = 0;

  for (const [nth, index] of options.indices.entries()) {
    if (!options.keepGoing()) break;

    try {
      const { object } = await readLibraryObject(
        options.transport,
        options.kind,
        options.bank,
        index,
        // **Numbered by position, not by successes.** This advanced with `read`, which only counts
        // slots that worked — so a slot that failed left the next one reusing its ids, and the
        // reply to a request that had already given up could be matched against its successor.
        // The same off-by-one hazard the dump reader names as "a late answer filed against the
        // next step", one level down.
        options.msgId === undefined ? {} : { msgId: options.msgId + nth * IDS_PER_SLOT },
      );

      // **`object`, not `body`.** A Digitone II preset's stored body carries five bytes in front of
      // the sound, so the tag word at +8 of the body is three bytes into something else — and the
      // tag vocabulary is closed, so it would decode to real tag names and look entirely plausible.
      options.onSlot({
        index,
        tags: decodeTags(u32be(object, TAG_BITS_OFFSET)),
        machine: machineName(object[SOUND_MACHINE_OFFSET] ?? -1),
      });
      read++;
    } catch {
      // Left with tags undefined, which is what it already was. One bad slot is not a bad bank.
      failed++;
    }
  }

  return { read, failed };
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}
