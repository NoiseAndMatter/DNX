/**
 * Moving tracks *inside* one pattern: the same operations as the pattern librarian, one level
 * down.
 *
 * ## A track is a sequence *and* a preset, and the device says so itself
 *
 * The manual's §16 KEY COMBINATIONS lists four copy/paste/clear units, and two of them are the
 * halves of a track:
 *
 * - **TRACK SEQUENCE** (all trigs on the track) — `[FUNC]` + `[RECORD]`/`[STOP]`/`[PLAY]`
 * - **PRESET** (the selected track's preset) — `[TRK]` + `[RECORD]`/`[STOP]`/`[PLAY]`
 *
 * There is **no whole-track operation on the hardware at all**; moving both halves together is
 * ours. So `TrackScope` offers the device's two units plus our composite, and the vocabulary
 * follows the device: the sound half of a track is a **preset** (§9), not a "sound". A kit is
 * the 16 presets of a pattern together with levels, send FX and the compressor.
 *
 * ## A track is not one block, and half of it is references
 *
 * A pattern is one contiguous `patternKit`, which is why `rearrange.ts` can move it with a
 * copy. A **track** is nothing like that. It is six regions across two records plus two bits
 * of bookkeeping, and three of those do not move as bytes at all:
 *
 * | What | Where | Part | How it moves |
 * |---|---|---|---|
 * | track record — flags, conditions, probability, sound locks, length, speed | pattern `+0x0004 + t·1187` | sequence | copied |
 * | preset | kit `+60 + t·359` | preset | copied |
 * | MIDI record | kit `+5964 + t·268` | preset | copied |
 * | track level | kit `+0x1C + t·2` | mix | copied |
 * | **trigs** | flat 8,192-slot pool, each slot naming its own track | sequence | **rebuilt** |
 * | **parameter locks** | 80 records, each naming a track | sequence | **rebuilt** |
 * | **MIDI-track mask** | kit `+10,260`, one *bit* per track | preset | **rewritten bitwise** |
 *
 * The DN2 does not store trigs per track. It keeps one pool for the whole pattern where every
 * slot carries a `track` byte, so moving track 3 to track 9 means finding every slot that says
 * 3 and making it say 9.
 *
 * The track level is neither half. The manual puts LEVEL in the kit but **not** in the preset,
 * so the device's own PRESET paste would leave it behind — and `scope: "preset"` does the same.
 * Only the composite carries it.
 *
 * ## Why those two tables are rebuilt rather than renumbered
 *
 * Renumbering in place is the obvious implementation and it is right for a move and a swap.
 * It is **wrong for a copy**: a copy has to *duplicate* trigs, because the source keeps its
 * own, and relabelling them would move them instead. The first version of this module did
 * exactly that and `a copy leaves the source's trigs where they are` caught it.
 *
 * Rather than branch on which kind of operation this is — and get the classification wrong
 * somewhere — both tables are rebuilt from one rule:
 *
 * > a touched track ends up with copies of whatever its source held; everything else is left
 * > exactly as it was.
 *
 * Move, copy, swap and clear all fall out of that, and there is no third case to forget. The
 * cost is that a copy can exhaust the 80-record lock table, which is refused rather than
 * silently truncated — losing parameter automation without a word would be the worse failure.
 *
 * **The consequence worth stating: a track move that copied bytes and stopped would leave the
 * trigs behind.** They would still name the old track, which now holds something else. That
 * is the `sound+244` failure in a new place — right notes, wrong voice — and it is why this
 * module exists rather than a few `set()` calls in the caller.
 *
 * ## Digitone II only, for now
 *
 * The DN1 lays its tracks out differently and its first four tracks are synth while the last
 * four are MIDI, so a move across that boundary is not meaningful. Rather than guess, this
 * refuses the DN1 outright and says so. Silently doing nothing, or doing something plausible,
 * are both worse than a clear no.
 *
 * ## The synth/MIDI discriminator, which this module used to disclaim
 *
 * An earlier version warned that the byte deciding whether a track is synth or MIDI "has never
 * been located". That was already out of date: it is `KIT_MIDI_MASK_OFFSET`, a `u16be` bitmask
 * at kit `+10,260`, and the pattern record has nothing to do with it. Worse than stale, the
 * warning hid a bug — the mask was in **no** region, so a moved MIDI track arrived as a synth
 * track. It is now rewritten bit by bit alongside the presets.
 *
 * Two independent encodings agree on it, which is why it is trusted: across the 26-project DN2
 * corpus the stored mask matches the mask derived from each preset's machine byte (`sound+244
 * == 4`) in **3,319 of 3,328 kits**. All nine exceptions are in `PRESETS.dn2prj`, the only
 * storage-version-2 project in the corpus, where the offset means something else — versions are
 * per struct, so that is the expected shape of the disagreement rather than a counter-example.
 */

