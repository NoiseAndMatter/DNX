/**
 * Everything a Digitone's format is, in one place per machine.
 *
 * ## Why this exists
 *
 * The numbers were right and findable, and they were spread across a dozen modules named after
 * *formats* rather than after *machines* — `soundmap.ts`, `machine.ts`, `dn2image.ts`,
 * `dn2pattern.ts`, `dn1.ts`, `kitwrite.ts`, `blank.ts`. So answering "what is a Digitone 1" meant
 * knowing which file each half of the answer lived in, and adding a fact meant choosing a file
 * rather than filling a field.
 *
 * The cost was not hypothetical. Four facts were already written down twice before this existed:
 *
 * | fact | and again in |
 * |---|---|
 * | the sound name's offset and size | `dn2image.ts` **and** `soundmap.ts` |
 * | a DN1 sound is 302 bytes | `dn1.ts` `SOUND_SIZE` **and** `soundmap.ts` `DN1_SOUND_SIZE` |
 * | a pool holds 128 | `soundmap.ts` `POOL_SOUND_COUNT` **and** `copy.ts` `POOL_SLOTS` |
 * | where a kit's name sits | `kitwrite.ts` (8) **and** `blank.ts` (`{ dn1: 4, dn2: 8 }`) |
 *
 * None had drifted yet. The message-id allocator is what happens when that luck runs out: two
 * copies of one idea, neither shared, and the third caller collided with both.
 *
 * ## Two machines, and only ever two
 *
 * **This is not a plug-in point for a third device.** DNX is for Digitones. The Digitakt II shares
 * a storage family with the DN2 and is where elk-herd and digi-roll get their leverage; it is
 * explicitly out of scope here, and a spec shaped to accommodate it would be carrying weight for a
 * machine nobody intends to support.
 *
 * What it is for is that a Digitone 1 and a Digitone II differ in about twenty numbers, and code
 * that takes a spec reads as one algorithm rather than as two branches.
 *
 * ## Composed, not copied
 *
 * The grouped constants that already existed — `DN1_LAYOUT`, `DN2_KIT`, each family's `PATTERN` —
 * are referenced, not restated. This assembles them; it is not a second copy of any of them, and a
 * value that appears here appears nowhere else.
 *
 * Genuinely shared numbers stay shared. A sound's name sits at +12 on both machines, so it is one
 * constant rather than the same figure written into two specs, where they could disagree.
 */

import { DN1_KIT, DN1_LAYOUT, DN2_KIT, DN2_LAYOUT, type ImageLayout } from "./dn2image.js";
import {
  PATTERN as DN1_PATTERN,
  RECORD_VERSION as DN1_PATTERN_VERSION,
  RECORD_VERSIONS as DN1_PATTERN_VERSIONS,
} from "./dn1.js";
import {
  PATTERN as DN2_PATTERN,
  RECORD_VERSION as DN2_PATTERN_VERSION,
} from "./dn2pattern.js";
import {
  DN1_POOL_OFFSET,
  DN1_PROJECT_SOUND_VERSION,
  DN1_SOUND_SIZE,
  DN2_POOL_OFFSET,
  DN2_PROJECT_SOUND_VERSION,
  DN2_SOUND_SIZE,
} from "./soundmap.js";

export type DeviceKind = "dn1" | "dn2";

/** Where a pattern record keeps the two fields anything outside the reader needs. */
export interface PatternSpec {
  /** The record version this family **authors**: what a blank written by DNX carries. */
  version: number;
  /**
   * Every record version this family can **rewrite**, oldest first. What `supported` means.
   *
   * Reading is wider than this on both families and is not listed here, because the number a
   * refusal has to quote is the one it would have had to write.
   *
   * One entry on the Digitone II: a version-2 record reads through `asVersion3` and must never go
   * back, since the normalisation widens every track. Two on the Digitone 1, because OS 1.43
   * moved no field and a version-11 record is a version-10 record with a different byte at
   * `+0x03`.
   */
  writableVersions: readonly number[];
  /**
   * Where the record states the slot it believes it occupies.
   *
   * Moving a pattern without rewriting this leaves a record that disagrees about where it lives —
   * which `rearrange.ts` verifies rather than trusting.
   */
  slotIndexOffset: number;
  /** The 16-byte name the device's RENAME screen writes. */
  nameOffset: number;
}

