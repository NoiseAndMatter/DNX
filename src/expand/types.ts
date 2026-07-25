/**
 * Shared vocabulary for expansion planning.
 *
 * Types only, no behaviour, so the collection / rules / ranking / allocation modules can
 * depend on a common language without depending on each other.
 */

import type { TagName } from "../project/tags.js";

/** DN2 track count. Each track is either synth or MIDI, drawn from one shared pool. */
export const DN2_TRACK_COUNT = 16;

export interface SoundUsage {
  /** Sound-pool slot, 0..127. This is the sound's identity for planning purposes. */
  poolSlot: number;
  name: string;
  /** Total number of trigs across the whole project that lock this sound. */
  trigCount: number;
  /** Patterns in which the sound appears at least once. */
  patterns: number[];
  /** DN1 synth tracks it is locked on, 0..3. */
  sourceTracks: number[];
  /** Raw tag bitfield from the sound object. */
  tagBits: number;
  /** Tags decoded from `tagBits`. */
  tags: TagName[];
}

/**
 * A preference mapping tags to destination tracks.
 *
 * Rules are PREFERENCES, never constraints. A sound whose preferred tracks are all taken
 * falls back to any free destination rather than being dropped — the lossless guarantee
 * matters more than the layout.
 */
export interface PlacementRule {
  /** Human-readable label, for the UI and the plan report. */
  name: string;
  /** Matches a sound carrying ANY of these tags. */
  tags: readonly TagName[];
  /** Preferred destination tracks, 1-based, in fill order. */
  tracks: readonly number[];
}

/** Why a sound ended up where it did, so a UI can explain itself. */
export type PlacementReason = "pinned" | "rule" | "fallback";

export interface Assignment {
  usage: SoundUsage;
  /** 1-based DN2 track it is promoted to. */
  dn2Track: number;
  reason: PlacementReason;
  /** The rule that placed it, when `reason` is "rule". */
  rule?: PlacementRule;
}

/** How to place a sound carrying both percussive and melodic tags. */
export type MixedPolicy = "percussive-first" | "melodic-first" | "none";

export interface PlanOptions {
  /**
   * Order in which DN1 synth tracks have their locked sounds considered, most important
   * first. Only affects tie-breaking and which sounds lose out on overflow.
   */
  sourceTrackOrder?: readonly number[];
  /**
   * DN2 tracks to fill, in order, 1-based. Defaults to the guaranteed-free 9..16, plus any
   * track freed by an unused DN1 MIDI track when `useFreedMidiTracks` is set.
   */
  destinationTracks?: readonly number[];
  /**
   * Whether to use DN2 tracks 5-8 when the corresponding DN1 MIDI track is empty.
   * Off by default: we have not yet located the per-track synth/MIDI discriminator on the
   * DN2, so we cannot be sure an unused track 5-8 is usable as a synth track without
   * switching its type. Turn on once that is resolved.
   */
  useFreedMidiTracks?: boolean;
  /**
   * Tag-based placement preferences, tried in order. A sound matching no rule, or whose
   * preferred tracks are all taken, falls back to the next free destination.
   */
  rules?: readonly PlacementRule[];
  /**
   * Absolute per-sound overrides: pool slot -> 1-based DN2 track. Applied before ranking
   * and before any rule, so a pinned sound always gets its track.
   *
   * This exists because tags describe a sound's character, not the use it is being put to.
   * A PERCUSSION-tagged sound played as a lead is a legitimate choice, and overriding it
   * has to be as easy as accepting the default.
   */
  pins?: ReadonlyMap<number, number>;
  /**
   * Tie-break for sounds tagged both ways. Common — 30% of sound-locked sounds in the
   * corpus. Defaults to "percussive-first", which suits a domain where locked sounds skew
   * percussive.
   */
  mixedPolicy?: MixedPolicy;
}

export interface ExpansionPlan {
  /** Patterns containing at least one trig. */
  livePatterns: number[];
  /** DN1 MIDI tracks (0-based, 4..7) that carry trigs and therefore occupy a DN2 track. */
  usedMidiTracks: number[];
  /** 1-based DN2 tracks available to promoted sounds, in fill order. */
  freeTracks: number[];
  assignments: Assignment[];
  /** Sounds that could not be promoted. They stay sound-locked on their origin track. */
  overflow: SoundUsage[];
  /** Trigs that stay sound-locked because their sound was not promoted. */
  overflowTrigs: number;
  /** Trigs that move to a promoted track. */
  promotedTrigs: number;
}
