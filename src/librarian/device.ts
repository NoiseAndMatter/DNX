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
import { type DeviceSpec, DN1_SPEC, DN2_SPEC } from "../project/spec.js";
import { isSongTableEmpty } from "../project/dn1tail.js";
import { isSongTableEmpty as isDn2SongTableEmpty } from "../project/dn2song.js";

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
 * - `unknown` — we have never located this device's song table.
 *
 * **`unknown` is now unreachable for both families**, and the state stays because that is the
 * honest shape: it was true of the Digitone II from the day this was written until the table was
 * located on hardware, and a third device or an unreadable image would need it again. Deleting it
 * would mean a future "we cannot tell" had nowhere to go but `empty`.
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
  /**
   * Trigs that lock a sound from the project pool. Omitted for an unsupported version.
   *
   * Worth surfacing because it decides whether an operation actually exercises pool
   * references: moving a pattern with no sound locks proves nothing about them.
   */
  soundLockCount?: number;
  /** Omitted for an unsupported version. True when the pattern holds trigs. */
  occupied?: boolean;
}

export interface Device {
  /**
   * Every number this family's format is made of.
   *
   * **The fields below it are conveniences, all read from here.** They stay because a hundred call
   * sites say `device.patternCount`, and `device.spec.layout.patternCount` would be a worse
   * sentence — but there is one source, so the two cannot disagree.
   */
  spec: DeviceSpec;
  kind: DeviceKind;
  name: string;
  layout: ImageLayout;
  /** The single pattern-record version this family reads and writes. */
  patternVersion: number;
  /** Offset of the slot-index field, relative to the start of a pattern record. */
  slotIndexOffset: number;
  /**
   * Offset of the pattern's name field, relative to the start of a pattern record.
   *
   * Both families keep a 16-byte name there, at different offsets. Exposed because the rename
   * librarian writes it and had no business knowing which family's constants to reach for.
   */
  patternNameOffset: number;
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

/** Both families expose trigs the same shape, so one counter serves both. */
function countSoundLocks(
  tracks: readonly { trigs: readonly { soundLock?: number }[] }[],
): number {
  return tracks.reduce(
    (n, t) => n + t.trigs.filter((trig) => trig.soundLock !== undefined).length,
    0,
  );
}

function versionOf(record: Uint8Array, offset: number): number {
  return new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(
    offset,
    false,
  );
}

const DN1: Device = {
  spec: DN1_SPEC,
  kind: DN1_SPEC.kind,
  name: DN1_SPEC.name,
  layout: DN1_SPEC.layout,
  patternVersion: DN1_SPEC.pattern.version,
  slotIndexOffset: DN1_SPEC.pattern.slotIndexOffset,
  patternNameOffset: DN1_SPEC.pattern.nameOffset,
  patternCount: DN1_SPEC.layout.patternCount,
  synthTrackCount: DN1_SPEC.synthTrackCount,
  stepCount: DN1_SPEC.stepCount,
  hasKits: DN1_SPEC.hasKits,
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
      soundLockCount: countSoundLocks(pattern.tracks),
      occupied: trigCount > 0,
    };
  },

  songState(image) {
    return isSongTableEmpty(image, DN1_LAYOUT) ? "empty" : "occupied";
  },
};

const DN2: Device = {
  spec: DN2_SPEC,
  kind: DN2_SPEC.kind,
  name: DN2_SPEC.name,
  layout: DN2_SPEC.layout,
  patternVersion: DN2_SPEC.pattern.version,
  slotIndexOffset: DN2_SPEC.pattern.slotIndexOffset,
  patternNameOffset: DN2_SPEC.pattern.nameOffset,
  patternCount: DN2_SPEC.layout.patternCount,
  synthTrackCount: DN2_SPEC.synthTrackCount,
  stepCount: DN2_SPEC.stepCount,
  hasKits: DN2_SPEC.hasKits,
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
    return {
      index,
      version,
      supported: true,
      name,
      trigCount,
      soundLockCount: countSoundLocks(pattern.tracks),
      occupied: trigCount > 0,
    };
  },

  /**
   * Real since 2026-08-15, when the song table was located on hardware.
   *
   * This returned `unknown` for as long as it existed, because the table sat somewhere in the
   * unidentified tail bytes and the manager could not demonstrate a safety it did not have. It can
   * now: `dn2song.ts` reads each record's declared row count, and a project with no rows anywhere is
   * one a rearrangement cannot desync.
   */
  songState(image) {
    return isDn2SongTableEmpty(image, DN2_LAYOUT) ? "empty" : "occupied";
  },
};

/** Identify the device a decoded image belongs to. */
export function deviceFor(image: Uint8Array): Device {
  const layout = layoutFor(image);
  return layout === DN1_LAYOUT ? DN1 : DN2;
}

export { DN1 as DN1_DEVICE, DN2 as DN2_DEVICE };
