/**
 * Moving tracks *inside* one pattern: the same operations as the pattern librarian, one level
 * down.
 *
 * ## A track is not one block, and half of it is references
 *
 * A pattern is one contiguous `patternKit`, which is why `rearrange.ts` can move it with a
 * copy. A **track** is nothing like that. It is six regions in two records, and two of them
 * do not move at all:
 *
 * | What | Where | How it moves |
 * |---|---|---|
 * | track record — flags, conditions, probability, sound locks, length, speed | pattern `+0x0004 + t·1187` | copied |
 * | sound | kit `+60 + t·359` | copied |
 * | MIDI record | kit `+5964 + t·268` | copied |
 * | track level | kit `+0x1C + t·2` | copied |
 * | **trigs** | flat 8,192-slot pool, each slot naming its own track | **rebuilt** |
 * | **parameter locks** | 80 records, each naming a track | **rebuilt** |
 *
 * The DN2 does not store trigs per track. It keeps one pool for the whole pattern where every
 * slot carries a `track` byte, so moving track 3 to track 9 means finding every slot that says
 * 3 and making it say 9.
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
 * ## What we cannot check, and say so
 *
 * The **per-track synth/MIDI discriminator on the DN2 has never been located** (see
 * `docs/KNOWN-ISSUES.md`). Every track carries both a sound slot and a MIDI record, and some
 * byte decides which is live. Since all six regions move together, whatever that byte is
 * travels with the track — but we cannot verify it, so a move reports a warning rather than
 * claiming a safety we cannot demonstrate. Same tri-state honesty as the song table.
 */

import { DN2_KIT, DN2_LAYOUT, patternRecord } from "../project/dn2image.js";
import { PATTERN as DN2_PATTERN, TRACK as DN2_TRACK } from "../project/dn2pattern.js";
import { blankPatternKit } from "./blank.js";
import { type Device } from "./device.js";
import { type Shuffle, rereference, sourceOf, touchedSlots } from "./shuffle.js";

export const DN2_TRACK_COUNT = 16;

/** A contiguous run of bytes belonging to one track. Offsets are within the pattern or kit. */
interface Region {
  /** Offset within the pattern record. */
  inPattern?: number;
  /** Offset within the kit record. */
  inKit?: number;
  size: number;
}

/**
 * The four regions that are copied when a track moves.
 *
 * Trigs and locks are absent on purpose: they are renumbered rather than copied, and listing
 * them here would invite a caller to move bytes that must not be moved.
 */
function copiedRegions(track: number): Region[] {
  return [
    {
      inPattern: DN2_PATTERN.trackOffset + track * DN2_PATTERN.trackSize,
      size: DN2_PATTERN.trackSize,
    },
    { inKit: DN2_KIT.soundOffset + track * DN2_KIT.soundSize, size: DN2_KIT.soundSize },
    { inKit: DN2_KIT.midiOffset + track * DN2_KIT.midiSize, size: DN2_KIT.midiSize },
    // Track levels: 16 u16le at kit +0x1C, one per track. Small, and easy to forget — a move
    // without it silently resets the destination's level to the source pattern's.
    { inKit: 0x1c + track * 2, size: 2 },
  ];
}

export interface TrackFinding {
  severity: "blocker" | "warning";
  message: string;
}

export interface TrackPlan {
  pattern: number;
  /** Tracks whose contents are replaced, 0-based. */
  changed: number[];
  /** Tracks left empty, 0-based. */
  emptied: number[];
  /** Tracks whose content is overwritten and not preserved anywhere. */
  destructive: { track: number; trigCount: number }[];
  findings: TrackFinding[];
  ok: boolean;
}

/** Trig slots in this pattern, as `(slotOffset, track)` pairs. */
function trigSlots(pattern: Uint8Array): { at: number; track: number }[] {
  const out: { at: number; track: number }[] = [];
  for (let slot = 0; slot < DN2_PATTERN.trigCount; slot++) {
    const at = DN2_PATTERN.trigOffset + slot * DN2_PATTERN.trigSize;
    const track = pattern[at]!;
    if (track !== 0xff) out.push({ at, track });
  }
  return out;
}

/** Lock records in this pattern, as `(recordOffset, track)` pairs. */
function lockRecords(pattern: Uint8Array): { at: number; track: number }[] {
  const out: { at: number; track: number }[] = [];
  for (let i = 0; i < DN2_PATTERN.lockCount; i++) {
    const at = DN2_PATTERN.lockOffset + i * DN2_PATTERN.lockSize;
    const track = pattern[at]!;
    if (track !== 0xff) out.push({ at, track });
  }
  return out;
}