import { DN2_KIT, DN2_LAYOUT, kitRecord, patternRecord } from "../project/dn2image.js";
import {
  KIT_MIDI_MASK_OFFSET,
  PATTERN as DN2_PATTERN,
  TRACK as DN2_TRACK,
  readMidiTrackMask,
} from "../project/dn2pattern.js";
import { SOUND_MACHINE_OFFSET, machineName } from "../project/machine.js";
import { isMachineRelative } from "../project/machineplock.js";
import { blankPatternKit } from "./blank.js";
import { type Device } from "./device.js";
import { type Shuffle, rereference, sourceOf, touchedSlots } from "./shuffle.js";

export const DN2_TRACK_COUNT = 16;

/**
 * Which half of a track a region belongs to, in the device's own vocabulary.
 *
 * `mix` is neither: the manual lists LEVEL under the kit but not under the preset, so it
 * travels only with the composite operation.
 */
export type TrackPart = "sequence" | "preset" | "mix";

/**
 * What to move. The first two are exactly the device's own TRACK SEQUENCE and PRESET units;
 * `both` is our composite, which the hardware does not offer.
 */
export type TrackScope = "both" | "sequence" | "preset";

/** A contiguous run of bytes belonging to one track. Offsets are within the pattern or kit. */
interface Region {
  part: TrackPart;
  /** Offset within the pattern record. */
  inPattern?: number;
  /** Offset within the kit record. */
  inKit?: number;
  size: number;
}

/**
 * The four contiguous regions that are copied when a track moves.
 *
 * Trigs, locks and the MIDI mask are absent on purpose: none of them is a per-track run of
 * bytes, and listing them here would invite a caller to move bytes that must not be moved.
 */
function copiedRegions(track: number): Region[] {
  return [
    {
      part: "sequence",
      inPattern: DN2_PATTERN.trackOffset + track * DN2_PATTERN.trackSize,
      size: DN2_PATTERN.trackSize,
    },
    {
      part: "preset",
      inKit: DN2_KIT.soundOffset + track * DN2_KIT.soundSize,
      size: DN2_KIT.soundSize,
    },
    {
      part: "preset",
      inKit: DN2_KIT.midiOffset + track * DN2_KIT.midiSize,
      size: DN2_KIT.midiSize,
    },
    // Track levels: 16 u16le at kit +0x1C, one per track. Small, and easy to forget — a move
    // without it silently resets the destination's level to the source pattern's.
    { part: "mix", inKit: 0x1c + track * 2, size: 2 },
  ];
}

/** True when a scope carries this part. `both` carries everything, including `mix`. */
function carries(scope: TrackScope, part: TrackPart): boolean {
  return scope === "both" || scope === part;
}

export interface TrackFinding {
  severity: "blocker" | "warning";
  message: string;
}

export interface TrackPlan {
  pattern: number;
  /** What this operation moves. */
  scope: TrackScope;
  /** Tracks whose contents are replaced, 0-based. */
  changed: number[];
  /** Tracks left empty, 0-based. */
  emptied: number[];
  /** Tracks whose content is overwritten and not preserved anywhere. */
  destructive: { track: number; trigCount: number }[];
  findings: TrackFinding[];
  ok: boolean;
}

/** The shape a refused plan reports: nothing changes, so nothing is listed. */
function nothingChanges(): Pick<TrackPlan, "changed" | "emptied" | "destructive"> {
  return { changed: [], emptied: [], destructive: [] };
}

