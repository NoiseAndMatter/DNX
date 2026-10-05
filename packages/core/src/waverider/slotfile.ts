/**
 * The bytes of `/waverider/<n>`: an index entry and its table, in an Elektron container.
 *
 * **One job: the file a slot is read and written as.** Where a table sits on the card is
 * `layout.ts`, what an entry means is `entries.ts`, which arrangements are safe is `validate.ts`,
 * and the whole-store rewrite is `plan.ts`. This is the single-slot form the Data API moves, and it
 * is the only thing on this route that goes over the wire.
 *
 * Agreed with the firmware session on 2026-10-05 and traced in their emulator, read and write:
 *
 * ```
 * container header 31 B      kind 0x57, store version 1, index n, length = 128 + table, raw
 * index entry      128 B     the same record the store's index holds
 * table            n B       int16 big-endian, at most a slot
 * trailer          12 B      CRC-32 seeded zero over the body, the body length, AA A1 DA AA
 * ```
 *
 * ## The entry travels with its table
 *
 * A slot file carries its own index entry, so one write delivers the geometry, the name, the gain
 * and the hash alongside the samples. The device copies the entry into the group's index and the
 * table into the slot's extent, which is why a write is one file rather than a plan.
 *
 * `plan.ts` still exists and is still the right thing for a whole-store rewrite from DNX's master
 * copy. This is the incremental path: one slot, one file, the device doing the index write.
 *
 * ## The hash is recomputed, never accepted
 *
 * `buildSlotFile` takes the table and the metadata rather than a finished `TableEntry`, and
 * computes `tableHash` from the table it is given. **This is a safety property, not tidiness.**
 *
 * The device cannot reject a bad write. The stock session decides the `0x59` commit reply before it
 * calls the store's commit callback and ignores what the callback returns, so an entry whose hash
 * does not match its table gets `commit ok` and **writes nothing** — measured on slot 9, which
 * committed successfully and never appeared in a listing. An entry handed in with a stale hash is
 * the one input that would pass every local check and then silently do nothing while reporting
 * success, so it is not an input.
 *
 * ## Raw, and why that matters here
 *
 * The body is never compressed: `0x1D` is `0`. The device's reader returns the raw bytes and its
 * writer takes what the reader returns, so a slot round-trips unchanged. `storagewrite.ts` knows
 * this as `STORED_FORM_BY_ROOT`, and `readFormOption` is what keeps a verify reading the same form
 * it wrote.
 */

import { type TableEntry, FORMAT_INT16_BE, readEntry, writeEntry } from "./entries.js";
import { WaveriderError } from "./errors.js";
import { ENTRY_BYTES, INDEX_ENTRIES, SLOT_BYTES, slotSector } from "./layout.js";
import { xxHash32 } from "./xxhash32.js";
import {
  CONTAINER_MAGIC,
  HEAD,
  HEADER_BYTES,
  TRAILER_BYTES,
  buildContainer,
  containerIsCompressed,
  containerObjectVersion,
  contentKind,
} from "../project/container.js";

/**
 * `0x0D` for a Waverider slot: `'W'`, and deliberately clear of Elektron's own values.
 *
 * Theirs are small odd integers — 1 project, 3 soundbank or sound or preset, 5 kit — so a fourth
 * would plausibly be 7 or 9. `0x57` is not next in that sequence, which is the point of it.
 *
 * The firmware checks it at the first chunk: *"the file is not a Waverider table (container kind)"*.
 */
export const CONTENT_KIND_WAVETABLE = 0x57;

/**
 * `0x11`: the **store format** version, which is this file's own and not a project's.
 *
 * Same field position as a project's object version, different namespace. OS 1.11's `/projects`
 * validator refuses an object version above 5, and that ceiling says nothing about this route: the
 * store is at format 1 and the firmware refuses anything else as an unknown store format version.
 */
export const STORE_FORMAT_VERSION = 1;

/** The four ASCII at `0x09`, as the firmware's own writer emits them. */
export const FORMAT_VERSION = "0059";

/** A table and everything the index records about it, with the hash left to this module. */
export interface PendingSlot {
  slot: number;
  name: string;
  waves: number;
  points: number;
  interpolate: boolean;
  /** Converted samples. See `convert.ts`. */
  table: Uint8Array;
  /** xxHash32 of the file the table was made from, for recognising a re-import. */
  sourceHash: number;
  sourceSize: number;
  /** The level change the conversion applied, `1 / peak`. */
  gain: number;
  sampleFormat?: number;
}

/** What a slot file turned out to hold. */
export interface SlotFile {
  entry: TableEntry;
  table: Uint8Array;
}

/**
 * Build the file for one slot.
 *
 * Refuses everything the firmware refuses, before the wire, and for the reason in this module's
 * note: a commit cannot say no. The geometry has to measure the table, the table has to fit a
 * slot, and the entry's extent is the slot's own.
 */
