/**
 * One interface over both Digitones, for operations that do not care which is which.
 *
 * The temptation is an abstraction that makes a DN1 project look like a small DN2 project.
 * That is wrong: the devices differ in ways a user can see — 4 synth tracks against 16, 64
 * steps against 128, kits that exist on one family and not the other — and hiding those
 * produces a UI that renders DN1 files as broken DN2 ones. So this module **reports**
 * differences rather than smoothing them.
 *
 * The test of whether it is right: if a caller starts branching on `kind`, the interface is
 * missing something and should grow a method rather than leak the device out.
 *
 * ## Versions, and why `supported` is a field rather than an exception
 *
 * A pattern record carries its own storage version. We write and understand exactly one per
 * family, and a record at any other version is **not** something to guess at: the interior
 * offsets move between versions, so parsing one as if it were another silently produces
 * wrong names, wrong trig counts and a corrupt write.
 *
 * elk-herd solves this with `(device, version) -> Maybe offset` tables and simply makes the
 * operation unavailable when the answer is `Nothing`. We do the same with less ceremony,
 * because we support one version per family rather than ten: an unsupported record is
 * summarised as `supported: false` with its version reported, and every operation refuses
 * to touch it. Refusing is the honest outcome — the alternative is inventing.
 *
 * **This is not hypothetical.** `PRESETS.dn2prj` in the corpus is version 2 in all 128 of
 * its pattern records, while every other DN2 project we hold is version 3. Since our whole
 * DN2 corpus comes from either Elektron's importer or our own captures, a device-written
 * project at another version is precisely the case a manager meets first.
 */

import {
  DN1_LAYOUT,
  DN2_LAYOUT,
  type ImageLayout,
  layoutFor,
  patternRecord,
  projectName as dn2ProjectName,
} from "../project/dn2image.js";
import {
  PATTERN as DN1_PATTERN,
  RECORD_VERSION as DN1_PATTERN_VERSION,
  readPattern as readDn1Pattern,
  readProjectName as readDn1ProjectName,
} from "../project/dn1.js";
import {
  PATTERN as DN2_PATTERN,
  RECORD_VERSION as DN2_PATTERN_VERSION,
  readDn2Pattern,
} from "../project/dn2pattern.js";
import { isSongTableEmpty } from "../project/dn1tail.js";

export type DeviceKind = "dn1" | "dn2";

/**
 * Whether a song could be broken by moving patterns around.
 *
 * Three states rather than a boolean, because "we cannot tell" is a real answer and must
 * not collapse into "fine". A song row naming a pattern by slot is exactly the reference a
 * rearrangement invalidates.
 *
 * - `empty` — checked, and no song holds anything. Rearranging is safe.
 * - `occupied` — checked, and a song exists. Rearranging may desync it.
 * - `unknown` — **we have never located this device's song table.** True of the DN2, whose
 *   song mode sits in the ~98,800 unidentified tail bytes.
 */
export type SongState = "empty" | "occupied" | "unknown";

export interface PatternSummary {
  index: number;
  /** Storage version carried by the record itself. */
  version: number;
  /** True when the version is one we understand well enough to read and rewrite. */
  supported: boolean;
  /** Omitted for an unsupported version, where the offset is not known to be right. */
  name?: string;
  /** Omitted for an unsupported version. */
  trigCount?: number;
  /** Omitted for an unsupported version. True when the pattern holds trigs. */
  occupied?: boolean;
}

export interface Device {
  kind: DeviceKind;
  name: string;
  layout: ImageLayout;
  /** The single pattern-record version this family reads and writes. */
  patternVersion: number;
  /** Offset of the slot-index field, relative to the start of a pattern record. */
  slotIndexOffset: number;
  patternCount: number;
  synthTrackCount: number;
  stepCount: number;
  /** DN2 only. The DN1 has no named kits. */
  hasKits: boolean;
  projectName(image: Uint8Array): string;
  summarise(image: Uint8Array, index: number): PatternSummary;
  songState(image: Uint8Array): SongState;
}

const latin1 = new TextDecoder("latin1");

/** Read a fixed-width name field, stopping at the first NUL. */
function readName(data: Uint8Array, at: number, size: number): string {
  const raw = data.subarray(at, at + size);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul));
}

function versionOf(record: Uint8Array, offset: number): number {
  return new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(
    offset,
    false,
  );
}

const DN1: Device = {
  kind: "dn1",
  name: "Digitone 1",
  layout: DN1_LAYOUT,
  patternVersion: DN1_PATTERN_VERSION,
  slotIndexOffset: DN1_PATTERN.slotIndexOffset,
  patternCount: DN1_LAYOUT.patternCount,
  synthTrackCount: 4,
  stepCount: 64,
  hasKits: false,
  projectName: readDn1ProjectName,

  summarise(image, index) {
    const record = patternRecord(image, index, DN1_LAYOUT);
    const version = versionOf(record, DN1_PATTERN.versionOffset);
    if (version !== DN1_PATTERN_VERSION) return { index, version, supported: false };

    const pattern = readDn1Pattern(image, index);
    const trigCount = pattern.tracks.reduce((n, t) => n + t.trigs.length, 0);
    return {
      index,
      version,
      supported: true,
      name: pattern.name,
      trigCount,
      occupied: trigCount > 0,
    };
  },

  songState(image) {
    return isSongTableEmpty(image, DN1_LAYOUT) ? "empty" : "occupied";
  },
};

const DN2: Device = {
  kind: "dn2",
  name: "Digitone II",
  layout: DN2_LAYOUT,
  patternVersion: DN2_PATTERN_VERSION,
  slotIndexOffset: DN2_PATTERN.slotIndexOffset,
  patternCount: DN2_LAYOUT.patternCount,
  synthTrackCount: 16,
  stepCount: 128,
  hasKits: true,
  projectName: dn2ProjectName,

  summarise(image, index) {
    const record = patternRecord(image, index, DN2_LAYOUT);
    const version = versionOf(record, DN2_PATTERN.versionOffset);
    // Read the name straight from the record rather than through readDn2Pattern: a full
    // parse walks 8,192 trig slots, and a summary of 128 patterns should not pay that.
    if (version !== DN2_PATTERN_VERSION) return { index, version, supported: false };

    const name = readName(record, DN2_PATTERN.nameOffset, DN2_PATTERN.nameSize);
    const pattern = readDn2Pattern(image, index, DN2_LAYOUT);
    const trigCount = pattern.tracks.reduce((n, t) => n + t.trigs.length, 0);
    return { index, version, supported: true, name, trigCount, occupied: trigCount > 0 };
  },

  /**
   * Always `unknown`.
   *
   * The DN2 song table has never been located — `docs/dn2-format.md` places song mode among
   * the unidentified tail bytes. Returning `unknown` rather than `empty` is the whole point
   * of the tri-state: it keeps the manager from claiming a safety it cannot demonstrate.
   */
  songState() {
    return "unknown";
  },
};

/** Identify the device a decoded image belongs to. */
export function deviceFor(image: Uint8Array): Device {
  const layout = layoutFor(image);
  return layout === DN1_LAYOUT ? DN1 : DN2;
}

export { DN1 as DN1_DEVICE, DN2 as DN2_DEVICE };
