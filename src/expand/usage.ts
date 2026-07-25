/**
 * Reading concern: what does this project actually use?
 *
 * Walks every pattern and reports which sound-pool slots are referenced by sound locks,
 * how often, and from where. Knows nothing about tracks, rules or allocation.
 *
 * ## Why one sound can produce more than one candidate
 *
 * A sound locked on several source tracks is normally a single promotion candidate: merging
 * its trigs onto one destination costs one track instead of two, and DN2 tracks are
 * polyphonic so simultaneous notes merge cleanly.
 *
 * But a destination track's **length and speed are written per pattern from one source
 * track**. Merging two source tracks that disagree would play the second one's trigs at the
 * wrong length — a silent musical error, since nothing is lost or duplicated, the music just
 * runs at the wrong period. So source tracks that ever disagree, in a pattern where both
 * carry the sound, are split into separate candidates and compete for their own tracks.
 *
 * Measured across the 53-project corpus: 70 sounds are locked on more than one source track,
 * 15 (sound, pattern) pairs actually draw on two at once, and only **2** of those disagree —
 * both in `040 250314-D&B`. So the split almost never costs a track, and where it does the
 * alternative was wrong.
 *
 * The pattern-level scale settings — master length (RESET), change length (CHNG) and
 * per-pattern vs per-track mode — need no comparison here. They belong to the pattern, not
 * the track, so two tracks in the same pattern always agree on them by construction.
 */

import { SYNTH_TRACK_COUNT, TRACK_COUNT, readPattern, readSoundPool } from "../project/dn1.js";
import { decodeTags } from "../project/tags.js";
import type { SoundUsage } from "./types.js";

export interface UsageReport {
  /** Promotion candidates, in pool-slot order. A slot yields more than one when its source
   *  tracks are not merge-compatible; see the module comment. */
  usage: SoundUsage[];
  /** Patterns containing at least one trig on any track. */
  livePatterns: number[];
  /** DN1 MIDI tracks (0-based, 4..7) that carry trigs. */
  usedMidiTracks: number[];
}

/** What a destination track inherits from its source, and therefore what must match. */
function trackProfile(length: number, speed: number): string {
  return `len${length}/speed${speed}`;
}

interface Contribution {
  trigCount: number;
  patterns: Set<number>;
}

/**
 * Split a slot's source tracks into groups that may share a destination track.
 *
 * `conflicts` holds unordered pairs that must not be merged. Tracks are considered in
 * ascending order and each joins the first group it does not conflict with, which for the
 * two or three tracks a real sound uses is exactly optimal.
 */
function mergeGroups(tracks: number[], conflicts: ReadonlySet<string>): number[][] {
  const groups: number[][] = [];
  for (const track of [...tracks].sort((a, b) => a - b)) {
    const group = groups.find((g) => g.every((other) => !conflicts.has(pairKey(other, track))));
    if (group) group.push(track);
    else groups.push([track]);
  }
  return groups;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Collect every sound-lock usage across the project.
 *
 * Sound locks only exist on synth tracks — verified across the corpus, where 4,047 locks
 * appear on tracks 0-3 and exactly zero on the MIDI tracks 4-7. MIDI tracks are still
 * walked, because whether they carry trigs decides if their DN2 counterpart is free.
 */
export function collectSoundUsage(
  image: Uint8Array,
  /** Patterns to consider. Defaults to all 128; pass one pattern for per-pattern planning. */
  patterns: Iterable<number> = Array.from({ length: 128 }, (_, i) => i),
): UsageReport {
  const pool = readSoundPool(image);
  const livePatterns: number[] = [];
  const usedMidi = new Set<number>();

  /** slot -> source track -> what it contributes. */
  const contributions = new Map<number, Map<number, Contribution>>();
  /** slot -> pairs of source tracks that must not share a destination. */
  const conflicts = new Map<number, Set<string>>();

  for (const p of patterns) {
    let live = false;
    /** slot -> source track -> profile, within this pattern only. */
    const profiles = new Map<number, Map<number, string>>();

    for (const track of readPattern(image, p).tracks) {
      if (track.trigs.length === 0) continue;
      live = true;

      if (track.index >= SYNTH_TRACK_COUNT && track.index < TRACK_COUNT) {
        usedMidi.add(track.index);
        continue;
      }

      for (const trig of track.trigs) {
        if (trig.soundLock === undefined) continue;

        let bySource = contributions.get(trig.soundLock);
        if (!bySource) contributions.set(trig.soundLock, (bySource = new Map()));

        let contribution = bySource.get(track.index);
        if (!contribution) bySource.set(track.index, (contribution = { trigCount: 0, patterns: new Set() }));

        contribution.trigCount++;
        contribution.patterns.add(p);

        let byTrack = profiles.get(trig.soundLock);
        if (!byTrack) profiles.set(trig.soundLock, (byTrack = new Map()));
        byTrack.set(track.index, trackProfile(track.length, track.speed));
      }
    }

    // Two source tracks carrying the same sound in the same pattern conflict when the
    // destination could not serve both: one length and speed, two different requirements.
    for (const [slot, byTrack] of profiles) {
      const entries = [...byTrack];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [trackA, profileA] = entries[i]!;
          const [trackB, profileB] = entries[j]!;
          if (profileA === profileB) continue;
          let set = conflicts.get(slot);
          if (!set) conflicts.set(slot, (set = new Set()));
          set.add(pairKey(trackA, trackB));
        }
      }
    }

    if (live) livePatterns.push(p);
  }

  const usage: SoundUsage[] = [];
  for (const slot of [...contributions.keys()].sort((a, b) => a - b)) {
    const bySource = contributions.get(slot)!;
    const groups = mergeGroups([...bySource.keys()], conflicts.get(slot) ?? new Set());
    const tagBits = pool[slot]?.tagBits ?? 0;

    groups.forEach((sourceTracks, variant) => {
      const patterns = new Set<number>();
      let trigCount = 0;
      for (const track of sourceTracks) {
        const contribution = bySource.get(track)!;
        trigCount += contribution.trigCount;
        for (const p of contribution.patterns) patterns.add(p);
      }

      usage.push({
        poolSlot: slot,
        variant,
        name: pool[slot]?.name ?? "",
        trigCount,
        patterns: [...patterns].sort((a, b) => a - b),
        sourceTracks,
        tagBits,
        tags: decodeTags(tagBits),
      });
    });
  }

  return { usage, livePatterns, usedMidiTracks: [...usedMidi].sort((a, b) => a - b) };
}