/**
 * Warn when splitting a track leaves parameter locks pointing at a different machine.
 *
 * A lock record stores a parameter **id**, and ids in 33..76 and 78..81 mean different knobs
 * on different machines (`isMachineRelative`). So a sequence that lands on a track whose preset
 * is a different machine keeps locking id 58 while 58 now addresses something else — an LFO
 * depth becoming a filter cutoff, silently. The composite scope cannot hit this, because the
 * preset travels with the sequence.
 *
 * This is the `sound+244` failure one level up: the bytes are all correct and the meaning is
 * wrong, so it is reported rather than repaired. Repairing it would mean rewriting ids across
 * machines, which is a translation problem and not a librarian's job.
 */
function machineDriftFindings(
  image: Uint8Array,
  pattern: number,
  shuffle: Shuffle,
  scope: TrackScope,
): TrackFinding[] {
  if (scope === "both") return [];

  const machines = trackMachines(image, pattern);
  const relative = tracksWithRelativeLocks(image, pattern);
  const findings: TrackFinding[] = [];

  for (const destination of touchedSlots(shuffle)) {
    const source = sourceOf(shuffle, destination);
    if (source === undefined) continue;

    // Moving the sequence carries the source's locks onto the destination's preset; moving the
    // preset leaves the destination's own locks to be read against the preset that arrives.
    const locksFrom = scope === "sequence" ? source : destination;
    const readAgainst = scope === "sequence" ? destination : source;
    if (!relative.has(locksFrom)) continue;

    const was = machines[locksFrom];
    const now = machines[readAgainst];
    if (was === now) continue;

    findings.push({
      severity: "warning",
      message:
        `Track ${destination + 1} ends up with parameter locks whose ids only mean something ` +
        `for a given machine, and this moves the ${scope} half only: they were written for ` +
        `${was ?? "an unknown machine"} but will be read against ${now ?? "an unknown machine"}. ` +
        `The steps are right; the parameters they lock are not. Move both halves, or check ` +
        `the locks on the device.`,
    });
  }
  return findings;
}

/**
 * A table of fixed-size records where each record names the track it belongs to.
 *
 * The trig pool and the parameter-lock table have that shape in common, so one rewriter serves
 * both and the two cannot drift apart. What they do **not** share is where the track byte sits,
 * and assuming they did was a real bug: a lock record is `u8 parameter | u8 track | …`, so
 * treating byte 0 as the track both matched the wrong records *and* overwrote each surviving
 * lock's parameter id with a track number. `readLockTable` had it right all along; this now
 * agrees with it, and `a lock keeps its parameter id` holds the line.
 */
interface TrackTable {
  offset: number;
  size: number;
  count: number;
  /** Byte within a record that names the track. */
  trackAt: number;
  /** Header bytes that mark a record unused, written from offset 0. */
  unused: readonly number[];
}

const TRIG_TABLE: TrackTable = {
  offset: DN2_PATTERN.trigOffset,
  size: DN2_PATTERN.trigSize,
  count: DN2_PATTERN.trigCount,
  trackAt: 0,
  unused: [0xff],
};

const LOCK_TABLE: TrackTable = {
  offset: DN2_PATTERN.lockOffset,
  size: DN2_PATTERN.lockSize,
  count: DN2_PATTERN.lockCount,
  // Byte 1. Byte 0 is the parameter id, which ranges well past 15 — see the corpus check in
  // `docs/dn2-pattern-format.md` §7.
  trackAt: 1,
  // Both header bytes, because `readLockTable` tests the pair as one u16 against 0xFFFF.
  // Clearing only byte 0 would leave 0xFF<track>, which reads back as a live lock on
  // parameter 255.
  unused: [0xff, 0xff],
};

/** Live records of one table, as `(recordOffset, track)` pairs. */
function liveRecords(pattern: Uint8Array, table: TrackTable): { at: number; track: number }[] {
  const out: { at: number; track: number }[] = [];
  for (let i = 0; i < table.count; i++) {
    const at = table.offset + i * table.size;
    if (isUnused(pattern, at, table)) continue;
    out.push({ at, track: pattern[at + table.trackAt]! });
  }
  return out;
}

function isUnused(record: Uint8Array, at: number, table: TrackTable): boolean {
  return table.unused.every((byte, i) => record[at + i] === byte);
}

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