/** Live trigs per track, for reporting what an operation would destroy. */
export function trigCounts(image: Uint8Array, pattern: number): number[] {
  const record = patternRecord(image, pattern, DN2_LAYOUT);
  const counts = new Array<number>(DN2_TRACK_COUNT).fill(0);
  for (const { track } of trigSlots(record)) {
    if (track < DN2_TRACK_COUNT) counts[track]!++;
  }
  return counts;
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
    return { pattern, changed: [], emptied: [], destructive: [], findings, ok: false };
  }

  if (pattern < 0 || pattern >= device.patternCount) {
    findings.push({ severity: "blocker", message: `No such pattern: ${pattern}.` });
    return { pattern, changed: [], emptied: [], destructive: [], findings, ok: false };
  }

  const outOfRange = touchedSlots(shuffle).filter((t) => t < 0 || t >= DN2_TRACK_COUNT);
  if (outOfRange.length > 0) {
    findings.push({
      severity: "blocker",
      message: `Track ${outOfRange.join(", ")} is outside 1..${DN2_TRACK_COUNT}.`,
    });
    return { pattern, changed: [], emptied: [], destructive: [], findings, ok: false };
  }

  const counts = trigCounts(image, pattern);
  const changed = touchedSlots(shuffle);
  const emptied = changed.filter((t) => sourceOf(shuffle, t) === undefined);

  // A destination loses whatever it held, unless its own contents go somewhere else.
  const destructive = changed
    .filter((t) => counts[t]! > 0 && rereference(shuffle, t) === undefined)
    .map((t) => ({ track: t, trigCount: counts[t]! }));

  findings.push({
    severity: "warning",
    message:
      "Whether a Digitone II track is a synth or a MIDI track is decided by a byte we have " +
      "never located. Every region of the track moves together, so it should travel with it — " +
      "but that is inferred, not verified. Check the moved tracks on the device.",
  });

  return { pattern, changed, emptied, destructive, findings, ok: true };
}

export interface TrackMoveOptions {
  /** Required when the plan reports anything destructive. */
  confirmOverwrite?: boolean;
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
  const plan = planTrackMove(image, device, pattern, shuffle);
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
      writeRegion(next, region, patternBase, kitBase, read(sourceRegions[i]!, fromPattern, fromKit));
    });
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
  const record = next.subarray(patternBase, patternBase + DN2_LAYOUT.patternSize);
  const originalRecord = original.subarray(patternBase, patternBase + DN2_LAYOUT.patternSize);
  const touched = new Set(touchedSlots(shuffle));

  const trigsWritten = rewriteReferential(
    record,
    originalRecord,
    shuffle,
    touched,
    DN2_PATTERN.trigOffset,
    DN2_PATTERN.trigSize,
    DN2_PATTERN.trigCount,
  );
  const locksWritten = rewriteReferential(
    record,
    originalRecord,
    shuffle,
    touched,
    DN2_PATTERN.lockOffset,
    DN2_PATTERN.lockSize,
    DN2_PATTERN.lockCount,
  );

  return { image: next, plan, trigsWritten, locksWritten };
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
  offset: number,
  size: number,
  count: number,
): number {
  /** Every record that survives: untouched ones as they were, touched ones from their source. */
  const wanted: { bytes: Uint8Array; track: number }[] = [];

  for (let i = 0; i < count; i++) {
    const at = offset + i * size;
    const track = original[at]!;
    if (track === 0xff) continue;
    if (touched.has(track)) continue; // replaced below, or deliberately discarded
    wanted.push({ bytes: original.subarray(at, at + size), track });
  }

  for (const destination of touched) {
    const source = sourceOf(shuffle, destination);
    if (source === undefined) continue; // cleared: it gets nothing
    for (let i = 0; i < count; i++) {
      const at = offset + i * size;
      if (original[at] !== source) continue;
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
      record.set(entry.bytes, at);
      record[at] = entry.track;
      written++;
    } else {
      // Unused records are marked by their track byte, matching what the readers expect.
      record[at] = 0xff;
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
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  // Per-track trig counts, compared against what the shuffle says each track should end with.
  //
  // The first version asked whether a moved track's number still appeared afterwards, which is
  // wrong for a swap: track A legitimately still has trigs, they are simply B's now. Counts
  // say the thing that actually matters and cannot be fooled that way.
  const beforeCounts = trigCounts(before, pattern);
  const afterCounts = trigCounts(after, pattern);
  const touched = new Set(touchedSlots(shuffle));

  for (let track = 0; track < DN2_TRACK_COUNT; track++) {
    const source = touched.has(track) ? sourceOf(shuffle, track) : track;
    const expected = source === undefined ? 0 : beforeCounts[source]!;
    if (afterCounts[track] !== expected) {
      problems.push(
        `track ${track + 1} should hold ${expected} trigs` +
          (source !== undefined && source !== track ? ` (from track ${source + 1})` : "") +
          `, found ${afterCounts[track]}`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

void DN2_TRACK;
