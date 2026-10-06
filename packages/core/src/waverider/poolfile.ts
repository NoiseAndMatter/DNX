/**
 * The bytes of `/wavepool/<project slot>`: one project's wavetable pool, as a 512-byte record.
 *
 * **One job: the file a pool is read and written as.** The counterpart to `slotfile.ts`, and the
 * same shape of module: a payload and the container it travels in. What the DSP will actually play
 * is `pool.ts`, where the record goes on the card is `layout.ts`, and the store's own index is
 * `entries.ts`.
 *
 * Proposed by the firmware session in `dn2_firmware/docs/for-dnx-waverider-pool.md`, revision 3,
 * 2026-10-06. **Nothing on the instrument answers this route yet.** This exists first because the
 * Library tab's pool pane is built against it and needs no hardware.
 *
 * ```
 * container header 31 B      kind 0x50, version 2, index p, length 512, raw
 * record          512 B      "WRPL", the 128 store slots, a count and a hash
 * trailer          12 B      as every other container
 * ```
 *
 * ## A pool holds store slots, and a sound holds a pool index
 *
 * A sound's `TBL` is a **coarse** value: 0 and 1 are the built-in Prim. and Harm., and `c >= 2` is
 * **pool index** `c - 2`, displayed as **shown slot** `c - 1`, and `c` runs to 129 for the 128th.
 * The pool record says which **store slot** sits at each pool index. Four numbers for one table, and this module adds the fifth, the
 * project slot. Every field says which it carries, because `coarse - 1` and `coarse - 2` both look
 * right across most of the range.
 *
 * ## Three states, and the generation is what tells two of them apart
 *
 * A project with no record follows the **automatic pool**: every stored 16 x 512 table in
 * store-slot order, which is what every project did before the lists existed. A **new** project
 * gets a stored **empty** list instead, decided by the owner on 2026-10-06 on the grounds that a
 * new project's sound pool starts empty too. So an empty pool and an absent one are different
 * things that read almost alike, and `poolState` is the one place that separates them.
 *
 * A read of a project with no record does not come back empty. It comes back with the automatic
 * flag set, `generation` 0, and **the entries filled with what that project plays right now**.
 *
 * So a read is a description, not a template for a write. Read it, change one entry, write it back
 * with the flag still set, and the firmware ignores every entry: a write that reports success,
 * verifies clean, and keeps the old pool. `buildPoolFile` refuses that combination rather than
 * sending it, and the firmware refuses it too. **It is refused in both places on purpose**, because
 * this is the shape that cost us slot 9, where a commit answered ok and wrote nothing.
 *
 * ## The count and the hash are computed, never accepted
 *
 * As in `slotfile.ts`, and for the same reason: a field a caller can get wrong is a field that
 * passes every local check and then fails on the device, or worse, does not.
 *
 * ## The generation is not ours to set
 *
 * The firmware ignores what we send and writes the current generation plus one. That makes the
 * generation the one honest proof that a write landed, including for an automatic write, where
 * there is nothing else to compare: a stored automatic record still reads back with its entries
 * filled. So a write is proved by reading before and after and seeing it advance.
 */

import { be16, be32, putBe16, putBe32 } from "./bytes.js";
import { WaveriderError } from "./errors.js";
import { INDEX_ENTRIES } from "./layout.js";
import { POOL_ENTRIES } from "./pool.js";
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
 * `0x0D` for a pool record: `'P'`, and deliberately not the table's `0x57`.
 *
 * So a pool file sent to `/waverider`, or a slot file sent here, is refused rather than read as the
 * other thing. Asked for and agreed; it costs nothing and it closes the one mistake two raw routes
 * could otherwise make silently.
 */
export const CONTENT_KIND_POOL = 0x50;

/**
 * The record format DNX **writes**: version 2, 128 entries.
 *
 * Carried in two fields that must agree, the container's object version at `0x11` and the
 * record's own u16 at offset 4. **If only one of them moved, a reader checking the other would
 * take a v2 record for a v1 and read entry 127 out of what it believes is reserved** — the exact
 * error a version field exists to prevent, arriving through the version field. So both move, and
 * both are checked.
 */
export const POOL_FORMAT_VERSION = 2;

