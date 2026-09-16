/**
 * Turning one pattern of a Digitone 1 project into something the analysis charts can draw.
 *
 * The second producer, beside `patternsubject.ts`. The rule that file states — a new source is a
 * new producer, not a change to the charts — is what this one is here to honour: nothing under
 * `web/src/analysis/` learned anything about the Digitone 1 to make this work.
 *
 * ## What a Digitone 1 pattern is, next to a Digitone II's
 *
 * | | Digitone 1 | Digitone II |
 * |---|---|---|
 * | tracks | 4 synth (T1-T4) and 4 MIDI (A-D) | 16, MIDI marked by a kit flag |
 * | steps | 64 | 128 |
 * | voices | 8 | 16 |
 * | machines | FM TONE only | four |
 * | pattern length | not found: each track carries its own | `+0x14`, with a per-track mode |
 * | note length | byte read, meaning unknown | captured 2026-09-06 |
 *
 * Two of those rows decide what this producer may say, and both are said through the subject
 * rather than worked around: `gateLengthKnown` is **false**, and `masterLength` is derived from
 * the track lengths rather than read from a field nobody has found.
 */

import {
  RECORD_VERSION as DN1_RECORD_VERSION, SYNTH_TRACK_COUNT as DN1_SYNTH_TRACKS,
  TRACK as DN1_TRACK, readKit, readPattern, readSoundPool,
  type Dn1Sound, type Dn1Track,
} from "../../src/project/dn1.js";
import { MACHINE } from "../../src/project/machine.js";
import type { Device } from "../../src/librarian/device.js";
import { patternName } from "../../src/sheet/naming.js";
import { PatternSubjectError } from "./patternsubject.js";
import type { AnalysisSubject, AnalysisTrack, AnalysisTrig } from "./analysis/model.js";

/** Voices a Digitone 1 can sound at once. A property of the machine, not a field in any file. */
const VOICES = 8;

/** The velocity a track falls back to when its settings block cannot be read. */
const DEVICE_DEFAULT_VELOCITY = 100;

/** What the instrument calls each MIDI track. Tracks 4..7 of the record are A, B, C and D. */
const MIDI_TRACK_NAMES = ["A", "B", "C", "D"] as const;

