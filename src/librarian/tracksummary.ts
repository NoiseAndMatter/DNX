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

import {
  DN2_KIT,
  DN2_LAYOUT,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
  kitRecord,
  patternRecord,
  trackLevel,
} from "../project/dn2image.js";
import {
  KIT_MIDI_MASK_OFFSET,
  LOCK_TABLE,
  TRACK_COUNT as DN2_TRACK_COUNT,
  TRIG_TABLE,
  liveRecords,
} from "../project/dn2pattern.js";
import { SOUND_MACHINE_OFFSET, machineName } from "../project/machine.js";

const latin1 = new TextDecoder("latin1");

/** Live trigs per track, for reporting what an operation would destroy. */
export function trigCounts(image: Uint8Array, pattern: number): number[] {
  const record = patternRecord(image, pattern, DN2_LAYOUT);
  const counts = new Array<number>(DN2_TRACK_COUNT).fill(0);
  for (const { track } of liveRecords(record, TRIG_TABLE)) {
    if (track < DN2_TRACK_COUNT) counts[track]!++;
  }
  return counts;
}

/** Live parameter-lock records per track, which a copy can exhaust. */
export function lockCounts(image: Uint8Array, pattern: number): number[] {
  const record = patternRecord(image, pattern, DN2_LAYOUT);
  const counts = new Array<number>(DN2_TRACK_COUNT).fill(0);
  for (const { track } of liveRecords(record, LOCK_TABLE)) {
    if (track < DN2_TRACK_COUNT) counts[track]!++;
  }
  return counts;
}

/** The machine each track's preset runs, by name, or `undefined` where the value is unknown. */
export function trackMachines(image: Uint8Array, pattern: number): (string | undefined)[] {
  const kit = kitRecord(image, pattern, DN2_LAYOUT);
  const out: (string | undefined)[] = [];
  for (let t = 0; t < DN2_TRACK_COUNT; t++) {
    const at = DN2_KIT.soundOffset + t * DN2_KIT.soundSize + SOUND_MACHINE_OFFSET;
    out.push(machineName(kit[at]!));
  }
  return out;
}


/**
 * The half of a track that lives in the **kit**: which preset, which machine, how loud.
 *
 * Split out from `TrackSummary` because a kit is a thing in its own right — one sits in every
 * pattern, and 1,024 more sit on the +Drive — and the question *"what would loading this kit
 * change?"* has to be asked of a kit record that belongs to no project yet. Reading it needs the
 * pattern only for the counts, which are the other half.
 */
export interface KitTrack {
  /** 0-based. */
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
  /** Track level, 0..127 as the device shows it. */
  level: number;
}

/** Read the sixteen tracks of one kit record. Takes the record, not an image. */
export function summariseKitTracks(kit: Uint8Array): KitTrack[] {
  if (kit.length < DN2_LAYOUT.kitSize) {
    throw new RangeError(`a DN2 kit record is ${DN2_LAYOUT.kitSize} bytes, got ${kit.length}`);
  }
  const midiMask = (kit[KIT_MIDI_MASK_OFFSET]! << 8) | kit[KIT_MIDI_MASK_OFFSET + 1]!;

  const out: KitTrack[] = [];
  for (let index = 0; index < DN2_TRACK_COUNT; index++) {
    const soundAt = DN2_KIT.soundOffset + index * DN2_KIT.soundSize;
    out.push({
      index,
      label: trackName(index),
      presetName: readName(kit, soundAt + SOUND_NAME_OFFSET, SOUND_NAME_SIZE),
      machine: machineName(kit[soundAt + SOUND_MACHINE_OFFSET]!),
      midi: ((midiMask >> index) & 1) === 1,
      level: trackLevel(kit, index),
    });
  }
  return out;
}

/** A track, both halves: the kit's preset and level, and what the sequencer holds. */
export interface TrackSummary extends KitTrack {
  trigCount: number;
  lockCount: number;
  /** True when the track carries nothing the sequencer would play. */
  empty: boolean;
}

/** Summarise every track of one DN2 pattern: the kit half and the sequencer half together. */
export function summariseTracks(image: Uint8Array, pattern: number): TrackSummary[] {
  const trigs = trigCounts(image, pattern);
  const locks = lockCounts(image, pattern);

  return summariseKitTracks(kitRecord(image, pattern, DN2_LAYOUT)).map((track) => ({
    ...track,
    trigCount: trigs[track.index]!,
    lockCount: locks[track.index]!,
    empty: trigs[track.index] === 0 && locks[track.index] === 0,
  }));
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