/** Entries each version carries. Version 1 is read and never written. */
export const ENTRIES_BY_VERSION: Readonly<Record<number, number>> = { 1: 127, 2: POOL_ENTRIES };

/**
 * The four ASCII at `0x09`.
 *
 * The same firmware writer emits the store's, so it is the same string, and the test asserts the
 * two have not drifted apart. It names a build and never says whether a layout changed, so nothing
 * reads it back.
 */
export const FORMAT_VERSION = "0059";

/** `"WRPL"`, the record's own magic, after the container's. */
export const POOL_MAGIC = Uint8Array.of(0x57, 0x52, 0x50, 0x4c);

/** Bytes of one pool record. One sector, and always written whole. */
export const POOL_RECORD_BYTES = 512;

/** Project slots a pool can belong to: `0` the working project, `1..128` as `/projects` numbers them. */
export const PROJECT_SLOTS = 129;

/** The project slot that is not on the card: the working project, whose pool is the one TBL plays. */
export const WORKING_PROJECT = 0;

/** A pool index that holds no table, as the record stores it. The model uses `undefined`. */
export const NO_TABLE = 0xffff;

/** `flags` bit 0: this project follows the automatic pool, and the entries are not used. */
export const FLAG_AUTOMATIC = 1 << 0;

/** Field offsets in a 512-byte pool record. */
export const RECORD = {
  magic: 0,
  version: 4,
  projectSlot: 6,
  generation: 8,
  entriesInUse: 12,
  flags: 14,
  entries: 16,
  hash: 508,
} as const;

/** Where the entries end and the reserved zeros begin, which the version decides. */
export function reservedFrom(version: number): number {
  return RECORD.entries + (ENTRIES_BY_VERSION[version] ?? POOL_ENTRIES) * 2;
}

/** One project's pool, with the derived fields left to this module. */
export interface PoolRecord {
  /** `0` the working project, `1..128` as `/projects` numbers them. */
  projectSlot: number;
  /**
   * This project follows the automatic pool.
   *
   * Then `entries` must be empty, which is what makes the read-then-write trap impossible to send.
   */
  automatic: boolean;
  /**
   * The **store slot** at each **pool index**, `undefined` where the pool index holds nothing.
   *
   * `undefined` rather than `0xFFFF`, so nothing can mistake the absence for store slot 65,535.
   * Shorter than a full pool on the way in, always `POOL_ENTRIES` on the way out.
   */
  entries: readonly (number | undefined)[];
  /**
   * The firmware's, not ours: ignored on a write, and `0` on a read with no stored record behind
   * it. See this module's note.
   */
  generation: number;
}

/** Build the file for one project's pool. */
export function buildPoolFile(record: PoolRecord): Uint8Array {
  const { projectSlot, automatic, entries } = record;

  if (!Number.isInteger(projectSlot) || projectSlot < 0 || projectSlot >= PROJECT_SLOTS) {
    throw new WaveriderError(`project slot ${projectSlot} is outside 0..${PROJECT_SLOTS - 1}`);
  }
  if (entries.length > POOL_ENTRIES) {
    throw new WaveriderError(
      `a pool holds ${POOL_ENTRIES} entries and this one has ${entries.length}`,
    );
  }

  const used = entries.filter((slot): slot is number => slot !== undefined);
  for (const slot of used) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= INDEX_ENTRIES) {
      throw new WaveriderError(
        `a pool entry names a store slot 0..${INDEX_ENTRIES - 1}, and this one names ${slot}`,
      );
    }
  }

  /*
   * **The trap, refused here rather than sent.** The firmware ignores the entries of an automatic
   * write, so a record read from an automatic project and written back unchanged looks like a
   * successful edit and is not one. Refused in both places; see this module's note.
   */
  if (automatic && used.length > 0) {
    throw new WaveriderError(
      `project slot ${projectSlot}: an automatic pool cannot carry entries, and this one carries ` +
        `${used.length}. A record read from a project with no pool of its own comes back with the ` +
        `automatic flag set and its entries filled with what that project plays, so writing it ` +
        `back unchanged would be ignored. Clear the flag to pin those entries, or empty the ` +
        `entries to mean automatic.`,
    );
  }

  const body = new Uint8Array(POOL_RECORD_BYTES);
  body.set(POOL_MAGIC, RECORD.magic);
  putBe16(body, RECORD.version, POOL_FORMAT_VERSION);
  putBe16(body, RECORD.projectSlot, projectSlot);
  putBe32(body, RECORD.generation, record.generation);
  // **Computed, never passed**, as `slotfile.ts` computes its table hash and for the same reason.
  putBe16(body, RECORD.entriesInUse, used.length);
  putBe16(body, RECORD.flags, automatic ? FLAG_AUTOMATIC : 0);
  // Written at `POOL_FORMAT_VERSION`, which is 2 and therefore all 128. A v1 record is read and
  // never written: the firmware converts one on its first write, losslessly, because 127 entries
  // have exactly one 128-entry meaning.
  for (let j = 0; j < POOL_ENTRIES; j++) {
    putBe16(body, RECORD.entries + j * 2, entries[j] ?? NO_TABLE);
  }
  putBe32(body, RECORD.hash, xxHash32(body.subarray(0, RECORD.hash)));

  return buildContainer({
    body,
    contentKind: CONTENT_KIND_POOL,
    objectVersion: POOL_FORMAT_VERSION,
    index: projectSlot,
    formatVersion: FORMAT_VERSION,
  });
}

