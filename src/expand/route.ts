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

/**
 * A trig that wanted a shared destination but found its step already taken by another sound.
 *
 * It stays on its origin track with its sound lock intact, so nothing is lost — this records
 * that it happened, so the plan can report it rather than the user discovering it by ear.
 */
export interface BlockedTrig {
  trig: Dn1Trig;
  sourceTrack: number;
  /** The destination it would have moved to. */
  wantedTrack: number;
  /** Pool slot of the sound that holds the step. */
  heldByPoolSlot: number;
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
  /**
   * Trigs held back because another sound already owned their step on a shared destination.
   * Always empty unless `aggregateByName` put two sounds on one track.
   */
  blocked: BlockedTrig[];
}

/**
 * Key for a promotion: a sound *as locked on a particular source track*.
 *
 * The sound alone is not enough. When a sound's source tracks disagree on length or speed
 * they cannot share a destination (see `usage.ts`), so the same pool slot can be promoted to
 * two different DN2 tracks depending on where the trig came from.
 */
export function promotionKey(poolSlot: number, sourceTrack: number): string {
  return `${poolSlot}@${sourceTrack}`;
}

/** Promotion key -> destination DN2 track, 0-based, from the plan's assignments. */
export function destinationsBySound(plan: ExpansionPlan): Map<string, number> {
  const map = new Map<string, number>();
  for (const a of plan.assignments) {
    // With `aggregateByName` one assignment stands for a family of sounds, and every member
    // routes to the shared track. Without it `groupMembers` is absent and this is the single
    // sound the assignment was always about.
    for (const usage of a.groupMembers ?? [a.usage]) {
      for (const sourceTrack of usage.sourceTracks) {
        map.set(promotionKey(usage.poolSlot, sourceTrack), a.dn2Track - 1);
      }
    }
  }
  return map;
}

/**
 * Promotion key -> rank within its group, so a clash has a deterministic loser.
 *
 * Lower wins; the sound with more trigs across the project comes first, because keeping it
 * leaves the fewest trigs behind.
 *
 * **Empty unless some assignment actually merged several sounds.** That emptiness is the
 * signal `routePattern` uses to leave routing exactly as it has always been: two different
 * sounds sharing a destination is only ever deliberate, and a caller that did not ask for
 * aggregation should not have trigs held back behind its back.
 */
export function priorityBySound(plan: ExpansionPlan): Map<string, number> {
  const map = new Map<string, number>();
  for (const a of plan.assignments) {
    if (!a.groupMembers || a.groupMembers.length < 2) continue;
    a.groupMembers.forEach((usage, order) => {
      for (const sourceTrack of usage.sourceTracks) {
        map.set(promotionKey(usage.poolSlot, sourceTrack), order);
      }
    });
  }
  return map;
}

/**
 * Route one pattern's trigs.
 *
 * `destinations` comes from `destinationsBySound`. Pass an empty map for a faithful
 * conversion with no promotion — every trig stays on its own track.
 */
export function routePattern(
  pattern: Dn1Pattern,
  destinations: ReadonlyMap<string, number>,
  /**
   * Rank within a shared destination, from `priorityBySound`. Omit when no two sounds share
   * a track — without it, aggregation would let one family member overwrite another.
   */
  priority?: ReadonlyMap<string, number>,
): PatternRouting {
  const routed: RoutedTrig[] = [];
  const byDestination = new Map<number, RoutedTrig[]>();
  const destinationsUsed = new Set<number>();
  const blocked: BlockedTrig[] = [];
  let moved = 0;

  /**
   * Which sound owns each `(destination, step)`, so a second sound wanting the same step can
   * be turned back.
   *
   * Keyed by pool slot rather than by promotion key, because one sound merged from several
   * source tracks onto one destination is the existing, legitimate case — those trigs are
   * meant to coincide and `findCollisions` decides whether they can be expressed as one.
   * Only a *different* sound is a clash.
   */
  const claimed = new Map<string, { poolSlot: number; order: number }>();

  // No priority map means nothing was deliberately merged, so there is nothing to arbitrate
  // and routing stays exactly as it was before aggregation existed. Two different sounds
  // landing on one step then reaches `findCollisions`, which is where it has always been
  // reported.
  const promotionsInPriorityOrder =
    priority && priority.size > 0 ? collectPromotions(pattern, destinations, priority) : [];

  for (const { track, trig, destination, order } of promotionsInPriorityOrder) {
    const at = `${destination}:${trig.step}`;
    const owner = claimed.get(at);
    if (owner === undefined) {
      claimed.set(at, { poolSlot: trig.soundLock!, order });
    } else if (owner.poolSlot !== trig.soundLock) {
      // A different sound already has this step. The loser does not move: it stays on its
      // origin track with its lock intact, so the pattern still plays what it played on the
      // DN1. This is overflow's lossless fallback, applied per trig.
      blocked.push({
        trig,
        sourceTrack: track,
        wantedTrack: destination,
        heldByPoolSlot: owner.poolSlot,
      });
    }
  }

  const blockedTrigs = new Set(blocked.map((b) => b.trig));

  for (const track of pattern.tracks) {
    for (const trig of track.trigs) {
      const promoted =
        track.index < SYNTH_TRACK_COUNT && trig.soundLock !== undefined && !blockedTrigs.has(trig)
          ? destinations.get(promotionKey(trig.soundLock, track.index))
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

  return { routed, byDestination, moved, destinationsUsed, blocked };
}

/** Every trig that wants to move, in the order it gets to claim a step. */
function collectPromotions(
  pattern: Dn1Pattern,
  destinations: ReadonlyMap<string, number>,
  priority?: ReadonlyMap<string, number>,
): { track: number; trig: Dn1Trig; destination: number; order: number }[] {
  const promotions: { track: number; trig: Dn1Trig; destination: number; order: number }[] = [];

  for (const track of pattern.tracks) {
    if (track.index >= SYNTH_TRACK_COUNT) continue;
    for (const trig of track.trigs) {
      if (trig.soundLock === undefined) continue;
      const key = promotionKey(trig.soundLock, track.index);
      const destination = destinations.get(key);
      if (destination === undefined) continue;
      promotions.push({ track: track.index, trig, destination, order: priority?.get(key) ?? 0 });
    }
  }

  // Highest priority first so it claims contested steps. Ties keep source order, which keeps
  // routing deterministic for identical inputs.
  return promotions.sort((a, b) => a.order - b.order);
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