/** Tracks carrying at least one lock whose parameter id only means something for its machine. */
function tracksWithRelativeLocks(image: Uint8Array, pattern: number): Set<number> {
  const record = patternRecord(image, pattern, DN2_LAYOUT);
  const out = new Set<number>();
  for (const { at, track } of liveRecords(record, LOCK_TABLE)) {
    if (isMachineRelative(record[at]!)) out.add(track);
  }
  return out;
}

/**
 * What a track shuffle would do, without doing it.
 *
 * Mirrors `planRearrange` deliberately: the UI and the CLI both show this before asking, and
 * two different shapes for "here is what you are about to lose" would be two things to keep
 * right.
 */
export function planTrackMove(
  image: Uint8Array,
  device: Device,
  pattern: number,
  shuffle: Shuffle,
  scope: TrackScope = "both",
): TrackPlan {
  const findings: TrackFinding[] = [];

  if (device.kind !== "dn2") {
    findings.push({
      severity: "blocker",
      message:
        `Track operations are Digitone II only. The ${device.name} lays its tracks out ` +
        `differently and splits them into synth and MIDI, so moving one across that boundary ` +
        `is not meaningful. Refusing rather than guessing.`,
    });
    return { pattern, scope, ...nothingChanges(), findings, ok: false };
  }

  if (pattern < 0 || pattern >= device.patternCount) {
    findings.push({ severity: "blocker", message: `No such pattern: ${pattern}.` });
    return { pattern, scope, ...nothingChanges(), findings, ok: false };
  }

  const outOfRange = touchedSlots(shuffle).filter((t) => t < 0 || t >= DN2_TRACK_COUNT);
  if (outOfRange.length > 0) {
    findings.push({
      severity: "blocker",
      message: `Track ${outOfRange.join(", ")} is outside 1..${DN2_TRACK_COUNT}.`,
    });
    return { pattern, scope, ...nothingChanges(), findings, ok: false };
  }

  const counts = trigCounts(image, pattern);
  const changed = touchedSlots(shuffle);
  const emptied = changed.filter((t) => sourceOf(shuffle, t) === undefined);

  // A destination loses whatever it held, unless its own contents go somewhere else. Only the
  // sequence half owns trigs, so a preset-only operation destroys no notes — it still replaces
  // a preset, which `changed` reports, but calling that a loss of N trigs would be false.
  const destructive = carries(scope, "sequence")
    ? changed
        .filter((t) => counts[t]! > 0 && rereference(shuffle, t) === undefined)
        .map((t) => ({ track: t, trigCount: counts[t]! }))
    : [];

  findings.push(...machineDriftFindings(image, pattern, shuffle, scope));

  // The one per-track region we know about and deliberately do not move. `docs/KNOWN-ISSUES.md`
  // records kit +10,264 as an apparent 16 x 5-byte array whose meaning is unknown and whose
  // alignment is inferred from the repeat rather than proven. Moving bytes we cannot name is
  // how a plausible-looking corruption gets written, so it stays put — and says so, the same
  // tri-state honesty the song table gets. Warned about only when an entry is non-default,
  // since moving identical defaults around changes nothing.
  if (carries(scope, "preset") && touchesNonDefaultTrackArray(image, pattern, shuffle)) {
    findings.push({
      severity: "warning",
      message:
        "One of these tracks has a non-default entry in the unidentified per-track array at " +
        "kit +10,264. Its meaning is unknown and its alignment is inferred, so it stays where " +
        "it is rather than being moved on a guess. Check the moved tracks on the device.",
    });
  }

  return { pattern, scope, changed, emptied, destructive, findings, ok: true };
}

/** Start of the unidentified per-track array, and one entry's size. See `docs/KNOWN-ISSUES.md`. */
const UNKNOWN_TRACK_ARRAY = { offset: 10_264, size: 5 } as const;
const UNKNOWN_TRACK_DEFAULT = [0x00, 0x00, 0x81, 0x20, 0x00] as const;

