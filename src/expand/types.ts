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
  /** Sound-pool slot, 0..127. */
  poolSlot: number;
  /**
   * Distinguishes candidates that share a pool slot, 0 for the first.
   *
   * A sound whose source tracks disagree on length or speed cannot have them merged onto
   * one destination, so it yields one candidate per compatible group of source tracks. The
   * identity for planning and routing is therefore `(poolSlot, sourceTracks)`, not the slot
   * alone. See `usage.ts` for why, and how rare it is.
   */
  variant: number;
  name: string;
  /** Total number of trigs across the whole project that lock this sound. */
  trigCount: number;
  /** Patterns in which the sound appears at least once. */
  patterns: number[];
  /** DN1 synth tracks this candidate covers, 0..3. All mutually merge-compatible. */
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
  /**
   * Present when `aggregateByName` merged several sounds onto this track, highest-ranked
   * first. `usage` then describes the group rather than any one sound.
   */
  groupMembers?: SoundUsage[];
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
   * Which source patterns the plan is for. Defaults to all 128.
   *
   * **This is not a display filter.** Expansion decides which sounds get a track and which stay
   * locked, and it decides that across everything in scope — so a plan made for 128 patterns can
   * give track 9 to a sound used only in pattern 99 while a sound in the four you actually wanted
   * overflows and stays behind.
   *
   * A merge of four patterns must therefore be planned for those four. `collectSoundUsage` has
   * always accepted a subset; `planExpansion` simply never passed one.
   */
  patterns?: readonly number[];

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
   * Offer the DN2 counterparts of DN1 synth tracks the project never uses.
   *
   * Such a track fires no trig anywhere and holds the factory init sound in every kit, so
   * reserving its slot protects nothing. Across the corpus this frees 35 tracks in 25 of 55
   * projects.
   *
   * **Defaults to `compactPerPattern`**, because the measured benefit is layout, not
   * capacity: enabling it promotes exactly the same sounds in every one of the 55 projects,
   * in both modes. The projects with a spare synth track are not the projects that run out
   * of tracks. So compact mode, whose whole point is removing holes, takes them; the global
   * layout, whose point is mirroring Elektron's, does not.
   */
  useEmptySourceTracks?: boolean;
  /**
   * Allocate destinations per pattern instead of once for the whole project.
   *
   * Off by default, which keeps the global map: a sound gets the same DN2 track in every
   * pattern, so a mute or a level tweak still means the same thing after a pattern change,
   * at the cost of leaving a promoted track silent in patterns that do not use its sound.
   *
   * On, each pattern is packed independently from the lowest free destination up. No holes,
   * and a pattern needing three extra tracks gets them even when the project as a whole
   * overflows — but the same sound can land on different tracks in different patterns, so
   * mutes and mixer positions stop carrying across a pattern change.
   */
  compactPerPattern?: boolean;
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
   * Give every sound whose name starts with the same word one shared DN2 track.
   *
   * `HH CLOSED`, `HH OPEN` and `HH DL` become one `HH` track instead of three, which is what
   * a kit would do anyway and leaves tracks for sounds that would otherwise overflow. Where
   * two members want the same step, the lower-ranked one **does not move** — it stays
   * sound-locked on its origin track, the same lossless fallback overflow uses.
   *
   * Off by default: it changes the layout a user may already have on the device, and it
   * depends on naming discipline. See `aggregate.ts` for why the name and not the tag.
   */
  aggregateByName?: boolean;
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
  /** DN1 synth tracks (0-based) found unused, whose DN2 counterparts were offered. */
  unusedSourceTracks: number[];
  assignments: Assignment[];
  /**
   * Per-pattern allocation, present only when `compactPerPattern` was requested. The writer
   * prefers it over `assignments`, which then describes the global layout for reporting
   * only. Keyed by pattern index; patterns with no trigs are absent.
   */
  perPattern?: Map<number, { assignments: Assignment[]; overflow: SoundUsage[] }>;
  /** Sounds that could not be promoted. They stay sound-locked on their origin track. */
  overflow: SoundUsage[];
  /** Trigs that stay sound-locked because their sound was not promoted. */
  overflowTrigs: number;
  /** Trigs that move to a promoted track. */
  promotedTrigs: number;
}
