/**
 * What makes a set of index entries safe to write.
 *
 * **One job: judging, not encoding.** `entries.ts` knows what an entry is; this knows which
 * arrangements of them the firmware must never be asked to read. They are separate because they
 * change for different reasons — the record layout is fixed by the shared document, and these
 * rules grow every time somebody finds a new way to produce a bad extent.
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
import { DATA_END, DATA_START, EXTENT_ALIGN, INDEX_ENTRIES, sectorsFor } from "./layout.js";

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

    if (entry.startSector % EXTENT_ALIGN !== 0) {
      throw new WaveriderError(
        `${where}: starts at sector ${entry.startSector}, which is not on the ${EXTENT_ALIGN}-sector boundary`,
      );
    }
    if (entry.startSector < DATA_START) {
      throw new WaveriderError(
        `${where}: starts at sector ${entry.startSector}, inside the superblocks and indexes below ${DATA_START}`,
      );
    }
    const end = entry.startSector + sectorsFor(entry.byteLength);
    if (end > DATA_END) {
      throw new WaveriderError(`${where}: ends at sector ${end}, past the region's ${DATA_END}`);
    }
  }

  // Overlap, checked across the set rather than per entry, because it is the only rule that is
  // about a pair. Sorted by start so the report names the two that actually collide.
  const byStart = [...entries].sort((x, y) => x.startSector - y.startSector);
  for (let i = 1; i < byStart.length; i++) {
    const before = byStart[i - 1]!;
    const after = byStart[i]!;
    const beforeEnd = before.startSector + sectorsFor(before.byteLength);
    if (after.startSector < beforeEnd) {
      throw new WaveriderError(
        `slot ${before.slot} occupies sectors ${before.startSector}..${beforeEnd - 1} and slot ` +
          `${after.slot} starts at ${after.startSector}: the two extents overlap`,
      );
    }
  }
}