/** True when any track this shuffle touches carries a non-default entry in that array. */
function touchesNonDefaultTrackArray(
  image: Uint8Array,
  pattern: number,
  shuffle: Shuffle,
): boolean {
  const kit = kitRecord(image, pattern, DN2_LAYOUT);
  const isDefault = (track: number): boolean => {
    const at = UNKNOWN_TRACK_ARRAY.offset + track * UNKNOWN_TRACK_ARRAY.size;
    return UNKNOWN_TRACK_DEFAULT.every((byte, i) => kit[at + i] === byte);
  };

  return touchedSlots(shuffle).some((destination) => {
    const source = sourceOf(shuffle, destination);
    return !isDefault(destination) || (source !== undefined && !isDefault(source));
  });
}

export interface TrackMoveOptions {
  /** Required when the plan reports anything destructive. */
  confirmOverwrite?: boolean;
  /** Which half of the track to move. Defaults to the composite. */
  scope?: TrackScope;
}

export interface TrackMoveResult {
  image: Uint8Array;
  plan: TrackPlan;
  /**
   * Live trig slots in the rebuilt pool.
   *
   * Not "how many moved": the table is rewritten wholesale, so this is the total that survive.
   * Naming it after the move would overstate what happened, and a number nobody can interpret
   * is worse than no number.
   */
  trigsWritten: number;
  /** Live lock records in the rebuilt table, same caveat. */
  locksWritten: number;
}

/**
 * Apply a track shuffle to one pattern.
 *
 * Every source is read from the **original** image before anything is written, the same rule
 * `applyRearrange` follows: a swap written in place would otherwise read back what it just
 * wrote. Vacated tracks are filled from the captured blank patternKit rather than zeroed,
 * because a track full of zeros is not what the device writes for an empty one.
 */
export function applyTrackMove(
  image: Uint8Array,
  device: Device,
  pattern: number,
  shuffle: Shuffle,
  options: TrackMoveOptions = {},
): TrackMoveResult {
  const scope = options.scope ?? "both";
  const plan = planTrackMove(image, device, pattern, shuffle, scope);
  if (!plan.ok) {
    throw new Error(plan.findings.filter((f) => f.severity === "blocker")[0]!.message);
  }
  if (plan.destructive.length > 0 && !options.confirmOverwrite) {
    throw new Error(
      `This would destroy ${plan.destructive.length} track(s) holding ` +
        `${plan.destructive.reduce((n, d) => n + d.trigCount, 0)} trigs. ` +
        `Pass confirmOverwrite once the user has agreed.`,
    );
  }

  const next = Uint8Array.from(image);
  const patternBase = DN2_LAYOUT.headerSize + pattern * DN2_LAYOUT.patternSize;
  const kitBase = DN2_LAYOUT.kitBase + pattern * DN2_LAYOUT.kitSize;

  // Sources come from the original; the blank supplies whatever is vacated.
  const original = image;
  const blank = blankPatternKit(device, pattern);

  /** Read one region out of a (pattern, kit) pair, wherever those two happen to live. */
  const read = (region: Region, patternBytes: Uint8Array, kitBytes: Uint8Array): Uint8Array =>
    region.inPattern !== undefined
      ? patternBytes.subarray(region.inPattern, region.inPattern + region.size)
      : kitBytes.subarray(region.inKit!, region.inKit! + region.size);

  const originalPattern = original.subarray(patternBase, patternBase + DN2_LAYOUT.patternSize);
  const originalKit = original.subarray(kitBase, kitBase + DN2_LAYOUT.kitSize);

  for (const destination of touchedSlots(shuffle)) {
    const source = sourceOf(shuffle, destination);
    const destinationRegions = copiedRegions(destination);

    // A vacated track is filled from the captured blank patternKit's track of the same index,
    // never from zeros — an empty track is what the device writes, not what we imagine.
    const [fromPattern, fromKit, fromTrack] =
      source === undefined
        ? [blank.pattern, blank.kit, destination]
        : [originalPattern, originalKit, source];

    const sourceRegions = copiedRegions(fromTrack);
    destinationRegions.forEach((region, i) => {
      if (!carries(scope, region.part)) return;
      writeRegion(next, region, patternBase, kitBase, read(sourceRegions[i]!, fromPattern, fromKit));
    });
  }

  // The MIDI-track mask is one bit per track in a single u16be, so it cannot be a region: the
  // bits have to be picked out and reassembled. Omitting it was a bug — a moved MIDI track
  // arrived as a synth track, keeping the MIDI record it would no longer use.
  if (carries(scope, "preset")) {
    rewriteMidiMask(next, kitBase, original, kitBase, blank.kit, shuffle);
  }

  // Now the referential half.
  //
  // The first version of this renumbered trigs in place, which is right for a move and a swap
  // and **wrong for a copy**: a copy has to duplicate trigs into free slots, because the
  // source keeps its own. Rather than branch on which kind of operation it is — and get the
  // classification wrong somewhere — every operation goes through one rule:
  //
  //   a touched track ends up with copies of whatever its source held; everything else is
  //   left exactly as it was.
  //
  // Clear, then rewrite. Uniform for move, copy, swap and clear, and there is no third case
  // to forget.
  //
  // Both tables belong to the sequence half, so a preset-only operation leaves them alone —
  // that is precisely what makes "load a kit onto a running pattern" the operation it is.
  const record = next.subarray(patternBase, patternBase + DN2_LAYOUT.patternSize);
  const originalRecord = original.subarray(patternBase, patternBase + DN2_LAYOUT.patternSize);
  const touched = new Set(touchedSlots(shuffle));

  if (!carries(scope, "sequence")) {
    return {
      image: next,
      plan,
      trigsWritten: liveRecords(originalRecord, TRIG_TABLE).length,
      locksWritten: liveRecords(originalRecord, LOCK_TABLE).length,
    };
  }

  const trigsWritten = rewriteReferential(record, originalRecord, shuffle, touched, TRIG_TABLE);
  const locksWritten = rewriteReferential(record, originalRecord, shuffle, touched, LOCK_TABLE);

  return { image: next, plan, trigsWritten, locksWritten };
}

