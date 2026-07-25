/**
 * Track budget: which DN2 tracks are available to promoted sounds.
 *
 * The DN1 has 8 tracks (4 synth + 4 MIDI). The DN2 has 16, each either synth or MIDI, drawn
 * from one shared pool. Elektron's own import lays them out positionally, verified by
 * counting trigger records across all nine matched pairs and every one of their 128
 * patterns:
 *
 *   DN1 synth track N  ->  DN2 track N     (1-4)
 *   DN1 MIDI  track N  ->  DN2 track 4+N   (5-8)
 *   DN2 tracks 9-16    ->  zero trigs, in every project, always
 */

import { SYNTH_TRACK_COUNT, TRACK_COUNT } from "../project/dn1.js";
import { DN2_TRACK_COUNT } from "./types.js";

/** First DN2 track that an import never touches. */
export const FIRST_ALWAYS_FREE_TRACK = 9;

/** Where a DN1 MIDI track lands on the DN2. */
export function midiTrackDestination(dn1TrackIndex: number): number {
  return dn1TrackIndex + 1;
}

/**
 * Destinations available to promoted sounds, in fill order.
 *
 * Tracks 9-16 are guaranteed free regardless of MIDI usage, because the import reserves
 * 5-8 for MIDI whether or not they are used. Freed MIDI tracks are appended AFTER them, so
 * enabling `useFreedMidiTracks` only adds capacity at the tail and never changes which
 * sounds win.
 */
export function defaultDestinations(
  usedMidiTracks: readonly number[],
  useFreedMidiTracks: boolean,
): number[] {
  const tracks: number[] = [];
  for (let t = FIRST_ALWAYS_FREE_TRACK; t <= DN2_TRACK_COUNT; t++) tracks.push(t);

  if (useFreedMidiTracks) {
    for (let dn1 = SYNTH_TRACK_COUNT; dn1 < TRACK_COUNT; dn1++) {
      if (!usedMidiTracks.includes(dn1)) tracks.push(midiTrackDestination(dn1));
    }
  }
  return tracks;
}
