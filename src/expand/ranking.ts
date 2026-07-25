/**
 * Policy concern: in what order should sounds be considered for promotion?
 *
 * Only matters when there are more candidates than destinations. Measured across the
 * corpus, 44 of 53 projects fit with no overflow at all, so this rarely bites — which is
 * why the default metric is deliberately simple.
 *
 * docs/expansion-design.md records the alternative worth building if it ever does bite:
 * voice contention, i.e. promote the sounds that actually conflict with their track rather
 * than the ones used most. Frequency is a rough proxy at best — a sound on 16 trigs that
 * never overlaps anything is perfectly happy where it is. Swap the comparator; nothing else
 * needs to change.
 */

import type { SoundUsage } from "./types.js";

export type Ranker = (a: SoundUsage, b: SoundUsage) => number;

/**
 * Trig count, then how many patterns the sound spans, then source-track priority, then
 * pool slot so the result is stable.
 */
export function byTrigCount(sourceTrackOrder: readonly number[]): Ranker {
  const priority = (track: number) => {
    const i = sourceTrackOrder.indexOf(track);
    return i === -1 ? sourceTrackOrder.length : i;
  };

  return (a, b) => {
    if (b.trigCount !== a.trigCount) return b.trigCount - a.trigCount;
    if (b.patterns.length !== a.patterns.length) return b.patterns.length - a.patterns.length;

    const pa = Math.min(...a.sourceTracks.map(priority));
    const pb = Math.min(...b.sourceTracks.map(priority));
    if (pa !== pb) return pa - pb;

    return a.poolSlot - b.poolSlot;
  };
}

export function rank(sounds: Iterable<SoundUsage>, ranker: Ranker): SoundUsage[] {
  return [...sounds].sort(ranker);
}