/**
 * Read a pool file back, refusing anything that is not one.
 *
 * Strict about the reserved bytes as well as the fields, because the record carries a version and
 * that is what a version is for: a byte documented as zero that is not zero means this is being
 * read as the wrong thing, which is cheaper to say here than to debug as a wrong pool.
 */
export function readPoolFile(bytes: Uint8Array): PoolRecord {
  const expected = HEADER_BYTES + POOL_RECORD_BYTES + TRAILER_BYTES;
  if (bytes.length !== expected) {
    throw new WaveriderError(`a pool file is ${expected} bytes, this is ${bytes.length}`);
  }
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (bytes[i] !== CONTAINER_MAGIC[i]) throw new WaveriderError("not an Elektron container");
  }
  const kind = contentKind(bytes);
  if (kind !== CONTENT_KIND_POOL) {
    throw new WaveriderError(
      `content kind 0x${(kind ?? 0).toString(16)} is not a pool record's 0x${CONTENT_KIND_POOL.toString(16)}`,
    );
  }
  const version = containerObjectVersion(bytes) ?? 0;
  if (ENTRIES_BY_VERSION[version] === undefined) {
    throw new WaveriderError(
      `pool format version ${version} is not one of ${Object.keys(ENTRIES_BY_VERSION).join(", ")}`,
    );
  }
  if (containerIsCompressed(bytes) !== false) {
    throw new WaveriderError("the body must be raw; this one says it is an LZ4 chain");
  }

  const body = bytes.subarray(HEADER_BYTES, bytes.length - TRAILER_BYTES);
  const stamped = bytes[HEAD.index + 3]!;

  for (let i = 0; i < POOL_MAGIC.length; i++) {
    if (body[RECORD.magic + i] !== POOL_MAGIC[i]) {
      throw new WaveriderError('the record does not begin "WRPL"');
    }
  }
  /*
   * **Both version fields, and they must agree with each other as well as be known.** They
   * describe the same thing, and a record where they differ is one where a reader's answer
   * depends on which field it happened to consult.
   */
  const recordVersion = be16(body, RECORD.version);
  if (recordVersion !== version) {
    throw new WaveriderError(
      `the container says pool version ${version} and the record says ${recordVersion}`,
    );
  }
  const projectSlot = be16(body, RECORD.projectSlot);
  if (projectSlot >= PROJECT_SLOTS) {
    throw new WaveriderError(
      `the record says project slot ${projectSlot}, outside 0..${PROJECT_SLOTS - 1}`,
    );
  }
  if (projectSlot !== stamped) {
    throw new WaveriderError(
      `the record says project slot ${projectSlot} and the container is stamped ${stamped}`,
    );
  }

  const hash = be32(body, RECORD.hash);
  const computed = xxHash32(body.subarray(0, RECORD.hash));
  if (hash !== computed) {
    throw new WaveriderError(
      `project slot ${projectSlot}: the record's hash does not match its bytes`,
    );
  }

  const flags = be16(body, RECORD.flags);
  if ((flags & ~FLAG_AUTOMATIC) !== 0) {
    throw new WaveriderError(
      `project slot ${projectSlot}: flags 0x${flags.toString(16)} sets a bit version ` +
        `${POOL_FORMAT_VERSION} does not define`,
    );
  }

  const carried = ENTRIES_BY_VERSION[version]!;
  for (let at = reservedFrom(version); at < RECORD.hash; at++) {
    if (body[at] !== 0) {
      throw new WaveriderError(
        `project slot ${projectSlot}: byte ${at} is reserved and zero in version ` +
          `${version}, and it is 0x${body[at]!.toString(16)}`,
      );
    }
  }

  /*
   * **One shape for callers, whatever the bytes said.** A v1 record carries 127 and the 128th
   * comes back empty, so nothing above this line learns to ask which version it is holding —
   * which is how `coarse - 1` and `coarse - 2` came to be confused.
   */
  const entries: (number | undefined)[] = new Array<number | undefined>(POOL_ENTRIES).fill(undefined);
  for (let j = 0; j < carried; j++) {
    const value = be16(body, RECORD.entries + j * 2);
    if (value === NO_TABLE) continue;
    if (value >= INDEX_ENTRIES) {
      throw new WaveriderError(
        `project slot ${projectSlot}, pool index ${j}: store slot ${value} is outside ` +
          `0..${INDEX_ENTRIES - 1}, and it is not 0x${NO_TABLE.toString(16)} for none`,
      );
    }
    entries[j] = value;
  }

  // Checked for every record, automatic or not: a read always carries a count that matches what it
  // carries, so a disagreement is a truncated or misread record rather than a kind of pool.
  const claimed = be16(body, RECORD.entriesInUse);
  const actual = entries.filter((slot) => slot !== undefined).length;
  if (claimed !== actual) {
    throw new WaveriderError(
      `project slot ${projectSlot}: the record counts ${claimed} entries in use and carries ${actual}`,
    );
  }

  return {
    projectSlot,
    automatic: (flags & FLAG_AUTOMATIC) !== 0,
    entries,
    generation: be32(body, RECORD.generation),
  };
}

