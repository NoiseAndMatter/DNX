/**
 * Trig routing: given an expansion plan, decide which DN2 track each DN1 trig ends up on.
 *
 * A pure mapping, computed per pattern. It knows nothing about bytes — the writer consumes
 * it. Keeping it separate means the routing decisions can be tested and inspected on their
 * own, and a UI can show "this trig moves from track 1 to track 9" without touching an
 * image.
 *
 * The rule is simple and comes from docs/expansion-design.md:
 *
 * - A trig with no sound lock plays the track's home sound and stays where it is.
 * - A trig sound-locked to a promoted sound moves to that sound's destination track, and
 *   its sound lock is cleared, because the sound is now the destination track's own.
 * - A trig sound-locked to a sound that was not promoted stays put, lock intact. That is
 *   the lossless fallback: the pattern plays exactly as it did on the DN1.
 */

import { SYNTH_TRACK_COUNT, type Dn1Pattern, type Dn1Track, type Dn1Trig } from "../project/dn1.js";
import type { ExpansionPlan } from "./types.js";

export interface RoutedTrig {
  trig: Dn1Trig;
  /** DN1 track the trig came from, 0..7. */
  sourceTrack: number;
  /** DN2 track it lands on, 0..15. Equal to `sourceTrack` when it does not move. */
  destinationTrack: number;
  /**
   * True when the trig was promoted and its sound lock must be dropped. The destination
   * track carries the sound as its own, so leaving the lock would be redundant at best and
   * point at the wrong pool slot at worst.
   */
  clearSoundLock: boolean;
}

export interface PatternRouting {
  /** Every trig in the pattern, in DN1 track then step order. */
  routed: RoutedTrig[];
  /** Trigs landing on each DN2 track, indexed 0..15. */
  byDestination: Map<number, RoutedTrig[]>;
  /** How many trigs actually changed track. */
  moved: number;
  /** DN2 tracks that received at least one promoted trig. */
  destinationsUsed: Set<number>;
}

/** Pool slot -> destination DN2 track, 0-based, from the plan's assignments. */
export function destinationsBySound(plan: ExpansionPlan): Map<number, number> {
  return new Map(plan.assignments.map((a) => [a.usage.poolSlot, a.dn2Track - 1]));
}

/**
 * Route one pattern's trigs.
 *
 * `destinations` comes from `destinationsBySound`. Pass an empty map for a faithful
 * conversion with no promotion — every trig stays on its own track.
 */
export function routePattern(
  pattern: Dn1Pattern,
  destinations: ReadonlyMap<number, number>,
): PatternRouting {
  const routed: RoutedTrig[] = [];
  const byDestination = new Map<number, RoutedTrig[]>();
  const destinationsUsed = new Set<number>();
  let moved = 0;

  for (const track of pattern.tracks) {
    for (const trig of track.trigs) {
      const promoted =
        track.index < SYNTH_TRACK_COUNT && trig.soundLock !== undefined
          ? destinations.get(trig.soundLock)
          : undefined;

      const destinationTrack = promoted ?? track.index;
      const entry: RoutedTrig = {
        trig,
        sourceTrack: track.index,
        destinationTrack,
        clearSoundLock: promoted !== undefined,
      };

      if (promoted !== undefined) {
        moved++;
        destinationsUsed.add(promoted);
      }

      routed.push(entry);
      const bucket = byDestination.get(destinationTrack);
      if (bucket) bucket.push(entry);
      else byDestination.set(destinationTrack, [entry]);
    }
  }

  // Within a destination, keep step order — the trigger array is written in this order and
  // Elektron's own output is sorted by track then step.
  for (const bucket of byDestination.values()) bucket.sort((a, b) => a.trig.step - b.trig.step);

  return { routed, byDestination, moved, destinationsUsed };
}

/**
 * Two trigs cannot occupy the same step of the same destination track unless they can be
 * expressed as one trig. This finds the cases that cannot.
 *
 * It arises when one sound is locked on several source tracks and merged onto a single
 * destination — the dedup rule in docs/expansion-design.md. Simultaneity alone is fine,
 * since DN2 tracks are polyphonic and same-step notes merge into a chord, but conflicting
 * per-step values cannot be expressed by a single trig.
 */
export interface RoutingCollision {
  destinationTrack: number;
  step: number;
  sourceTracks: number[];
  reason: string;
}

export function findCollisions(routing: PatternRouting): RoutingCollision[] {
  const collisions: RoutingCollision[] = [];

  for (const [destinationTrack, bucket] of routing.byDestination) {
    const byStep = new Map<number, RoutedTrig[]>();
    for (const entry of bucket) {
      const at = byStep.get(entry.trig.step);
      if (at) at.push(entry);
      else byStep.set(entry.trig.step, [entry]);
    }

    for (const [step, entries] of byStep) {
      if (entries.length < 2) continue;

      const first = entries[0]!.trig;
      const differing = entries.slice(1).some((e) => {
        const t = e.trig;
        return (
          t.velocity !== first.velocity ||
          t.noteLength !== first.noteLength ||
          t.microTiming !== first.microTiming ||
          t.trigCondition !== first.trigCondition ||
          t.locks.length > 0 ||
          first.locks.length > 0
        );
      });

      if (differing) {
        collisions.push({
          destinationTrack,
          step,
          sourceTracks: entries.map((e) => e.sourceTrack),
          reason:
            "two trigs land on the same step with per-step values a single trig cannot express",
        });
      }
    }
  }

  return collisions;
}