/**
 * Move each track's MIDI bit the same way its preset moved.
 *
 * A cleared track takes the captured blank's bit rather than a hard zero, for the same reason
 * every other vacated region does: an empty track is whatever the device writes for one.
 */
function rewriteMidiMask(
  into: Uint8Array,
  intoKitBase: number,
  from: Uint8Array,
  fromKitBase: number,
  blankKit: Uint8Array,
  shuffle: Shuffle,
): void {
  const readMask = (bytes: Uint8Array, base: number): number =>
    (bytes[base + KIT_MIDI_MASK_OFFSET]! << 8) | bytes[base + KIT_MIDI_MASK_OFFSET + 1]!;

  const source = readMask(from, fromKitBase);
  const blank = readMask(blankKit, 0);
  let next = source;

  for (const destination of touchedSlots(shuffle)) {
    const track = sourceOf(shuffle, destination);
    const bit = track === undefined ? (blank >> destination) & 1 : (source >> track) & 1;
    next = bit ? next | (1 << destination) : next & ~(1 << destination);
  }

  into[intoKitBase + KIT_MIDI_MASK_OFFSET] = (next >> 8) & 0xff;
  into[intoKitBase + KIT_MIDI_MASK_OFFSET + 1] = next & 0xff;
}

/**
 * Rewrite one track-referencing table so every touched track holds copies of its source's.
 *
 * Both the 8,192-slot trig pool and the 80-record lock table have the same shape: fixed-size
 * records, the first byte naming a track, `0xFF` meaning unused. So one function serves both,
 * and the trig pool's rules cannot drift from the lock table's.
 *
 * Order within the table is preserved for untouched tracks, and new records are appended into
 * whatever slots are free — the readers scan the whole array rather than assuming a dense
 * prefix, which `readTrigSlots` documents as deliberate.
 */