/**
 * The record that means "this project follows the store", for one project slot.
 *
 * One sector, no entries. The same state as having no record at all, and the only way back to it
 * once a project has one, because the route offers no delete.
 */
export function automaticPoolFile(projectSlot: number): Uint8Array {
  return buildPoolFile({ projectSlot, automatic: true, entries: [], generation: 0 });
}

/**
 * The record a **new project** gets: stored, not automatic, and holding nothing.
 *
 * The owner settled this on 2026-10-06, against the alternative of making CREATE NEW automatic:
 * a new project's **sound** pool starts empty, so its wavetable pool does too. The instrument
 * writes exactly this record when a project is created, so DNX reads it constantly and should be
 * able to write it.
 *
 * It is not the same thing as `automaticPoolFile`, and the difference is audible: an empty list
 * gives a sound nothing but the built-in Prim. and Harm. until tables are added, where an
 * automatic one gives it every playable table on the card.
 */
export function emptyPoolFile(projectSlot: number): Uint8Array {
  return buildPoolFile({ projectSlot, automatic: false, entries: [], generation: 0 });
}

/**
 * Which of the three states a read describes.
 *
 * | | generation | automatic | what a sound reaches |
 * |---|---|---|---|
 * | `untouched` | 0 | yes | every playable table on the card, in store-slot order |
 * | `automatic` | 1 or more | yes | the same, and the project says so on purpose |
 * | `list` | 1 or more | no | exactly the entries, which may be none |
 *
 * `untouched` is a project saved before the lists existed, answered by a record the firmware made
 * up to answer the read. It plays the same as `automatic` and is not the same fact, which is why
 * the generation is the only thing that separates them.
 */
export function poolState(record: PoolRecord): "untouched" | "automatic" | "list" {
  if (record.generation === 0) return "untouched";
  return record.automatic ? "automatic" : "list";
}

/**
 * Whether a read says this project has a pool of its own.
 *
 * `generation` 0 is the firmware's tell for a record it synthesised to answer the read. A project
 * with no record is not distinguishable from one with a stored automatic record by its entries or
 * its flag, only by this.
 */
export function hasStoredPool(record: PoolRecord): boolean {
  return record.generation > 0;
}
