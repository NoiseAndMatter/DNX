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
import { byTrigCount, rank } from "./ranking.js";
import { defaultDestinations } from "./tracks.js";
import { collectSoundUsage } from "./usage.js";
import type { ExpansionPlan, PlanOptions } from "./types.js";

export function planExpansion(image: Uint8Array, options: PlanOptions = {}): ExpansionPlan {
  const { sourceTrackOrder = [0, 1, 2, 3], useFreedMidiTracks = false } = options;
  const { usage, livePatterns, usedMidiTracks } = collectSoundUsage(image);

  const destinations =
    options.destinationTracks ?? defaultDestinations(usedMidiTracks, useFreedMidiTracks);

  const { assignments, overflow } = allocate({
    ranked: rank(usage, byTrigCount(sourceTrackOrder)),
    destinations,
    rules: options.rules,
    pins: options.pins,
    mixedPolicy: options.mixedPolicy,
  });

  const plan: ExpansionPlan = {
    livePatterns,
    usedMidiTracks,
    freeTracks: [...destinations],
    assignments,
    overflow,
    overflowTrigs: overflow.reduce((n, u) => n + u.trigCount, 0),
    promotedTrigs: assignments.reduce((n, a) => n + a.usage.trigCount, 0),
  };

  if (options.compactPerPattern) {
    plan.perPattern = new Map(
      livePatterns.map((p) => {
        const { usage: candidates } = collectSoundUsage(image, [p]);
        const allocation = allocate({
          ranked: rank(candidates, byTrigCount(sourceTrackOrder)),
          destinations,
          rules: options.rules,
          pins: options.pins,
          mixedPolicy: options.mixedPolicy,
        });
        return [p, allocation];
      }),
    );
  }

  return plan;
}

// Convenience re-exports so callers need one import for the common case.
export { collectSoundUsage } from "./usage.js";
export { midiTrackDestination, defaultDestinations } from "./tracks.js";
export { PERCUSSION_LOW_RULES } from "./rules.js";
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
