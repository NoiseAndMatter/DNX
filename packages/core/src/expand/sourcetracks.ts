/**
 * Reading concern: which DN1 synth tracks is the project not using?
 *
 * A DN1 synth track that never fires a trig still reserves its DN2 counterpart, because the
 * conversion mirrors Elektron's positional layout. When that track also carries nothing but
 * the factory init sound, the reservation protects nothing and the slot is better spent on a
 * promoted sound.
 *
 * ## The rule
 *
 * A source track is unused when, across the whole project, it fires **no trig in any
 * pattern** and its kit sound is the **factory init sound in all 128 kits**.
 *
 * The trig count alone is not enough. Measured across the 55-project corpus, 48 synth tracks
 * never fire a trig — but **13 of them hold a real patch** (`WHALE_O1`, `FAVPAD`,
 * `TX BASS 1 MF`, `SHY DREAMER`...). Those were loaded deliberately, most plausibly to play
 * live from a keyboard, and taking the track would lose them. The remaining **35** hold the
 * init sound in every kit and are free.
 *
 * ## Why a fingerprint rather than the name
 *
 * An untouched sound is named `SOUND 1`..`SOUND 4`, and "identical in every kit and still
 * factory-named" picks out exactly the same 35 tracks on this corpus. It is the weaker test
 * though: a sound whose parameters were edited but which was never renamed passes it and
 * would be thrown away. Comparing the parameters themselves cannot make that mistake.
 *
 * The fingerprint blanks the 16-byte name field before hashing, so one constant covers all
 * four tracks despite their differing default names.
 *
 * **If a future DN1 OS ships a different init sound its fingerprint will not match, and no
 * track will be freed.** That is the correct way to fail: the feature stops working, nothing
 * is lost.
 *
 * Deliberately **not** done: renumbering the surviving tracks to close the gap. Freeing track
 * 2 makes exactly as many destinations available as shifting tracks 3 and 4 down into it, and
 * shifting would cost the positional 1:1 property, a permutation of the per-track MIDI
 * channel array in the DN1 tail, and a song-table guard. See `docs/ROADMAP.md`.
 */

import { SYNTH_TRACK_COUNT, readKit, readPattern } from "../project/dn1.js";
import { crc32ZeroInit } from "../project/checksum.js";
import { DN1_LAYOUT } from "../project/dn2image.js";
import { SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "../project/soundmap.js";

/**
 * CRC-32 of a 302-byte DN1 project sound holding the factory init patch, with its name field
 * blanked. Taken from an empty project saved by a Digitone 1 on OS 1.42A.
 *
 * This is Elektron's factory default, not anyone's music.
 */
export const DN1_INIT_SOUND_FINGERPRINT = 0x7081f2f9;

/** Fingerprint a sound object ignoring its name, so all four init variants agree. */
export function soundFingerprint(data: Uint8Array): number {
  const withoutName = Uint8Array.from(data);
  // The name differs per track and is not hashed.
  withoutName.fill(0, SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  return crc32ZeroInit(withoutName) >>> 0;
}

/**
 * DN1 synth tracks (0-based) the project never uses and whose sound is untouched.
 *
 * Conservative by construction: anything unclear leaves the track reserved, which is the
 * behaviour that cannot lose a sound.
 */
export function findUnusedSynthTracks(image: Uint8Array): number[] {
  const trigCounts = new Array<number>(SYNTH_TRACK_COUNT).fill(0);
  for (let p = 0; p < DN1_LAYOUT.patternCount; p++) {
    const pattern = readPattern(image, p);
    for (let track = 0; track < SYNTH_TRACK_COUNT; track++) {
      trigCounts[track]! += pattern.tracks[track]?.trigs.length ?? 0;
    }
  }

  const candidates = new Set(trigCounts.flatMap((count, track) => (count === 0 ? [track] : [])));
  if (candidates.size === 0) return [];

  // One pass over the kits, dropping candidates as they disqualify themselves, rather than
  // 128 kit reads per track.
  for (let k = 0; k < DN1_LAYOUT.patternCount && candidates.size > 0; k++) {
    const kit = readKit(image, k);
    for (const track of [...candidates]) {
      const sound = kit.sounds[track];
      if (!sound || soundFingerprint(sound.data) !== DN1_INIT_SOUND_FINGERPRINT) {
        candidates.delete(track);
      }
    }
  }

  return [...candidates].sort((a, b) => a - b);
}
