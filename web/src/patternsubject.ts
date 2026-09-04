/**
 * Turning one pattern of a real project into something the analysis charts can draw.
 *
 * ## Why this is not inside `analysis/`
 *
 * Nothing under `web/src/analysis/` knows what a project is, and that is the whole reason a kit, a
 * preset bank or two projects side by side can become analysis subjects later without touching a
 * chart. This module is the first **producer**: it reads a decoded image and hands back an
 * `AnalysisSubject`. A second producer is a new file beside this one, not a change to the charts.
 *
 * It lives in `web/src/` rather than `src/` because it imports the subject types from
 * `web/src/analysis/`, and **`src/` never imports from `web/`**.
 *
 * ## Digitone II only, and it says so rather than guessing
 *
 * The DN1 keeps its patterns in a different shape and its trigs are read by a different reader.
 * Pointing this at a DN1 image would walk DN2 offsets over DN1 bytes and produce charts of
 * confident nonsense, which is worse than no charts.
 */

import { auditPool } from "../../src/librarian/poolaudit.js";
import { summariseKitTracks } from "../../src/librarian/tracksummary.js";
import type { Device } from "../../src/librarian/device.js";
import { DN2_LAYOUT, kitRecord } from "../../src/project/dn2image.js";
import { readDn2Pattern } from "../../src/project/dn2pattern.js";
import { patternName } from "../../src/sheet/naming.js";
import type { AnalysisSubject, AnalysisTrack, AnalysisTrig } from "./analysis/model.js";

export class PatternSubjectError extends Error {}

/**
 * Voices the instrument can sound at once.
 *
 * A property of the machine, not a field in any file — nothing in a project says how many voices
 * the thing playing it has. Kept here rather than in `DeviceSpec` because this is the only reader
 * that wants it; the moment a second one does, principle 2 moves it up.
 */
const VOICES: Record<string, number> = { dn2: 16, dn1: 8 };

/**
 * Speed enum to the multiplier it means.
 *
 * `TRACK_SPEED` in `dn2pattern.ts` gives these as display strings — `"3/2x"` — which is right for a
 * label and useless for arithmetic. Same table, read as numbers.
 */
const SPEED: Record<number, number> = {
  0: 2, 1: 1.5, 2: 1, 3: 0.75, 4: 0.5, 5: 0.25, 6: 0.125,
};

/**
 * The velocity above which a trig reads as an accent.
 *
 * **Measured, not assumed.** Every one of the 1,024 tracks across four corpus projects (four
 * projects x 16 patterns x 16 tracks) carries a default velocity of exactly 100, so this is the
 * device's default rather than a number somebody liked. The pattern's own tracks are still read
 * below in case a project ever disagrees; this is only the fallback for a pattern with no tracks.
 */
const DEVICE_DEFAULT_VELOCITY = 100;

/** The most common default velocity among a pattern's tracks. */
function accentThreshold(defaults: readonly number[]): number {
  if (defaults.length === 0) return DEVICE_DEFAULT_VELOCITY;
  const counts = new Map<number, number>();
  for (const v of defaults) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Read one pattern of a decoded project image as an analysis subject.
 *
 * `index` is the pattern slot, 0-based, exactly as the grid numbers them.
 */
export function patternSubject(
  image: Uint8Array,
  device: Device,
  index: number,
): AnalysisSubject {
  if (device.kind !== "dn2") {
    throw new PatternSubjectError(
      `analysis reads Digitone II patterns, and this is a ${device.name}. The DN1's trigs come out ` +
        `of a different reader with a different shape, and running this over its bytes would draw ` +
        `charts of something that is not there.`,
    );
  }

  const pattern = readDn2Pattern(image, index, DN2_LAYOUT);
  const kit = summariseKitTracks(kitRecord(image, index, DN2_LAYOUT));

  /*
   * **The pool is read for this pattern alone.** `auditPool` walks every pattern by default, which
   * is 128 pattern records to answer a question about one — and it is called again on every
   * selection change. Scoping it keeps the lock counts irrelevant here and the slot *names*, which
   * are what a sound lock has to be turned into, exactly as correct.
   */
  const pool = new Map(
    auditPool(image, device, { patterns: [index] }).slots.map((s) => [s.index, s]),
  );

  /*
   * **Per-track lengths only exist when the pattern says they do.**
   *
   * Every track record carries a length whether or not the pattern is using it. With `SCALE` set
   * per-pattern — 51 of the 64 corpus patterns measured — the sequencer plays every track at the
   * master length and the stored per-track values are stale leftovers. Drawing those would invent
   * a polymeter the instrument is not playing, and the realign chart exists precisely to say how
   * long the pattern really takes.
   */
  const lengthOf = (trackLength: number) =>
    pattern.perTrackScale ? trackLength : pattern.length;

  const tracks: AnalysisTrack[] = pattern.tracks.map((track) => {
    const half = kit[track.index];
    const trigs: AnalysisTrig[] = track.trigs
      // A lock trig carries parameter locks and sounds nothing. It is not a note.
      .filter((trig) => trig.hasNote && trig.notes.length > 0)
      .map((trig) => {
        const lockName = trig.soundLock === undefined
          ? undefined
          : pool.get(trig.soundLock)?.name;
        return {
          step: trig.step,
          notes: trig.notes,
          // Undefined means the track default sounds, so that is what the trig is actually played
          // at — 599 of the 695 trigs measured carry no lock of their own.
          velocity: trig.velocity ?? track.settings.defaultVelocity,
          // Not a duration. See `gateLengthKnown` below and `AnalysisTrig.length`.
          length: 1,
          microTiming: trig.microTiming,
          // An empty name is what the device leaves in an unnamed slot; the track's own preset is
          // a better answer than a blank, and a lock to a slot the pool cannot name is not a lock
          // anybody can act on.
          ...(lockName ? { lockPreset: lockName } : {}),
        };
      });

    return {
      number: track.index + 1,
      length: lengthOf(track.length),
      speed: SPEED[track.speed] ?? 1,
      ...(half?.midi ? {} : { machine: half?.machineValue }),
      preset: half?.presetName || "—",
      trigs,
    };
  });

  return {
    label: `${patternName(index)} · ${pattern.name || "unnamed"}`,
    tempo: pattern.tempo,
    masterLength: pattern.length,
    voiceBudget: VOICES[device.kind] ?? 16,
    defaultVelocity: accentThreshold(pattern.tracks.map((t) => t.settings.defaultVelocity)),
    /*
     * **Always false for a real project, and that is a statement about the format.**
     *
     * The trig carries a note-length byte and nothing decodes it into a duration.
     * `dn2-pattern-format.md` marks the track default at `+0x02` as INFERRED — the *name* is from
     * its position in the DN1 block, not from a capture — and no capture has walked the trig
     * field's values against what the instrument shows. Until one does, every gate here is 1 step
     * because it has to be something, and every chart that reads a gate has to be left undrawn.
     */
    gateLengthKnown: false,
    tracks,
  };
}
