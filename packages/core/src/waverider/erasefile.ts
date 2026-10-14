/**
 * The bytes of the erase request: `/wavepool/129`, which empties the whole wavetable region.
 *
 * **One job: the 512 bytes that ask for it.** What the request *means* and the care around sending
 * it is `device/wavetableerase.ts`; this is the record, the way `poolfile.ts` is the record for a
 * pool and `slotfile.ts` for a table.
 *
 * From `dn2_firmware/docs/for-dnx-waverider-erase.md`. It travels as a pool list does — the
 * transfer container, kind `0x50`, object version 2, index byte 129, 512 bytes raw — because the
 * route is the same; `/wavepool` still lists 0..128 and 129 is a control rather than a project.
 * **A read of it is refused at the open**, so nothing here reads one back.
 *
 * ```
 * 0    u32   magic "WRER"
 * 4    u16   version 1
 * 6    u16   0
 * 8    u32   tables in use
 * 12   u32   pool lists in use
 * 16   ...   zero to 507
 * 508  u32   xxHash32 of bytes 0..507
 * ```
 *
 * ## The counts are the confirmation, not a statistic
 *
 * They are what the **user was shown** when they said yes. The firmware counts the store itself at
 * the commit and refuses the request if either number differs, so a confirmation made against a
 * stale listing cannot erase tables that arrived after it — from another writer, or from the
 * instrument's own page.
 *
 * That is why `buildEraseRequest` takes them rather than reading them: a function that counted for
 * itself would count at send time, which is exactly the moment the guard exists to distrust. The
 * caller must pass the numbers it put in front of a person, and if the firmware refuses, the
 * honest answer is to re-list, show the new numbers and ask again.
 *
 * ## Zero and zero is a legal request
 *
 * It is what finishes an erase interrupted between the metadata write and the TRIM: the store
 * already reads empty, so the counts are 0, and the request completes the TRIM over bytes nothing
 * references. Not refused, and not treated here as a mistake.
 */

import { putBe16, putBe32 } from "./bytes.js";
import { WaveriderError } from "./errors.js";
import { buildContainer } from "../project/container.js";
import {
  CONTENT_KIND_POOL,
  FORMAT_VERSION,
  POOL_FORMAT_VERSION,
  POOL_RECORD_BYTES,
} from "./poolfile.js";
import { xxHash32 } from "./xxhash32.js";

/** The index byte the request is addressed to. `/wavepool` itself lists 0..128. */
export const ERASE_SLOT = 129;

/** `"WRER"`, this record's own magic, after the container's. */
export const ERASE_MAGIC = Uint8Array.of(0x57, 0x52, 0x45, 0x52);

/** The only version of the request this build knows how to ask for. */
export const ERASE_VERSION = 1;

/** Field offsets in the 512-byte body. */
export const ERASE = {
  magic: 0,
  version: 4,
  reserved: 6,
  tables: 8,
  lists: 12,
  hash: 508,
} as const;

/** What the user was shown, and therefore what the firmware will check against. */
export interface EraseCounts {
  /** Entries `/waverider` listed as used. */
  tables: number;
  /** Project slots `/wavepool` listed as used. */
  lists: number;
}

/**
 * Build the request for one erase.
 *
 * The counts come from the listings the caller showed somebody. See this module's note on why
 * they are an argument and not a measurement.
 */
export function buildEraseRequest(counts: EraseCounts): Uint8Array {
  const { tables, lists } = counts;
  for (const [what, value] of [["tables", tables], ["lists", lists]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new WaveriderError(`the erase request's ${what} count is ${value}, which is not a count`);
    }
  }

  const body = new Uint8Array(POOL_RECORD_BYTES);
  body.set(ERASE_MAGIC, ERASE.magic);
  putBe16(body, ERASE.version, ERASE_VERSION);
  putBe16(body, ERASE.reserved, 0);
  putBe32(body, ERASE.tables, tables);
  putBe32(body, ERASE.lists, lists);
  // Computed, never passed, as every other record in this family computes its own.
  putBe32(body, ERASE.hash, xxHash32(body.subarray(0, ERASE.hash)));

  return buildContainer({
    body,
    contentKind: CONTENT_KIND_POOL,
    formatVersion: FORMAT_VERSION,
    objectVersion: POOL_FORMAT_VERSION,
    index: ERASE_SLOT,
    compressed: false,
  });
}