export function buildSlotFile(pending: PendingSlot): Uint8Array {
  const { slot, name, waves, points, table } = pending;
  const sampleFormat = pending.sampleFormat ?? FORMAT_INT16_BE;

  if (!Number.isInteger(slot) || slot < 0 || slot >= INDEX_ENTRIES) {
    throw new WaveriderError(`slot ${slot} is outside 0..${INDEX_ENTRIES - 1}`);
  }
  if (table.length === 0) throw new WaveriderError(`slot ${slot} (${name}) has an empty table`);
  if (table.length > SLOT_BYTES) {
    throw new WaveriderError(
      `slot ${slot} (${name}) is ${table.length} bytes and a slot holds ${SLOT_BYTES}. A table ` +
        `that large needs a new sample format, not a bigger file.`,
    );
  }
  if (waves <= 0 || points <= 0) {
    throw new WaveriderError(`slot ${slot} (${name}): geometry is ${waves} x ${points}`);
  }
  // The geometry is what the player cuts the table up with, so one that does not measure it is a
  // table that will be read as something else entirely.
  if (sampleFormat === FORMAT_INT16_BE && waves * points * 2 !== table.length) {
    throw new WaveriderError(
      `slot ${slot} (${name}): ${waves} waves x ${points} points of int16 is ${waves * points * 2} ` +
        `bytes, and the table is ${table.length}`,
    );
  }

  const entry: TableEntry = {
    slot,
    name,
    waves,
    points,
    sampleFormat,
    interpolate: pending.interpolate,
    startSector: slotSector(slot),
    byteLength: table.length,
    // **Computed here, never passed in.** See this module's note on the commit that cannot refuse.
    tableHash: xxHash32(table),
    sourceHash: pending.sourceHash,
    sourceSize: pending.sourceSize,
    gain: pending.gain,
  };

  const body = new Uint8Array(ENTRY_BYTES + table.length);
  body.set(writeEntry(entry), 0);
  body.set(table, ENTRY_BYTES);

  return buildContainer({
    body,
    contentKind: CONTENT_KIND_WAVETABLE,
    objectVersion: STORE_FORMAT_VERSION,
    // Bank zero, slot in the low byte. The device stamps this itself and does not check what
    // arrives, so sending `n` is what makes a byte-exact verify compare equal.
    index: slot,
    formatVersion: FORMAT_VERSION,
  });
}

/**
 * Read a slot file back, refusing anything that is not one.
 *
 * This is what a verify compares against, so it checks the entry against the table rather than
 * trusting either: a file whose recorded hash does not match its own bytes is not a file DNX
 * wrote, and saying so here is cheaper than a silent round trip that happens to agree.
 */
export function readSlotFile(bytes: Uint8Array): SlotFile {
  if (bytes.length < HEADER_BYTES + ENTRY_BYTES + TRAILER_BYTES) {
    throw new WaveriderError(`a slot file is at least ${HEADER_BYTES + ENTRY_BYTES + TRAILER_BYTES} bytes, this is ${bytes.length}`);
  }
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (bytes[i] !== CONTAINER_MAGIC[i]) throw new WaveriderError("not an Elektron container");
  }
  const kind = contentKind(bytes);
  if (kind !== CONTENT_KIND_WAVETABLE) {
    throw new WaveriderError(
      `content kind 0x${(kind ?? 0).toString(16)} is not a Waverider table's 0x${CONTENT_KIND_WAVETABLE.toString(16)}`,
    );
  }
  const version = containerObjectVersion(bytes);
  if (version !== STORE_FORMAT_VERSION) {
    throw new WaveriderError(`store format version ${version} is not ${STORE_FORMAT_VERSION}`);
  }
  if (containerIsCompressed(bytes) !== false) {
    throw new WaveriderError("the body must be raw; this one says it is an LZ4 chain");
  }

  const body = bytes.subarray(HEADER_BYTES, bytes.length - TRAILER_BYTES);
  const slot = bytes[HEAD.index + 3]!;
  const entry = readEntry(body.subarray(0, ENTRY_BYTES), 0);
  if (entry === undefined) throw new WaveriderError(`slot ${slot}: the index entry is not in use`);

  const table = body.subarray(ENTRY_BYTES);
  if (entry.byteLength !== table.length) {
    throw new WaveriderError(
      `slot ${slot} (${entry.name}): the entry says ${entry.byteLength} bytes and the file carries ${table.length}`,
    );
  }
  if (entry.tableHash !== xxHash32(table)) {
    throw new WaveriderError(
      `slot ${slot} (${entry.name}): the entry's table hash does not match the table it arrived with`,
    );
  }

  // `readEntry` reads a record out of an index and takes its slot from the position. Here the
  // position is zero and the slot is the container's stamped index, so it is put back.
  return { entry: { ...entry, slot }, table };
}