/** Where a kit record keeps its name. Sizes and slot geometry live in `DN1_KIT` / `DN2_KIT`. */
export interface KitSpec {
  nameOffset: number;
  nameSize: number;
}

/** A sound object, and where the project's pool of them sits. */
export interface SoundSpec {
  /** One sound object: 302 on a Digitone 1, 359 on a Digitone II. */
  size: number;
  /** Where the pool begins, relative to `layout.tailBase`. */
  poolOffset: number;
  /**
   * The object version a sound in *this family's project* carries.
   *
   * The oldest one. A Digitone 1 sound object reads 5 up to OS 1.42A and 6 from 1.43, with no
   * change to the object; `PROJECT_SOUND_VERSIONS` in `dn1.ts` holds the pair.
   */
  projectVersion: number;
}

export interface DeviceSpec {
  kind: DeviceKind;
  /** As the instrument is called, for anything a person reads. */
  name: string;
  layout: ImageLayout;
  pattern: PatternSpec;
  kit: KitSpec;
  sound: SoundSpec;
  /** Synth tracks. The DN1's MIDI tracks are counted separately; see `dn1.ts`. */
  synthTrackCount: number;
  /** Steps in the longest pattern this family allows. */
  stepCount: number;
  /**
   * Whether the machine has kits a person can name and save.
   *
   * False for the Digitone 1, which is why its +Drive has no `/kits` directory at all — not merely
   * a naming difference, and the reason several operations refuse it outright.
   */
  hasKits: boolean;
}

/**
 * A kit's name sits immediately after its version field, and the two families differ by the magic.
 *
 * A DN2 kit record opens `BEEFBACE` + u32be version, so 8. A DN1's has no magic — just the u32be
 * version — so 4. Both were already written down in `blank.ts`; they are written here instead.
 */
export const KIT_NAME_SIZE = 16;

export const DN1_SPEC: DeviceSpec = {
  kind: "dn1",
  name: "Digitone 1",
  layout: DN1_LAYOUT,
  pattern: {
    version: DN1_PATTERN_VERSION,
    writableVersions: DN1_PATTERN_VERSIONS,
    slotIndexOffset: DN1_PATTERN.slotIndexOffset,
    nameOffset: DN1_PATTERN.nameOffset,
  },
  kit: { nameOffset: 4, nameSize: KIT_NAME_SIZE },
  sound: {
    size: DN1_SOUND_SIZE,
    poolOffset: DN1_POOL_OFFSET,
    projectVersion: DN1_PROJECT_SOUND_VERSION,
  },
  synthTrackCount: DN1_KIT.soundCount,
  stepCount: 64,
  hasKits: false,
};

export const DN2_SPEC: DeviceSpec = {
  kind: "dn2",
  name: "Digitone II",
  layout: DN2_LAYOUT,
  pattern: {
    version: DN2_PATTERN_VERSION,
    writableVersions: [DN2_PATTERN_VERSION],
    slotIndexOffset: DN2_PATTERN.slotIndexOffset,
    nameOffset: DN2_PATTERN.nameOffset,
  },
  kit: { nameOffset: 8, nameSize: KIT_NAME_SIZE },
  sound: {
    size: DN2_SOUND_SIZE,
    poolOffset: DN2_POOL_OFFSET,
    projectVersion: DN2_PROJECT_SOUND_VERSION,
  },
  synthTrackCount: DN2_KIT.soundCount,
  stepCount: 128,
  hasKits: true,
};

/** Both machines, in one place, for anything that has to consider each in turn. */
export const SPECS: readonly DeviceSpec[] = [DN1_SPEC, DN2_SPEC];

/**
 * Where a family's sound pool starts in a decoded image.
 *
 * Here rather than in two librarian modules, which each had a private `geometryFor` computing it —
 * the same function, byte for byte, in `poolwrite.ts` and `poolaudit.ts`. An audit and a write
 * disagreeing about where the pool is would be a corrupted project, so the two must not be able to.
 */
export function poolBase(spec: DeviceSpec): number {
  return spec.layout.tailBase + spec.sound.poolOffset;
}

/** Where one pool slot starts. */
export function poolSlotAt(spec: DeviceSpec, slot: number): number {
  return poolBase(spec) + slot * spec.sound.size;
}
