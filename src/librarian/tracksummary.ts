/**
 * What one pattern's 16 tracks hold, in the form both surfaces want to show.
 *
 * The CLI prints this as a table and the manager renders it as a grid. Neither computes it:
 * a second implementation of "is this track empty" is a second answer waiting to disagree with
 * the first, and the pattern librarian already learned that lesson — `device.summarise` exists
 * for exactly the same reason one level up.
 *
 * It answers only what a *librarian* needs. Which machine a track runs, whether it is a MIDI
 * track, how much is on it. Not what the sound is doing: that belongs to the sound explorer,
 * which reads the preset properly rather than skimming two bytes out of it.
 */

import { DN2_KIT, DN2_LAYOUT, SOUND_NAME_OFFSET, SOUND_NAME_SIZE, kitRecord } from "../project/dn2image.js";
import { readMidiTrackMask } from "../project/dn2pattern.js";
import { SOUND_MACHINE_OFFSET, machineName } from "../project/machine.js";
import { DN2_TRACK_COUNT, lockCounts, trigCounts } from "./trackmove.js";

const latin1 = new TextDecoder("latin1");

export interface TrackSummary {
  /** 0-based, so it indexes a shuffle directly. `label` is what a person reads. */
  index: number;
  /** `T1` … `T16`, the device's own numbering. */
  label: string;
  /** The preset's name, or empty when it has none — the device fills those in lazily. */
  presetName: string;
  /**
   * The machine the preset runs, or `undefined` for a value no capture has seen.
   *
   * Undefined is reported rather than guessed at: the DN2's machine list is longer than the
   * capture that produced the table, so an unknown value means unknown, not "probably FM TONE".
   */
  machine: string | undefined;
  /** True when this track is a MIDI track, from the kit's mask at +10,260. */
  midi: boolean;
  trigCount: number;
  lockCount: number;
  /** Track level, 0..127 as the device shows it. */
  level: number;
  /** True when the track carries nothing the sequencer would play. */
  empty: boolean;
}

/** Summarise every track of one DN2 pattern. */
export function summariseTracks(image: Uint8Array, pattern: number): TrackSummary[] {
  const kit = kitRecord(image, pattern, DN2_LAYOUT);
  const trigs = trigCounts(image, pattern);
  const locks = lockCounts(image, pattern);
  const midiMask = readMidiTrackMask(image, pattern);

  const out: TrackSummary[] = [];
  for (let index = 0; index < DN2_TRACK_COUNT; index++) {
    const soundAt = DN2_KIT.soundOffset + index * DN2_KIT.soundSize;
    out.push({
      index,
      label: trackName(index),
      presetName: readName(kit, soundAt + SOUND_NAME_OFFSET, SOUND_NAME_SIZE),
      machine: machineName(kit[soundAt + SOUND_MACHINE_OFFSET]!),
      midi: ((midiMask >> index) & 1) === 1,
      trigCount: trigs[index]!,
      lockCount: locks[index]!,
      level: kit[0x1c + index * 2]!,
      empty: trigs[index] === 0 && locks[index] === 0,
    });
  }
  return out;
}

/** `T1` … `T16`. The device counts tracks from one; every index in this codebase is 0-based. */
export function trackName(index: number): string {
  return `T${index + 1}`;
}

/**
 * Resolve `T7`, `t7` or `7` to a 0-based track index, or `undefined`.
 *
 * Accepting the bare number matters because people type it, and rejecting it would be pedantry
 * about a form that has exactly one meaning.
 */
export function trackIndex(token: string): number | undefined {
  const match = /^t?(\d{1,2})$/i.exec(token.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  return n >= 1 && n <= DN2_TRACK_COUNT ? n - 1 : undefined;
}

function readName(data: Uint8Array, at: number, size: number): string {
  const raw = data.subarray(at, at + size);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul));
}
