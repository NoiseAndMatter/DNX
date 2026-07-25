/**
 * Pattern librarian: copy a pattern between slots, banks or projects.
 *
 * Scope here is same-device (DN1 -> DN1). Cross-device copying is the expander's
 * conversion problem and lives elsewhere.
 *
 * Copying the pattern bytes is trivial — the decompressed image has fixed geometry, so a
 * pattern is a fixed-size block at a known offset. The real work is DEPENDENCY
 * RESOLUTION: a pattern's trigs may sound-lock entries in the project's 128-slot sound
 * pool, and those pool indices are meaningless in the destination project. Every locked
 * sound must be carried across, deduplicated against what is already there, and every
 * sound-lock byte rewritten to its new index.
 *
 * Home sounds need no such treatment: the DN1 stores them inline inside the 2,560-byte kit
 * record, so they travel automatically when the kit is copied.
 *
 * Nothing here mutates its inputs. `planPatternCopy` is a pure dry run that reports
 * exactly what would change, including what would be overwritten; `applyPatternCopy`
 * returns a new image. That split is deliberate: overwriting a pattern is irreversible and
 * for most people the +Drive is their only copy, so the preview is a first-class feature
 * rather than a debugging aid.
 */

import {
  KIT,
  PATTERN,
  SYNTH_TRACK_COUNT,
  SOUND_SIZE,
  TRACK,
  readPattern,
  readSoundPool,
  type Dn1Sound,
} from "../project/dn1.js";
import { DN1_LAYOUT } from "../project/dn2image.js";

export const PATTERN_COUNT = 128;
export const POOL_SLOTS = 128;
/** Value stored in a per-step sound-lock byte when the step uses the track's own sound. */
const NO_LOCK = 0xff;

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

function soundsEqual(a: Dn1Sound, b: Dn1Sound): boolean {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
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

/** Count, per source pool slot, how many trigs of this pattern lock it. */
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
  if (!Number.isInteger(index) || index < 0 || index >= PATTERN_COUNT) {
    throw new LibrarianError(`${what} must be an integer in 0..${PATTERN_COUNT - 1}, got ${index}`);
  }
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
  assertIndex(sourceIndex, "sourceIndex");
  assertIndex(destinationIndex, "destinationIndex");

  const srcPool = readSoundPool(sourceImage);
  const dstPool = readSoundPool(destinationImage);
  const locks = lockedSounds(sourceImage, sourceIndex);

  // Track which destination slots we have committed to during this plan, so two source
  // sounds cannot both be promised the same free slot.
  const claimed = new Set<number>();
  const soundMoves: SoundMove[] = [];
  const unresolved: CopyPlan["unresolved"] = [];

  for (const [from, trigCount] of [...locks].sort((a, b) => a[0] - b[0])) {
    const sound = srcPool[from];
    if (!sound) {
      unresolved.push({ from, name: "", trigCount });
      continue;
    }

    // Prefer an identical sound already in the destination — copying it again would waste
    // a slot and leave the user with duplicates.
    let target = -1;
    let reused = false;
    for (let i = 0; i < dstPool.length; i++) {
      const candidate = dstPool[i]!;
      if (!isFreeSlot(candidate) && soundsEqual(candidate, sound)) {
        target = i;
        reused = true;
        break;
      }
    }
    if (target === -1) {
      for (let i = 0; i < dstPool.length; i++) {
        if (!claimed.has(i) && isFreeSlot(dstPool[i]!)) {
          target = i;
          break;
        }
      }
    }

    if (target === -1) {
      unresolved.push({ from, name: sound.name, trigCount });
      continue;
    }
    if (!reused) claimed.add(target);
    soundMoves.push({ from, to: target, name: sound.name, reused, trigCount });
  }

  const destinationTrigCount = patternTrigCount(destinationImage, destinationIndex);

  return {
    sourceIndex,
    destinationIndex,
    sourceName: readPattern(sourceImage, sourceIndex).name,
    destinationName: readPattern(destinationImage, destinationIndex).name,
    destinationOccupied: destinationTrigCount > 0,
    destinationTrigCount,
    soundMoves,
    poolSlotsWritten: soundMoves.filter((m) => !m.reused).map((m) => m.to),
    unresolved,
    ok: unresolved.length === 0,
  };
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
  const plan = planPatternCopy(sourceImage, sourceIndex, destinationImage, destinationIndex);
  if (!plan.ok && !options.force) {
    throw new LibrarianError(
      `Cannot copy: ${plan.unresolved.length} sound lock(s) have nowhere to go in the ` +
        `destination pool (it is full). Free a pool slot, or pass force to copy anyway ` +
        `and leave those trigs pointing at the destination's existing sounds.`,
    );
  }

  const out = Uint8Array.from(destinationImage);
  const srcPool = readSoundPool(sourceImage);
  const dstPool = readSoundPool(out);

  // 1. Carry the sounds across first, so the pattern's rewritten indices are valid.
  for (const move of plan.soundMoves) {
    if (move.reused) continue;
    out.set(srcPool[move.from]!.data, dstPool[move.to]!.offset);
  }

  // 2. Copy the pattern record verbatim, then rewrite its sound-lock bytes.
  const remap = new Map(plan.soundMoves.map((m) => [m.from, m.to]));
  const srcPatternStart = DN1_LAYOUT.headerSize + sourceIndex * PATTERN.size;
  const dstPatternStart = DN1_LAYOUT.headerSize + destinationIndex * PATTERN.size;
  out.set(
    sourceImage.subarray(srcPatternStart, srcPatternStart + PATTERN.size),
    dstPatternStart,
  );

  for (let t = 0; t < SYNTH_TRACK_COUNT; t++) {
    const base = dstPatternStart + PATTERN.trackOffset + t * TRACK.size + TRACK.soundLockOffset;
    for (let step = 0; step < 64; step++) {
      const value = out[base + step]!;
      if (value === NO_LOCK) continue;
      const mapped = remap.get(value);
      if (mapped !== undefined) out[base + step] = mapped;
    }
  }

  // 3. The pattern record stores the slot it believes it occupies.
  out[dstPatternStart + PATTERN.slotIndexOffset] = destinationIndex;

  // 4. Copy the kit. Home sounds live inline inside it, so they need no remapping.
  const srcKitStart = DN1_LAYOUT.kitBase + sourceIndex * KIT.size;
  const dstKitStart = DN1_LAYOUT.kitBase + destinationIndex * KIT.size;
  out.set(sourceImage.subarray(srcKitStart, srcKitStart + KIT.size), dstKitStart);

  return { image: out, plan };
}

/** Free pool slots in an image, for capacity reporting in a UI. */
export function freePoolSlots(image: Uint8Array): number[] {
  return readSoundPool(image)
    .map((s, i) => (isFreeSlot(s) ? i : -1))
    .filter((i) => i >= 0);
}

export { SOUND_SIZE };
