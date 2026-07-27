/**
 * Expansion planning: decide which sound-locked sounds get promoted to their own
 * Digitone II track, and which stay where they are.
 *
 * This module is orchestration only. The work lives in single-purpose neighbours:
 *
 *   usage.ts     reading    — what sounds does this project lock, and where?
 *   tracks.ts    budget     — which DN2 tracks are available?
 *   rules.ts     policy     — which tracks does a sound prefer, given its tags?
 *   ranking.ts   policy     — in what order are candidates considered?
 *   allocate.ts  allocation — who actually gets which track?
 *   types.ts     vocabulary shared by all of the above
 *
 * The decision layer writes nothing and does not depend on the DN1 -> DN2 sound field
 * mapping, so it can be developed and validated independently of the conversion itself.
 *
 * Rules from docs/expansion-design.md that shape all of this:
 *
 * - Scope is the WHOLE PROJECT with one global map. A sound-locked sound gets the same DN2
 *   track in every pattern it appears in, so mutes and track tweaks stay meaningful when
 *   you switch pattern.
 * - Sound identity is the sound-pool slot index. That is what makes a global map
 *   well-defined: sound locks reference a single 128-slot pool shared by the project. Home
 *   sounds are not part of the map because they live in per-pattern kits and simply stay on
 *   their own track, exactly as on the DN1.
 * - Overflow is expected and is not a failure. An unpromoted sound stays sound-locked on
 *   its origin track and the pattern plays exactly as it did on the DN1.
 */

import { allocate } from "./allocate.js";
import { groupByName, groupCandidate } from "./aggregate.js";
import { byTrigCount, rank } from "./ranking.js";
import { defaultDestinations } from "./tracks.js";
import { collectSoundUsage } from "./usage.js";
import { findUnusedSynthTracks } from "./sourcetracks.js";
import type { ExpansionPlan, PlanOptions, SoundUsage } from "./types.js";

export function planExpansion(image: Uint8Array, options: PlanOptions = {}): ExpansionPlan {
  const {
    sourceTrackOrder = [0, 1, 2, 3],
    useFreedMidiTracks = false,
    // Defaults to whatever compaction is doing: compact mode exists to remove holes, so it
    // wants these tracks; the global layout exists to mirror Elektron's, so it does not.
    // Measured across the corpus, the choice costs and gains no promotions either way — the
    // projects with a spare synth track are not the projects that overflow — so this is a
    // layout decision, not a capacity one.
    useEmptySourceTracks = options.compactPerPattern ?? false,
  } = options;
  const { usage, livePatterns, usedMidiTracks } = collectSoundUsage(image);

  const unusedSourceTracks = useEmptySourceTracks ? findUnusedSynthTracks(image) : [];
  const destinations =
    options.destinationTracks ??
    defaultDestinations(usedMidiTracks, useFreedMidiTracks, unusedSourceTracks);

  /**
   * One allocation pass, aggregating by name first when asked.
   *
   * The allocator never learns that groups exist: it is handed one candidate standing for
   * the whole family, and the track it returns is given back to every member. That is why
   * aggregation needs no changes to placement rules, pinning or ranking.
   */
  const allocateFor = (candidates: readonly SoundUsage[]) => {
    const ranked = rank(candidates, byTrigCount(sourceTrackOrder));
    const common = {
      destinations,
      rules: options.rules,
      pins: options.pins,
      mixedPolicy: options.mixedPolicy,
    };
    if (!options.aggregateByName) return allocate({ ranked, ...common });

    const groups = groupByName(ranked);
    const byCandidate = new Map(groups.map((g) => [groupCandidate(g), g]));
    const result = allocate({ ranked: [...byCandidate.keys()], ...common });

    return {
      assignments: result.assignments.map((a) => {
        const members = byCandidate.get(a.usage)?.members;
        return members && members.length > 1 ? { ...a, groupMembers: members } : a;
      }),
      // A group that missed out puts every one of its members into overflow: none of them
      // got a track, and reporting only the leader would understate what stayed behind.
      overflow: result.overflow.flatMap((u) => byCandidate.get(u)?.members ?? [u]),
    };
  };

  const { assignments, overflow } = allocateFor(usage);

  const plan: ExpansionPlan = {
    livePatterns,
    usedMidiTracks,
    freeTracks: [...destinations],
    unusedSourceTracks,
    assignments,
    overflow,
    overflowTrigs: overflow.reduce((n, u) => n + u.trigCount, 0),
    promotedTrigs: assignments.reduce((n, a) => n + a.usage.trigCount, 0),
  };

  if (options.compactPerPattern) {
    plan.perPattern = new Map(
      livePatterns.map((p) => {
        const { usage: candidates } = collectSoundUsage(image, [p]);
        return [p, allocateFor(candidates)];
      }),
    );
  }

  return plan;
}

// Convenience re-exports so callers need one import for the common case.
export { collectSoundUsage } from "./usage.js";
export { midiTrackDestination, defaultDestinations } from "./tracks.js";
export { findUnusedSynthTracks } from "./sourcetracks.js";
export { PERCUSSION_LOW_RULES } from "./rules.js";
export { groupByName, groupCandidate, nameKey } from "./aggregate.js";
export { DN2_TRACK_COUNT } from "./types.js";
export type {
  Assignment,
  ExpansionPlan,
  MixedPolicy,
  PlacementReason,
  PlacementRule,
  PlanOptions,
  SoundUsage,
} from "./types.js";
