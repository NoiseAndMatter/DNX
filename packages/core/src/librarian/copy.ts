/**
 * Pattern librarian: copy a pattern between slots, banks or projects.
 *
 * **This is a presentation layer over `expand/merge.ts`, not a second engine.** It was the
 * original one. Copying the pattern bytes is trivial — the decompressed image has fixed
 * geometry — and the real work is DEPENDENCY RESOLUTION: a pattern's trigs sound-lock entries in
 * the project's 128-slot pool, those indices mean nothing in the destination, and every locked
 * sound has to be carried across, deduplicated against what is already there, and every lock byte
 * re-pointed. `planPatternMerge` grew to do exactly that for all three directions a copy can
 * take, and two implementations of one rule is one too many.
 *
 * **What the fold had to protect.** This engine is the one validated on hardware: a pattern
 * copied into another project loaded on a Digitone 1 and played, carrying exactly the sounds it
 * needed. That evidence is about *bytes*, so it transfers only if the bytes are unchanged. The
 * test that used to run both engines and demand identical images cannot say that any more — with
 * one calling the other it would pass whatever they did. `test/merge.test.ts` pins the digest
 * this engine produced on a corpus pair instead, recorded from the old implementation before it
 * was replaced.
 *
 * What stays here is what the merge has no reason to carry: a plan shaped for a confirmation
 * dialog. Trig counts per sound, the name of the pattern about to be overwritten, whether it
 * holds anything at all. `planPatternCopy` is still a pure dry run and `applyPatternCopy` still
 * returns a new image, because overwriting a pattern is irreversible and for most people the
 * +Drive is their only copy.
 *
 * Home sounds still need no special treatment: the DN1 stores them inline inside the 2,560-byte
 * kit record, so they travel with the kit.
 *
 * Scope is unchanged — same-device Digitone 1. The merge answers the other directions, and
 * callers that need them use it directly.
 */

import { MergeRefused, planPatternMerge, type MergePlan } from "../expand/merge.js";
import {
  SYNTH_TRACK_COUNT,
  readPattern,
  readSoundPool,
  type Dn1Sound,
} from "../project/dn1.js";
import { DN1_LAYOUT } from "../project/dn2image.js";

export class LibrarianError extends Error {}

export interface SoundMove {
  /** Pool slot in the source project. */
  from: number;
  /** Pool slot in the destination project. */
  to: number;
  name: string;
  /** True when the destination already held an identical sound and no copy is needed. */
  reused: boolean;
  /** Trigs in the copied pattern that reference this sound. */
  trigCount: number;
}

export interface CopyPlan {
  sourceIndex: number;
  destinationIndex: number;
  /** Name of the pattern being copied. */
  sourceName: string;
  /** Name of the pattern that will be overwritten, for the confirmation prompt. */
  destinationName: string;
  /** True when the destination slot currently holds trigs, i.e. real work will be lost. */
  destinationOccupied: boolean;
  /** Trigs in the destination pattern that will be destroyed. */
  destinationTrigCount: number;
  soundMoves: SoundMove[];
  /** Destination pool slots that will be written. */
  poolSlotsWritten: number[];
  /** Sound locks that cannot be carried because the destination pool is full. */
  unresolved: { from: number; name: string; trigCount: number }[];
  /** True when the copy can proceed without losing sound locks. */
  ok: boolean;
}

/** A pool slot is free when it holds no framed object, or a framed object with no name. */
function isFreeSlot(sound: Dn1Sound): boolean {
  return !sound.framed || sound.name === "";
}

function patternTrigCount(image: Uint8Array, index: number): number {
  let n = 0;
  for (const track of readPattern(image, index).tracks) n += track.trigs.length;
  return n;
}

/**
 * How many trigs of one pattern lock each pool slot.
 *
 * Read from the decoder rather than taken from the merge, because the merge reports *which*
 * sounds moved and not how many trigs wanted them — and "3 trigs use this sound" is the part a
 * person acts on in a confirmation dialog.
 */
function lockedSounds(image: Uint8Array, index: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const track of readPattern(image, index).tracks) {
    if (track.index >= SYNTH_TRACK_COUNT) continue;
    for (const trig of track.trigs) {
      if (trig.soundLock === undefined) continue;
      counts.set(trig.soundLock, (counts.get(trig.soundLock) ?? 0) + 1);
    }
  }
  return counts;
}

function assertIndex(index: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= DN1_LAYOUT.patternCount) {
    throw new LibrarianError(`${what} must be an integer in 0..${DN1_LAYOUT.patternCount - 1}, got ${index}`);
  }
}

