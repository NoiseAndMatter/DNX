/**
 * Policy concern: which destination tracks does a sound prefer, given its tags?
 *
 * Pure functions over tags. Knows nothing about images, patterns or what is currently free.
 */

import { MELODIC_TAGS, PERCUSSIVE_TAGS, soundCharacter, type TagName } from "../project/tags.js";
import type { MixedPolicy, PlacementRule, SoundUsage } from "./types.js";

const PERCUSSIVE: readonly TagName[] = [...PERCUSSIVE_TAGS];
const MELODIC: readonly TagName[] = [...MELODIC_TAGS];

/**
 * The convention this was built for: percussion low, melodic high.
 *
 * Note tracks 1-8 normally hold the DN1 home sounds and MIDI tracks, so under the default
 * preserve layout a percussion rule targeting 1-8 will mostly fall through to the free
 * pool. It becomes meaningful in rearrange mode, or when MIDI tracks are unused and
 * `useFreedMidiTracks` is on.
 */
export const PERCUSSION_LOW_RULES: readonly PlacementRule[] = [
  { name: "percussion low", tags: PERCUSSIVE, tracks: [1, 2, 3, 4, 5, 6, 7, 8] },
  { name: "melodic high", tags: MELODIC, tracks: [9, 10, 11, 12, 13, 14, 15, 16] },
];

/**
 * Pick the rule that should place a sound, or undefined to leave it to the fallback pool.
 *
 * When several rules match — which for the default set means the sound is tagged both
 * percussive and melodic — the tie is broken by policy rather than by rule order, so the
 * decision is visible and configurable instead of being an accident of how rules were
 * listed. That case is common: 85 of 283 sound-locked sounds in the corpus carry both, and
 * it is frequently deliberate. CLAP SM is tagged BRASS and PERCUSSION.
 */
export function matchRule(
  usage: SoundUsage,
  rules: readonly PlacementRule[],
  mixedPolicy: MixedPolicy,
): PlacementRule | undefined {
  const matches = rules.filter((r) => r.tags.some((t) => usage.tags.includes(t)));
  if (matches.length <= 1) return matches[0];

  if (mixedPolicy === "none") return undefined;
  if (soundCharacter(usage.tagBits) !== "mixed") return matches[0];

  const preferred = mixedPolicy === "percussive-first" ? PERCUSSIVE : MELODIC;
  return matches.find((r) => r.tags.some((t) => preferred.includes(t))) ?? matches[0];
}
