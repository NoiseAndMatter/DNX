/**
 * What makes a set of index entries safe to write.
 *
 * **One job: judging, not encoding.** `entries.ts` knows what an entry is; this knows which
 * arrangements of them the firmware must never be asked to read. They are separate because they
 * change for different reasons — the record layout is fixed by the shared document, and these
 * rules change whenever the layout's own rules do.
 *
 * They shrank once already. Alignment, region bounds and overlap between entries were three
 * separate rules while extents were allocated; a fixed per-slot stride made all three impossible
 * and left one — **an entry's extent must be its own slot's**. A rule you can delete by changing
 * the design is worth more than a rule you enforce well.
 *
 * ## Why DNX checks at all when the firmware also does
 *
 * **DNX writes the index, so nothing on the firmware's side can stop a bad one being handed over.**
 * Their reader bounds-checks each extent on its own — a bad index is exactly what a bounded reader
 * exists to survive — but that is the last line, not the first, and a store that fails there has
 * already been written.
 *
 * Every rule names the entry that broke it. "Invalid index" with 256 slots is not a diagnosis.
 */

import { type TableEntry, FORMAT_INT16_BE } from "./entries.js";
import { WaveriderError } from "./errors.js";
import { INDEX_ENTRIES, SLOT_BYTES, slotSector } from "./layout.js";

/**
 * Refuse an index that would describe something the firmware must not be asked to read.
 *
 * **DNX writes the index, so nothing on the firmware's side can stop a bad one being handed over.**
 * Their bounded reader checks each extent on its own anyway — a bad index is exactly what a bounded
 * reader exists to survive — but that is the last line, not the first, and a store that fails
 * there has already been written.
 *
 * Every rule here names the entry that broke it, because "invalid index" with 256 slots is not a
 * diagnosis.
 */
export function validateIndex(entries: readonly TableEntry[]): void {
  const seen = new Set<number>();
  for (const entry of entries) {
    const where = `slot ${entry.slot}${entry.name ? ` (${entry.name})` : ""}`;

    if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= INDEX_ENTRIES) {
      throw new WaveriderError(`${where}: slot is outside 0..${INDEX_ENTRIES - 1}`);
    }
    if (seen.has(entry.slot)) throw new WaveriderError(`${where}: two entries claim this slot`);
    seen.add(entry.slot);

    if (entry.byteLength <= 0) throw new WaveriderError(`${where}: byte length is ${entry.byteLength}`);
    if (entry.waves <= 0 || entry.points <= 0) {
      throw new WaveriderError(`${where}: geometry is ${entry.waves} x ${entry.points}`);
    }
    // The geometry is what the player uses to cut the payload up, so a payload that does not
    // measure what the geometry says is a table that will be read as something else entirely.
    if (entry.sampleFormat === FORMAT_INT16_BE) {
      const expected = entry.waves * entry.points * 2;
      if (entry.byteLength !== expected) {
        throw new WaveriderError(
          `${where}: ${entry.waves} waves x ${entry.points} points of int16 is ${expected} bytes, ` +
            `and the entry says ${entry.byteLength}`,
        );
      }
    }

    /*
     * **The extent is a function of the slot, so this is the only placement rule left.**
     *
     * It replaces three: alignment, bounds, and overlap between entries. All three were real when
     * extents were allocated, and all three are impossible now — a slot's sectors are arithmetic,
     * every slot's range is disjoint from every other's by construction, and the last slot ends on
     * `DATA_END` by definition.
     *
     * Phrased as the device phrases it, so a user who sees both messages sees one vocabulary.
     */
    const expected = slotSector(entry.slot);
    if (entry.startSector !== expected) {
      throw new WaveriderError(
        `${where}: starts at 0x${entry.startSector.toString(16)}, not its own ` +
          `0x${expected.toString(16)}`,
      );
    }
    if (entry.byteLength > SLOT_BYTES) {
      throw new WaveriderError(
        `${where}: ${entry.byteLength} bytes does not fit a slot's ${SLOT_BYTES}`,
      );
    }
  }
}