/**
 * Run the merge once and shape its result as a `CopyPlan`.
 *
 * **`allowPoolOverflow` is always on here and `confirmOverwrite` always set**, because this layer
 * reports where the merge refuses. `planPatternCopy` has to be able to describe a copy that would
 * lose sound locks without throwing, and `applyPatternCopy` enforces the refusal afterwards —
 * which keeps the decision with the caller who has shown the plan to a person. Turning both off
 * would move the refusal earlier and make the dry run useless for the dialog it exists to fill.
 */
function run(
  sourceImage: Uint8Array,
  sourceIndex: number,
  destinationImage: Uint8Array,
  destinationIndex: number,
): { plan: CopyPlan; merged: MergePlan } {
  assertIndex(sourceIndex, "sourceIndex");
  assertIndex(destinationIndex, "destinationIndex");

  let merged: MergePlan;
  try {
    merged = planPatternMerge({
      source: sourceImage,
      patterns: [sourceIndex],
      destination: destinationImage,
      landing: destinationIndex,
      confirmOverwrite: true,
      allowPoolOverflow: true,
    });
  } catch (error) {
    // The merge refuses the same things this module does; only the error type differs, and
    // everything calling in here catches LibrarianError.
    throw error instanceof MergeRefused ? new LibrarianError(error.message) : error;
  }

  const trigCounts = lockedSounds(sourceImage, sourceIndex);
  const srcPool = readSoundPool(sourceImage);
  const destinationTrigCount = patternTrigCount(destinationImage, destinationIndex);

  const soundMoves: SoundMove[] = merged.pool.map((placement) => ({
    from: placement.from,
    to: placement.to,
    name: placement.name,
    reused: placement.reused,
    trigCount: trigCounts.get(placement.from) ?? 0,
  }));

  const unresolved = merged.dropped.map((from) => {
    const sound = srcPool[from];
    return {
      from,
      name: sound && !isFreeSlot(sound) ? sound.name : "",
      trigCount: trigCounts.get(from) ?? 0,
    };
  });

  return {
    merged,
    plan: {
      sourceIndex,
      destinationIndex,
      sourceName: readPattern(sourceImage, sourceIndex).name,
      destinationName: readPattern(destinationImage, destinationIndex).name,
      destinationOccupied: destinationTrigCount > 0,
      destinationTrigCount,
      soundMoves,
      poolSlotsWritten: soundMoves.filter((move) => !move.reused).map((move) => move.to),
      unresolved,
      ok: unresolved.length === 0,
    },
  };
}

/**
 * Work out what copying `sourceIndex` of `sourceImage` over `destinationIndex` of
 * `destinationImage` would do. Pure: neither image is touched.
 *
 * Pass the same image as both arguments to move a pattern within one project.
 */
export function planPatternCopy(
  sourceImage: Uint8Array,
  sourceIndex: number,
  destinationImage: Uint8Array,
  destinationIndex: number,
): CopyPlan {
  return run(sourceImage, sourceIndex, destinationImage, destinationIndex).plan;
}

/**
 * Apply a copy, returning a new destination image. The input images are not modified.
 *
 * Refuses when the plan reports unresolved sound locks, since proceeding would silently
 * change which sound a trig plays. Pass `force` to accept that and leave those locks
 * pointing at whatever occupies the slot in the destination — only meaningful when the
 * caller has shown the user the plan and they chose to continue.
 */
export function applyPatternCopy(
  sourceImage: Uint8Array,
  sourceIndex: number,
  destinationImage: Uint8Array,
  destinationIndex: number,
  options: { force?: boolean } = {},
): { image: Uint8Array; plan: CopyPlan } {
  const { plan, merged } = run(sourceImage, sourceIndex, destinationImage, destinationIndex);
  if (!plan.ok && !options.force) {
    throw new LibrarianError(
      `Cannot copy: ${plan.unresolved.length} sound lock(s) have nowhere to go in the ` +
        `destination pool (it is full). Free a pool slot, or pass force to copy anyway ` +
        `and leave those trigs pointing at the destination's existing sounds.`,
    );
  }
  return { image: merged.image, plan };
}

/** Free pool slots in an image, for capacity reporting in a UI. */
export function freePoolSlots(image: Uint8Array): number[] {
  return readSoundPool(image)
    .map((sound, index) => (isFreeSlot(sound) ? index : -1))
    .filter((index) => index >= 0);
}