function rewriteReferential(
  record: Uint8Array,
  original: Uint8Array,
  shuffle: Shuffle,
  touched: ReadonlySet<number>,
  table: TrackTable,
): number {
  const { offset, size, count, trackAt } = table;

  /** Every record that survives: untouched ones as they were, touched ones from their source. */
  const wanted: { bytes: Uint8Array; track: number }[] = [];

  for (const { at, track } of liveRecords(original, table)) {
    if (touched.has(track)) continue; // replaced below, or deliberately discarded
    wanted.push({ bytes: original.subarray(at, at + size), track });
  }

  for (const destination of touched) {
    const source = sourceOf(shuffle, destination);
    if (source === undefined) continue; // cleared: it gets nothing
    for (const { at, track } of liveRecords(original, table)) {
      if (track !== source) continue;
      wanted.push({ bytes: original.subarray(at, at + size), track: destination });
    }
  }

  if (wanted.length > count) {
    throw new Error(
      `This would need ${wanted.length} records in a table of ${count}. Copying a track ` +
        `duplicates its parameter locks, and the table is full.`,
    );
  }

  let written = 0;
  for (let i = 0; i < count; i++) {
    const at = offset + i * size;
    const entry = wanted[i];
    if (entry) {
      // Copy the record whole, then restamp only the track byte. Everything else — a lock's
      // parameter id, a trig's note and micro timing — has to survive untouched.
      record.set(entry.bytes, at);
      record[at + trackAt] = entry.track;
      written++;
    } else {
      table.unused.forEach((byte, j) => {
        record[at + j] = byte;
      });
    }
  }
  return written;
}

function writeRegion(
  into: Uint8Array,
  region: Region,
  patternBase: number,
  kitBase: number,
  bytes: Uint8Array,
): void {
  const at =
    region.inPattern !== undefined ? patternBase + region.inPattern : kitBase + region.inKit!;
  into.set(bytes, at);
}

/**
 * Re-read the result and check it says what the shuffle asked for.
 *
 * Same discipline as `verifyRearrange`: the writer agreeing with itself proves nothing, so
 * this reads the bytes back. It checks the half most likely to be wrong — that no trig still
 * names a track that has moved.
 */
export function verifyTrackMove(
  before: Uint8Array,
  after: Uint8Array,
  pattern: number,
  shuffle: Shuffle,
  scope: TrackScope = "both",
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const touched = new Set(touchedSlots(shuffle));

  /** Where track `t` should have got its content from, or `undefined` when it was cleared. */
  const origin = (t: number): number | undefined => (touched.has(t) ? sourceOf(shuffle, t) : t);

  // Per-track trig counts, compared against what the shuffle says each track should end with.
  //
  // The first version asked whether a moved track's number still appeared afterwards, which is
  // wrong for a swap: track A legitimately still has trigs, they are simply B's now. Counts
  // say the thing that actually matters and cannot be fooled that way.
  //
  // A preset-only operation must leave every count alone, which is the same check with the
  // identity shuffle — so the scope changes the expectation, not the method.
  const beforeCounts = trigCounts(before, pattern);
  const afterCounts = trigCounts(after, pattern);

  for (let track = 0; track < DN2_TRACK_COUNT; track++) {
    const source = carries(scope, "sequence") ? origin(track) : track;
    const expected = source === undefined ? 0 : beforeCounts[source]!;
    if (afterCounts[track] !== expected) {
      problems.push(
        `track ${track + 1} should hold ${expected} trigs` +
          (source !== undefined && source !== track ? ` (from track ${source + 1})` : "") +
          `, found ${afterCounts[track]}`,
      );
    }
  }

  // The MIDI bit has to have travelled with the preset. It is one bit in a shared word, so it
  // is the piece most likely to be forgotten — and it was, until this checked it.
  if (carries(scope, "preset")) {
    const beforeMachines = trackMachines(before, pattern);
    const afterMachines = trackMachines(after, pattern);
    const beforeMask = readMidiTrackMask(before, pattern);
    const afterMask = readMidiTrackMask(after, pattern);

    for (let track = 0; track < DN2_TRACK_COUNT; track++) {
      const source = origin(track);
      if (source === undefined) continue; // a cleared track takes the blank's bit
      const expectedBit = (beforeMask >> source) & 1;
      if (((afterMask >> track) & 1) !== expectedBit) {
        problems.push(
          `track ${track + 1} should be ${expectedBit ? "a MIDI" : "a synth"} track ` +
            `(from track ${source + 1}), but the kit's MIDI mask says otherwise`,
        );
      }
      if (afterMachines[track] !== beforeMachines[source]) {
        problems.push(
          `track ${track + 1} should run ${beforeMachines[source] ?? "an unknown machine"}, ` +
            `found ${afterMachines[track] ?? "an unknown machine"}`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

void DN2_TRACK;
