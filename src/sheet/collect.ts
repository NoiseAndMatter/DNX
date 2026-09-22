/**
 * Reading concern: what will this converted file actually do on the device?
 *
 * Everything here is read back out of the **output image**, never taken from the plan that
 * produced it. A sheet built from the plan would agree with the plan by construction and
 * would hide exactly the bugs worth finding — a field the writer never wrote still reads as
 * whatever the template held.
 *
 * Produces a plain model. Rendering is `render.ts`'s job.
 */

import { DN2_KIT, kitRecord, trackLevel } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "@noiseandmatter/dnx-core/project/soundmap.js";
import { readPattern, readSoundPool, type Dn1Pattern } from "@noiseandmatter/dnx-core/project/dn1.js";
import { readDn2Pattern, readMidiTrackMask, type Dn2Pattern } from "@noiseandmatter/dnx-core/project/dn2pattern.js";
import { stepName, stepsByPage } from "@noiseandmatter/dnx-core/project/naming.js";

/** DN2 tracks 9-16, which no Elektron import ever populates. Expansion is what fills them. */
const FIRST_EXPANDED_TRACK = 8;

export interface TrackRow {
  /** 1-based, as the device shows it. */
  track: number;
  sound: string;
  trigCount: number;
  /** Steps grouped by page. */
  steps: string;
  length: number;
  level: number;
  /** True for T9-T16: a track only expansion can have filled. */
  expanded: boolean;
  /** Things worth watching on this track, already phrased for a human. */
  notes: string[];
}

export interface SourceRow {
  track: number;
  length: number;
  steps: string;
  soundLocks: string[];
}

export interface PatternSheet {
  index: number;
  name: string;
  tempo: number;
  /** Master length, shown as RESET on the device. */
  reset: number;
  changeLength: number;
  perTrackScale: boolean;
  midiMask: number;
  tracks: TrackRow[];
  source: SourceRow[];
  expandedCount: number;
}

function soundName(kit: Uint8Array, track: number): string {
  const at = DN2_KIT.soundOffset + track * DN2_KIT.soundSize + SOUND_NAME_OFFSET;
  const raw = kit.subarray(at, at + SOUND_NAME_SIZE);
  const nul = raw.indexOf(0);
  return new TextDecoder("latin1").decode(nul === -1 ? raw : raw.subarray(0, nul));
}

/** Per-trig detail that has to survive a move to another track. */
function trackNotes(track: Dn2Pattern["tracks"][number], poolName: (slot: number) => string): string[] {
  const notes: string[] = [];

  const params = new Map<number, number>();
  for (const trig of track.trigs) {
    for (const lock of trig.locks) params.set(lock.parameter, (params.get(lock.parameter) ?? 0) + 1);
  }
  for (const [parameter, count] of params) notes.push(`p-lock: parameter ${parameter} on ${count} trig(s)`);

  const conditional = track.trigs.filter((t) => t.trigCondition !== undefined || t.trigConditionAlt !== undefined);
  const probability = track.trigs.filter((t) => t.probability !== undefined);
  const micro = track.trigs.filter((t) => t.microTiming !== 0);
  const chords = track.trigs.filter((t) => t.chord.length > 0);
  const velocities = [...new Set(track.trigs.map((t) => t.velocity).filter((v) => v !== undefined))];

  if (conditional.length) notes.push(`${conditional.length} conditional trig(s)`);
  if (probability.length) notes.push(`${probability.length} trig(s) with probability`);
  if (micro.length) notes.push(`${micro.length} micro-timed trig(s)`);
  if (chords.length) notes.push(`${chords.length} chord trig(s)`);
  if (velocities.length) notes.push(`velocity lock ${velocities.join(", ")}`);

  for (const trig of track.trigs) {
    if (trig.soundLock === undefined) continue;
    notes.push(`${stepName(trig.step)} stays sound-locked to "${poolName(trig.soundLock)}"`);
  }

  return notes;
}

function sourceRows(pattern: Dn1Pattern, poolName: (slot: number) => string): SourceRow[] {
  return pattern.tracks
    .filter((track) => track.trigs.length > 0)
    .map((track) => ({
      track: track.index + 1,
      length: track.length,
      steps: stepsByPage(track.trigs.map((t) => t.step)),
      soundLocks: track.trigs
        .filter((t) => t.soundLock !== undefined)
        .map((t) => `${stepName(t.step)} → "${poolName(t.soundLock!)}"`),
    }));
}

/** Build the sheet model for every pattern that has any trig. */
export function collectSheet(out: Uint8Array, dn1Image: Uint8Array): PatternSheet[] {
  const pool = readSoundPool(dn1Image);
  const poolName = (slot: number) => pool[slot]?.name || `slot ${slot}`;
  const sheets: PatternSheet[] = [];

  for (let index = 0; index < 128; index++) {
    const dn2 = readDn2Pattern(out, index);
    if (!dn2.tracks.some((t) => t.trigs.length)) continue;

    const kit = kitRecord(out, index);
    const tracks: TrackRow[] = dn2.tracks
      .map((track, t) => ({ track, t }))
      .filter(({ track }) => track.trigs.length > 0)
      .map(({ track, t }) => ({
        track: t + 1,
        sound: soundName(kit, t) || "(unnamed)",
        trigCount: track.trigs.length,
        steps: stepsByPage(track.trigs.map((trig) => trig.step)),
        length: track.settings.length,
        level: trackLevel(kit, t),
        expanded: t >= FIRST_EXPANDED_TRACK,
        notes: trackNotes(track, poolName),
      }));

    sheets.push({
      index,
      name: dn2.name,
      tempo: dn2.tempo,
      reset: dn2.length,
      changeLength: dn2.changeLength,
      perTrackScale: dn2.perTrackScale,
      midiMask: readMidiTrackMask(out, index),
      tracks,
      source: sourceRows(readPattern(dn1Image, index), poolName),
      expandedCount: tracks.filter((t) => t.expanded).length,
    });
  }

  return sheets;
}