/** The most common default velocity among a pattern's tracks, which is the accent threshold. */
function accentThreshold(defaults: readonly number[]): number {
  if (defaults.length === 0) return DEVICE_DEFAULT_VELOCITY;
  const counts = new Map<number, number>();
  for (const v of defaults) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

/** A track's default velocity, from its settings block. */
function defaultVelocityOf(track: Dn1Track): number {
  return track.settings[DN1_TRACK.settingsVelocityOffset] ?? DEVICE_DEFAULT_VELOCITY;
}

/**
 * Every note a trig sounds, root first.
 *
 * The Digitone 1 stores a chord as the root plus up to seven **signed semitone offsets**, where
 * the Digitone II stores absolute notes. An offset of zero is padding rather than a unison, which
 * is why `readPattern` trims the trailing ones and this drops the rest: a chord record of
 * `3C 00 04 00 07` is a root with two notes on it, not a five-note stack with two doublings.
 */
function notesOf(note: number, chord: readonly number[]): number[] {
  const notes = [note];
  for (const offset of chord) {
    if (offset === 0) continue;
    const absolute = note + offset;
    if (absolute >= 0 && absolute <= 127) notes.push(absolute);
  }
  return notes;
}

/**
 * Read one pattern of a decoded Digitone 1 image as an analysis subject.
 *
 * `index` is the pattern slot, 0-based, exactly as the grid numbers them.
 */
export function dn1PatternSubject(
  image: Uint8Array,
  device: Device,
  index: number,
): AnalysisSubject {
  if (device.kind !== "dn1") {
    throw new PatternSubjectError(`this reads Digitone 1 patterns, and this is a ${device.name}.`);
  }

  /*
   * **The record's version is checked before anything is read out of it**, exactly as the Digitone
   * II producer does and for the same reason: a record at another version keeps its interior
   * somewhere else, so reading one produces plausible numbers that are measurements of nothing.
   * Every one of the 6,784 pattern records in the corpus is version 10, so this has never fired on
   * a real file, which is not a reason to leave it out.
   */
  const summary = device.summarise(image, index);
  if (!summary.readable) {
    throw new PatternSubjectError(
      `${patternName(index)} is a version ${summary.version} pattern record, and this reads ` +
        `version ${DN1_RECORD_VERSION}. The interior offsets move between versions, so anything ` +
        `drawn from it would be measured from the wrong bytes.`,
    );
  }

  const pattern = readPattern(image, index);
  const kit = readKit(image, index);
  const pool = readSoundPool(image);
  const poolName = (slot: number): string | undefined => {
    const sound: Dn1Sound | undefined = pool[slot];
    return sound?.name || undefined;
  };

  const tracks: AnalysisTrack[] = pattern.tracks.map((track) => {
    const synth = track.kind === "synth";
    const defaultVelocity = defaultVelocityOf(track);
    /*
     * A track length outside the 1..64 a Digitone 1 sequencer plays falls back to the 16 the
     * instrument defaults to, rather than being drawn: every chart here divides by a length.
     * `+0x0C` is INFERRED, and all 18 values it takes across the corpus are legal lengths, so this
     * guards a reading rather than a file.
     */
    const stored = track.length;
    const length = stored >= 1 && stored <= 64 ? stored : 16;

    const notes: AnalysisTrig[] = track.trigs
      // A lock trig carries parameter locks and sounds nothing. It is not a note.
      .filter((trig) => trig.hasNote && trig.note !== undefined)
      .map((trig) => {
        const lockName = trig.soundLock === undefined ? undefined : poolName(trig.soundLock);
        return {
          step: trig.step,
          notes: notesOf(trig.note as number, trig.chord),
          velocity: trig.velocity ?? defaultVelocity,
          /*
           * **1, because the Digitone 1's note-length byte has never been captured.**
           * `docs/dn1-project-format.md` lists the value-to-duration table as UNKNOWN, and the
           * subject says so through `gateLengthKnown` below. This is the same placeholder the
           * Digitone II producer carried until its own table was measured on 2026-09-06.
           */
          length: 1,
          microTiming: trig.microTiming,
          // The code is read; what it means is not. See `AnalysisTrig.conditional`.
          ...(trig.trigCondition === undefined ? {} : { conditional: true }),
          // A lock to a slot the pool cannot name is not a lock anybody can act on.
          ...(lockName ? { lockPreset: lockName } : {}),
        };
      });

    /*
     * **A track record holds 64 steps whatever its LEN says.** The same split the Digitone II
     * producer makes, for the same reason: trigs past the end are in the file and do not play, and
     * counting them among the ones that do overstates the note count and the pitch content.
     */
    const dormant = notes.filter((trig) => trig.step >= length);

    return {
      number: track.index + 1,
      ...(synth
        ? {}
        : { label: MIDI_TRACK_NAMES[track.index - DN1_SYNTH_TRACKS] ?? `M${track.index}` }),
      length,
      /*
       * **No speed, deliberately.** `+0x0D` is marked SPECULATIVE in the format notes: it takes
       * six values where the instrument offers seven settings, and which value means which
       * multiplier is a guess. `undefined` is what the subject means by "an enum value nothing has
       * named", and every consumer already treats it as 1x for arithmetic while declining to print
       * a multiplier it cannot stand behind.
       */
      machine: synth ? MACHINE.fmTone : MACHINE.midi,
      // The Digitone 1 has no named kits, and a MIDI track has no preset to name.
      preset: (synth ? kit.sounds[track.index]?.name : "") || "—",
      trigs: notes.filter((trig) => trig.step < length),
      ...(dormant.length ? { dormant } : {}),
    };
  });

  /*
   * **The lengths are the only evidence, so they are what this reports.**
   *
   * A Digitone II pattern carries a SCALE mode and a master LENGTH field. Nothing in the Digitone 1
   * pattern record has been identified as either — `docs/dn1-project-format.md` accounts for the
   * name, the tempo and the slot index, and nothing length-shaped — so this describes the file
   * rather than claiming a mode: tracks that all agree have a master length, tracks that differ do
   * not, and the window is the longest pass either way. If the SCALE byte is found later this
   * becomes a read rather than a derivation, and nothing above it changes.
   *
   * **No RESET and no CHANGE for the same reason.** Both are Digitone II pattern fields with a
   * documented offset; neither has been located here, and leaving them undefined is what tells the
   * charts to omit the reset ruler rather than draw a zero into it.
   */
  const lengths = tracks.map((t) => t.length);

  return {
    label: `${patternName(index)} · ${pattern.name || "unnamed"}`,
    tempo: pattern.tempo,
    masterLength: Math.max(...lengths),
    perTrackLengths: new Set(lengths).size > 1,
    patternTimingKnown: false,
    voiceBudget: VOICES,
    defaultVelocity: accentThreshold(pattern.tracks.map(defaultVelocityOf)),
    gateLengthKnown: false,
    tracks,
  };
}
