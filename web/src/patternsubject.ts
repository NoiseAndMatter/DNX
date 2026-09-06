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
import { MACHINE } from "../../src/project/machine.js";
import { summariseKitTracks } from "../../src/librarian/tracksummary.js";
import type { Device } from "../../src/librarian/device.js";
import { DN2_LAYOUT, kitRecord } from "../../src/project/dn2image.js";
import {
  NOTE_LENGTH_NONE, noteLengthSteps, readDn2Pattern,
  RECORD_VERSION as DN2_RECORD_VERSION,
} from "../../src/project/dn2pattern.js";
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
 * label and useless for arithmetic. Same seven values, read as numbers.
 *
 * **Anything else is left undefined rather than defaulted to 1.** Three of the 1,788 playing tracks
 * in the corpus carry a speed byte outside this table — 19, 32 and 120, all in `PRESETS.dn2prj` —
 * and calling those `1x` would state a speed the track is not running at.
 */
const SPEED: Record<number, number> = {
  0: 2, 1: 1.5, 2: 1, 3: 0.75, 4: 0.5, 5: 0.25, 6: 0.125,
};

/**
 * The velocity above which a trig reads as an accent, when a pattern has no tracks to ask.
 *
 * **Measured across the whole corpus, and it is not universal.** 1,722 of the 1,788 tracks that
 * actually play a note carry a default velocity of 100, so 100 is the device default — but 42 of
 * them differ from the mode of their own pattern, with 79, 89, 102, 118 and 127 all appearing in
 * real music. A first sample of four projects showed 100 everywhere and would have justified
 * hard-coding it; the corpus says otherwise, which is why the threshold is read per pattern below
 * and this constant is only the fallback for a pattern with no tracks at all.
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

  /*
   * **The record's storage version is checked before anything is read out of it**, using the same
   * rule the grid already paints as *"storage version we do not read"*.
   *
   * A record at another version has its interior offsets somewhere else, so reading one as if it
   * were version 3 does not fail — it produces plausible nonsense. `PRESETS.dn2prj` is version 2 in
   * all 128 of its records and read back as 422 trigs on a pattern of length 0, with tracks at
   * speeds no table names. Every one of those numbers was fiction.
   *
   * Found by rendering the whole corpus. Before this check the zero-length tracks made
   * `phaseStrip`'s repetition loop step by zero and exhausted a 4 GB heap — a frozen tab in a
   * browser — which is what sent me looking for why the lengths were zero in the first place.
   */
  const summary = device.summarise(image, index);
  /*
   * **Readable, not writable.** Version 2 was decoded on 2026-09-06 and normalises to version 3 on
   * read, so it is drawn like anything else. Gating this on `supported` — which means *rewritable*
   * — would keep refusing the factory presets project that ships on every Digitone II.
   */
  if (!summary.readable) {
    throw new PatternSubjectError(
      `${patternName(index)} is a version ${summary.version} pattern record, and this reads ` +
        `versions 2 and 3. The interior offsets move between versions, so anything drawn from it ` +
        `would be measured from the wrong bytes.`,
    );
  }

  const pattern = readDn2Pattern(image, index, DN2_LAYOUT);

  /*
   * A supported record with no length is not observed in the corpus, and is still refused rather
   * than drawn: every chart here divides by a length somewhere.
   */
  if (pattern.length < 1) {
    throw new PatternSubjectError(
      `${patternName(index)} declares a master length of ${pattern.length}, which is outside the ` +
        `1..128 a Digitone II sequencer plays. There is no timeline to draw this pattern against.`,
    );
  }

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
   * per-pattern the sequencer plays every track at the master length and the stored per-track
   * values are stale leftovers — drawing those would invent a polymeter the instrument is not
   * playing, and the realign chart exists precisely to say how long the pattern really takes.
   * Corpus-wide, 69% of the patterns that play something carry real per-track lengths.
   */
  const lengthOf = (trackLength: number) =>
    // A track length outside the documented 1..128 falls back to the master, which the guard above
    // has already established is playable. Not observed with a sane master — every zero track
    // length in the corpus sits in a pattern whose master is zero too — but a chart that divides
    // by this must not depend on that staying true.
    pattern.perTrackScale && trackLength >= 1 ? trackLength : pattern.length;

  const tracks: AnalysisTrack[] = pattern.tracks.map((track) => {
    const half = kit[track.index];
    const length = lengthOf(track.length);
    const notes: AnalysisTrig[] = track.trigs
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
          // at — most trigs in the corpus carry no velocity lock of their own.
          velocity: trig.velocity ?? track.settings.defaultVelocity,
          /*
           * **The gate, in steps, now that the byte is decoded.** A trig with no length of its own
           * inherits the track's default — the same fallback velocity uses, and the common case:
           * `0xFF` is the most frequent value in the whole corpus.
           *
           * `Infinity` is INF and is a real setting, not a failure. Every consumer bounds its loop
           * on the window rather than on the gate, so it flows through without special-casing.
           */
          length: noteLengthSteps(trig.noteLength ?? NOTE_LENGTH_NONE)
            ?? noteLengthSteps(track.settings.defaultNoteLength) ?? 1,
          microTiming: trig.microTiming,
          // The code is read; what it means is not. See `AnalysisTrig.conditional`.
          ...(trig.trigCondition === undefined ? {} : { conditional: true }),
          // An empty name is what the device leaves in an unnamed slot; the track's own preset is
          // a better answer than a blank, and a lock to a slot the pool cannot name is not a lock
          // anybody can act on.
          ...(lockName ? { lockPreset: lockName } : {}),
        };
      });

    /*
     * **A track record holds 128 steps whatever its LEN says, and the sequencer walks only the
     * first LEN of them.** Shortening a track keeps the trigs on the pages it drops, so the file
     * carries notes that do not play until somebody lengthens the track again. Confirmed at the
     * device on 2026-09-06.
     *
     * They are split out rather than filtered away so `dormantTrigs` can name them. Counting them
     * among the trigs that play overstated the note count, the voice pressure and the pitch
     * content of 521 tracks in the corpus, `PRESETS` and `JAGGED` worst: `017 PRESETS` A16 T2 is
     * five steps long and stores 22 notes past the end of it.
     */
    const trigs = notes.filter((trig) => trig.step < length);
    const dormant = notes.filter((trig) => trig.step >= length);

    return {
      number: track.index + 1,
      length,
      ...(SPEED[track.speed] === undefined ? {} : { speed: SPEED[track.speed] }),
      /*
       * **A MIDI track is a MIDI track, not an unknown machine.**
       *
       * This special-cased `midi` to `undefined`, which `machineLabel` renders as "unknown
       * machine" — so every MIDI track in the corpus was labelled unreadable in the legend and in
       * every tooltip. 49 of the 51 playing MIDI tracks carry machine byte 4, which *is* MIDI;
       * the other two read 2 (FM DRUM) while the kit mask says MIDI. The mask is documented as
       * the only discriminator between a synth track and a MIDI one, so it wins, and all 51 read
       * MIDI rather than 49 reading MIDI and 2 claiming to be drums.
       */
      machine: half?.midi ? MACHINE.midi : half?.machineValue,
      preset: half?.presetName || "—",
      trigs,
      ...(dormant.length ? { dormant } : {}),
    };
  });

  return {
    label: `${patternName(index)} · ${pattern.name || "unnamed"}`,
    tempo: pattern.tempo,
    masterLength: pattern.length,
    voiceBudget: VOICES[device.kind] ?? 16,
    defaultVelocity: accentThreshold(pattern.tracks.map((t) => t.settings.defaultVelocity)),
    /*
     * **PATTERN RESET, and only in per-track mode.**
     *
     * The guidebook is explicit that the PATTERN column carries LENGTH and SPEED in PER PATTERN
     * mode and CHANGE and RESET in PER TRACK mode — there is no pattern length in per-track mode,
     * because each track has its own. So the field this reader calls `length` is the pattern length
     * in one mode and the reset in the other, and it must not be read as a reset in the mode where
     * it is a length.
     *
     * **`1` means INF, and it was measured, not guessed** — `dn2-pattern-format.md` §"Both fields
     * are pattern-level" records `RESET → +0x14 (… and INF → 1)` from the `Per_Track_Reset_T01`
     * single-variable capture, and the instrument confirmed it again on 2026-09-05 (`017 PRESETS`
     * B8 stores 1 and shows RESET INF; `012 TECNO_EXP` A1 stores 64 and shows RESET 64).
     *
     * **This comment previously called it a guess, and that was a documentation-reading failure,
     * not a gap in the evidence.** It cited the same file for CHANGE's `1 = off` and stopped
     * thirty-five lines short of the line that already answered RESET, then reasoned by analogy to
     * the conclusion that was sitting there measured. A hardware test was written to settle it. If
     * a fact feels like it ought to be recorded somewhere, search for it before inferring it.
     */
    ...(pattern.perTrackScale && pattern.length > 1 ? { resetSteps: pattern.length } : {}),
    // CHANGE, at `+0x16`, where `dn2-pattern-format.md` records `1 = off`. Read in both scale
    // modes: a pattern hands over to a cued one whichever way its lengths are set.
    ...(pattern.changeLength > 1 ? { changeSteps: pattern.changeLength } : {}),
    /*
     * **Always false for a real project, and that is a statement about the format.**
     *
     * The trig carries a note-length byte and nothing decodes it into a duration.
     * `dn2-pattern-format.md` marks the track default at `+0x02` as INFERRED — the *name* is from
     * its position in the DN1 block, not from a capture — and no capture has walked the trig
     * field's values against what the instrument shows. Until one does, every gate here is 1 step
     * because it has to be something, and every chart that reads a gate has to be left undrawn.
     */
    /*
     * **True since 2026-09-06**, when the note-length byte was captured against the instrument.
     * `dn2-pattern-format.md` §3.3 has the table. Voice pressure, the note-length marks and overlap
     * detection all read a gate, and all three were written and left undrawn until this could be
     * answered honestly.
     */
    gateLengthKnown: true,
    tracks,
  };
}
