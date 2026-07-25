/**
 * Reading concern: what does this project actually use?
 *
 * Walks every pattern and reports which sound-pool slots are referenced by sound locks,
 * how often, and from where. Knows nothing about tracks, rules or allocation.
 */

import { SYNTH_TRACK_COUNT, TRACK_COUNT, readPattern, readSoundPool } from "../project/dn1.js";
import { decodeTags } from "../project/tags.js";
import type { SoundUsage } from "./types.js";

export interface UsageReport {
  /** Sound-locked sounds, keyed by pool slot. */
  usage: Map<number, SoundUsage>;
  /** Patterns containing at least one trig on any track. */
  livePatterns: number[];
  /** DN1 MIDI tracks (0-based, 4..7) that carry trigs. */
  usedMidiTracks: number[];
}

/**
 * Collect every sound-lock usage across the project.
 *
 * Sound locks only exist on synth tracks — verified across the corpus, where 4,047 locks
 * appear on tracks 0-3 and exactly zero on the MIDI tracks 4-7. MIDI tracks are still
 * walked, because whether they carry trigs decides if their DN2 counterpart is free.
 */
export function collectSoundUsage(image: Uint8Array): UsageReport {
  const pool = readSoundPool(image);
  const usage = new Map<number, SoundUsage>();
  const livePatterns: number[] = [];
  const usedMidi = new Set<number>();

  for (let p = 0; p < 128; p++) {
    let live = false;

    for (const track of readPattern(image, p).tracks) {
      if (track.trigs.length === 0) continue;
      live = true;

      if (track.index >= SYNTH_TRACK_COUNT && track.index < TRACK_COUNT) {
        usedMidi.add(track.index);
        continue;
      }

      for (const trig of track.trigs) {
        if (trig.soundLock === undefined) continue;

        let entry = usage.get(trig.soundLock);
        if (!entry) {
          const tagBits = pool[trig.soundLock]?.tagBits ?? 0;
          entry = {
            poolSlot: trig.soundLock,
            name: pool[trig.soundLock]?.name ?? "",
            trigCount: 0,
            patterns: [],
            sourceTracks: [],
            tagBits,
            tags: decodeTags(tagBits),
          };
          usage.set(trig.soundLock, entry);
        }

        entry.trigCount++;
        if (!entry.patterns.includes(p)) entry.patterns.push(p);
        if (!entry.sourceTracks.includes(track.index)) entry.sourceTracks.push(track.index);
      }
    }

    if (live) livePatterns.push(p);
  }

  return { usage, livePatterns, usedMidiTracks: [...usedMidi].sort((a, b) => a - b) };
}
