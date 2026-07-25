/**
 * Allocation concern: given ranked candidates and available tracks, who goes where?
 *
 * Takes candidates already in priority order and destinations already in fill order, so it
 * needs to know nothing about trigs, tags or images.
 *
 * Precedence is pins, then rules, then the free pool. Anything that finds no track
 * overflows, which is not a failure: an unpromoted sound stays sound-locked on its origin
 * track and the pattern plays exactly as it did on the DN1.
 */

import { matchRule } from "./rules.js";
import type { Assignment, MixedPolicy, PlacementRule, SoundUsage } from "./types.js";

export interface AllocationInput {
  /** Candidates in priority order. */
  ranked: readonly SoundUsage[];
  /** Destination tracks in fill order, 1-based. */
  destinations: readonly number[];
  rules?: readonly PlacementRule[];
  pins?: ReadonlyMap<number, number>;
  mixedPolicy?: MixedPolicy;
}

export interface AllocationResult {
  assignments: Assignment[];
  overflow: SoundUsage[];
}

export function allocate(input: AllocationInput): AllocationResult {
  const { ranked, destinations, rules = [], pins, mixedPolicy = "percussive-first" } = input;

  const assignments: Assignment[] = [];
  const overflow: SoundUsage[] = [];
  const taken = new Set<number>();
  const placed = new Set<number>();

  // Pins win outright, before ranking is consulted, so an explicit user choice is never
  // outbid by a heuristic. A pin onto an already-taken track is ignored rather than
  // silently displacing the other sound.
  if (pins) {
    for (const usage of ranked) {
      const track = pins.get(usage.poolSlot);
      if (track === undefined || taken.has(track)) continue;
      taken.add(track);
      placed.add(usage.poolSlot);
      assignments.push({ usage, dn2Track: track, reason: "pinned" });
    }
  }

  for (const usage of ranked) {
    if (placed.has(usage.poolSlot)) continue;

    const rule = rules.length ? matchRule(usage, rules, mixedPolicy) : undefined;
    const preferred = rule?.tracks.find((t) => destinations.includes(t) && !taken.has(t));
    const track = preferred ?? destinations.find((t) => !taken.has(t));

    if (track === undefined) {
      overflow.push(usage);
      continue;
    }

    taken.add(track);
    assignments.push(
      preferred === undefined
        ? { usage, dn2Track: track, reason: "fallback" }
        : { usage, dn2Track: track, reason: "rule", rule },
    );
  }

  assignments.sort((a, b) => a.dn2Track - b.dn2Track);
  return { assignments, overflow };
}
