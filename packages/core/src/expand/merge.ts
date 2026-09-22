/**
 * Merging **selected** patterns into an existing Digitone II project, from either machine.
 *
 * A Digitone 1 source is converted on the way in; a Digitone II source is already in the
 * destination's language and is taken as it stands. Everything after that is the same work, which
 * is why it is one function: keep the destination's pool, grow it, reuse what is already there,
 * and re-point every sound lock at wherever its sound landed.
 *
 * ## The other mode
 *
 * `convertProject` transplants a whole project: 128 patterns and the sound pool, wholesale. That is
 * right for *"turn this DN1 project into a DN2 one"* and wrong for *"take these four patterns and
 * put them in the project I am working on"* — because the destination's pool is somebody's work,
 * and overwriting it to make room for four patterns' worth of sounds is not a merge.
 *
 * So this keeps the destination's pool and **grows it**: incoming sounds are appended after what is
 * already there, an identical sound already present is reused rather than duplicated, and every
 * sound lock in the incoming patterns is re-pointed at wherever its sound actually landed.
 *
 * ## Why it converts the whole project first and then takes four patterns
 *
 * Wasteful-looking, and deliberate. `convertProject` is where every expansion rule lives —
 * placement, promotion, aggregation, the field map, 1,152 kit pairs' worth of verified byte
 * mappings — and it works on a project. Reimplementing "convert one pattern" would be a second
 * implementation of the thing this project has spent months getting right, and it would drift.
 *
 * The conversion is pure and takes milliseconds. Only its output is subsetted.
 *
 * ## What a sound lock is, since the whole file turns on it
 *
 * One byte per step per track at `TRACK.soundLockOffset`, `0xFF` for none, otherwise an index into
 * the project's 128-slot pool. Track sounds are **not** pool references — they sit inline in the
 * kit — so a merge only has to re-point locks, and a pattern whose sounds were all promoted to
 * their own tracks needs no pool at all.
 */

import { type ConversionReport } from "./convert.js";
import { convertProject } from "./convert.js";
import { type ExpansionPlan } from "./types.js";
import { planExpansion } from "./plan.js";
import {
  DEFAULT_LANDING,
  type LandingMode,
  landingSlotsFor,
  landingRefusal,
} from "./landing.js";
import {
  DN1_LAYOUT,
  DN2_LAYOUT,
  fitsLayout,
  kitRecord,
  patternRecord,
} from "../project/dn2image.js";
import { PATTERN, TRACK, TRACK_COUNT, soundLockedSlots } from "../project/dn2pattern.js";
import {
  DN2_POOL_OFFSET,
  DN2_SOUND_SIZE,
  POOL_SOUND_COUNT,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
} from "../project/soundmap.js";
import { patternName } from "../project/naming.js";
import { DN2_DEVICE } from "../librarian/device.js";

/** No lock on this step. */
const NO_LOCK = 0xff;

/**
 * Which refusals a caller can turn into a question, told apart by a field rather than by prose.
 *
 * Two of these are answerable by the person at the instrument — *"replace what is there?"*, *"let
 * the pool overflow?"* — and the rest are not. The web needs to tell them apart to know when to
 * ask, and it did so by matching `/already hold a pattern/` against the message.
 *
 * **That coupling made the sentences load-bearing.** Rewording this refusal to stop it naming a
 * TypeScript argument silently stopped the page asking at all, and only a test caught it. Prose is
 * for the person reading it; code should switch on something that is allowed to stay still.
 *
 * **And the tests were doing it too.** Adding `kind` fixed the page and left two matchers in
 * `merge.test.ts` reading the same sentences — so the very next wording change, making the refusal
 * agree with itself in the singular (one slot *holds*), turned `main` red. Both now read `kind`.
 * The rule is not "the page should not match prose", it is **nothing should**: a message written
 * for a musician is going to be rewritten, and every matcher on it is a future build break filed
 * against whoever improved the wording.
 */
export type RefusalKind = "overwrite" | "pool-overflow";

export class MergeRefused extends Error {
  constructor(
    message: string,
    /** Set only for the refusals a caller may reasonably ask about and then override. */
    readonly kind?: RefusalKind,
  ) {
    super(message);
  }
}

export interface MergeOptions {
  /**
   * The project the patterns come from, a Digitone 1 or a Digitone II.
   *
   * A Digitone 1 source is run through `convertProject` first; a Digitone II source is used
   * directly. Both firmware image sizes are accepted on either machine — 1.11 and 1.43 only
   * append, and every offset this file reads is before what they added.
   */
  source: Uint8Array;
  /** Which source patterns to take, in the order they should land. */
  patterns: number[];
  /** The Digitone II project to merge into — its pool and its other patterns are preserved. */
  destination: Uint8Array;
  /**
   * The slot the drop chose — an **anchor**, not necessarily a start.
   *
   * In `relative` mode it is where the lowest-numbered selected pattern goes; in `contiguous`
   * it is where the first one goes and the rest follow it.
   */
  landing: number;
  /**
   * How the rest are positioned around the anchor. Defaults to keeping their spacing.
   *
   * See `landing.ts` — the rule lives there because the page previews it and this writes it, and
   * a preview computed separately from the write is a preview that can be wrong.
   */
  landingMode?: LandingMode;
  /**
   * The expansion plan, for a Digitone 1 source only.
   *
   * Refused with a Digitone II source rather than ignored: expansion is what promotes sound-locked
   * trigs onto the twelve tracks a DN1 does not have, and a DN2 pattern already has sixteen. A
   * caller passing one has misunderstood what it is about to do.
   */
  plan?: ExpansionPlan;
  /**
   * Write what fits when the destination's pool cannot take every incoming sound.
   *
   * **Off by default, and the refusal is the point.** A partial merge loses sounds *silently* — the
   * trigs still fire, at whatever the pool holds at that index, which is worse than not merging.
   */
  allowPoolOverflow?: boolean;
  /**
   * Overwrite destination patterns that already hold something.
   *
   * Off by default. `applyRearrange` asks before overwriting for the same reason: for most people
   * the instrument holds the only copy.
   */
  confirmOverwrite?: boolean;
}

/** Where one incoming sound ended up in the destination's pool. */
export interface PoolPlacement {
  /** Its index in the converted source. */
  from: number;
  /** Its index in the destination. */
  to: number;
  /** True when an identical sound was already in the destination and was pointed at instead. */
  reused: boolean;
  name: string;
}

export interface MergePlan {
  /** The destination with the patterns merged in. */
  image: Uint8Array;
  /** Destination slots written, in landing order. */
  landingSlots: number[];
  /** Destination slots that already held a pattern and would be overwritten. */
  overwrites: number[];
  pool: PoolPlacement[];
  /** Incoming sounds that found no free slot. Empty unless `allowPoolOverflow`. */
  dropped: number[];
  /** Locks pointing past the end of the pool, and locks pointing at empty slots. Left untouched. */
  dangling: { outOfRange: number[]; empty: number[] };
  /** Sound-lock bytes re-pointed. */
  rerouted: number;
  /** Free pool slots left afterwards. */
  freePoolSlots: number;
  /** Which machine the patterns came from. `dn1` means they were converted on the way in. */
  sourceKind: "dn1" | "dn2";
  /**
   * What the conversion did, **absent when none ran**.
   *
   * A Digitone II source is not converted, and a zeroed report would read as a conversion that
   * found nothing to do. Its absence is the honest way to say there was no conversion.
   */
  report?: ConversionReport;
  /**
   * What the merge itself did that somebody has to know about — overwrites, dangling locks, sounds
   * with nowhere to go. Short by construction, and always worth reading.
   */
  warnings: string[];
  /**
   * Per-field conversion notes, **scoped to what is being merged** and folded by message.
   *
   * Converting the source emits one note per inferred field per sound across all 128 patterns:
   * over a thousand lines, nearly all of them about patterns staying behind, and nearly all of them
   * the same sentence repeated. They describe the DN1→DN2 field mapping, not this merge, so they
   * are kept out of `warnings` — a caller can fold them, hide them behind a disclosure or ignore
   * them, but is never handed a wall of text with the four real findings buried in it.
   */
  notes: MergeNote[];
}

/** A conversion note, and how many times it occurred within the merge's scope. */
export interface MergeNote {
  message: string;
  count: number;
}

/**
 * Work out what merging these patterns would do. **Changes nothing and sends nothing.**
 *
 * Returns a whole destination image rather than a patch, because everything downstream — the
 * device write's diff, the file exporter, the manager's session — already works on images, and a
 * patch format would be a fourth way of saying the same thing.
 */
export function planPatternMerge(options: MergeOptions): MergePlan {
  const { source, destination, patterns, landing } = options;

  if (!fitsLayout(destination, DN2_LAYOUT)) {
    throw new MergeRefused(
      `the destination is ${destination.length} bytes, not a Digitone II image — a merge writes ` +
        `DN2 patterns and a DN1 cannot receive them`,
    );
  }
  const fromDn1 = fitsLayout(source, DN1_LAYOUT);
  const sourceKind = fromDn1 ? "dn1" : "dn2";
  if (!fromDn1 && !fitsLayout(source, DN2_LAYOUT)) {
    throw new MergeRefused(
      `the source is ${source.length} bytes, which is neither a Digitone 1 image ` +
        `(${DN1_LAYOUT.imageSizes.join(" or ")}) nor a Digitone II one ` +
        `(${DN2_LAYOUT.imageSizes.join(" or ")})`,
    );
  }
  if (!fromDn1 && options.plan) {
    throw new MergeRefused(
      "an expansion plan was given for a Digitone II source. Expansion promotes sound-locked " +
        "trigs onto the twelve tracks a Digitone 1 does not have, and these patterns already " +
        "have sixteen — there is nothing for it to decide.",
    );
  }
  if (patterns.length === 0) throw new MergeRefused("no patterns selected");
  const sourceLayout = fromDn1 ? DN1_LAYOUT : DN2_LAYOUT;
  for (const p of patterns) {
    if (!Number.isInteger(p) || p < 0 || p >= sourceLayout.patternCount) {
      throw new MergeRefused(`${p} is not a ${fromDn1 ? "Digitone 1" : "Digitone II"} pattern index`);
    }
  }
  if (!Number.isInteger(landing) || landing < 0 || landing >= DN2_LAYOUT.patternCount) {
    throw new MergeRefused(`${landing} is not a Digitone II pattern slot`);
  }
  // Refused rather than truncated. Dropping the tail of a selection is the kind of quiet
  // helpfulness that gets discovered three patterns later.
  //
  // Computed from the real destinations rather than from `landing + count`: with relative
  // landing the two are different numbers, and the arithmetic version would both miss real
  // overflows and invent ones that are not there.
  const landingSlots = landingSlotsFor(patterns, landing, options.landingMode ?? DEFAULT_LANDING);
  const refusal = landingRefusal(patterns, landingSlots, DN2_LAYOUT.patternCount);
  if (refusal) throw new MergeRefused(refusal);

  /*
   * **Planned for the patterns being merged, not for the project they came from.** Expansion
   * decides which sounds get a track and which stay locked across everything in scope, so a
   * whole-project plan can hand track 9 to a sound used only in pattern 99 while a sound in these
   * four overflows. The caller may still supply its own plan; this is the default.
   *
   * None of it applies to a Digitone II source. Its patterns are already DN2 patterns, so
   * `converted` is the source itself and there is no report — the pool work below reads the same
   * offsets either way, which is the whole reason one function serves both.
   */
  let converted = source;
  let report: ConversionReport | undefined;
  if (fromDn1) {
    const plan = options.plan ?? planExpansion(source, { patterns: [...patterns].sort((a, b) => a - b) });
    ({ image: converted, report } = convertProject(source, destination, { plan }));
  }

  const image = Uint8Array.from(destination);

  const overwrites = landingSlots.filter((slot) => patternOccupied(destination, slot));
  if (overwrites.length > 0 && !options.confirmOverwrite) {
    // **States the fact, not the remedy.** This sentence is shown to a musician verbatim — the web
    // puts it straight into a dialog — and it used to end "pass confirmOverwrite to replace them",
    // naming a TypeScript argument nobody at a keyboard can pass. The CLIs never showed it either:
    // they check their own `--confirm` first and print their own wording (`cli/rearrange.ts:272`).
    // So the argument name was read by exactly one audience, the one that could do nothing with it.
    //
    // How to go ahead belongs to whoever is asking: a flag in a terminal, a button on a page.
    const one = overwrites.length === 1;
    throw new MergeRefused(
      `${overwrites.length} destination slot${one ? "" : "s"} already ${one ? "holds" : "hold"} ` +
        `a pattern (${overwrites.map(patternName).join(", ")}). Nothing was changed — ` +
        `replacing ${one ? "it" : "them"} would discard what is there, and landing somewhere ` +
        `empty would not.`,
      "overwrite",
    );
  }

  // --- which pool slots the incoming patterns actually need ------------------------------------
  //
  // Read off the *converted* patterns, not the source: expansion promotes sound-locked trigs onto
  // their own tracks, so the set of locks that survive is smaller than the DN1's and is only known
  // after conversion. A merge that reserved pool space for the pre-conversion set would append
  // sounds nothing points at.
  const seen = new Set<number>();
  for (const p of patterns) {
    for (const slot of soundLockedSlots(patternRecord(converted, p, DN2_LAYOUT))) seen.add(slot);
  }

  // **A lock can point at a slot that is not there.** Found by the round-trip test: merging the
  // same pattern twice kept appending a nameless sound, because one lock referenced slot **161** —
  // beyond the 128-slot pool entirely. Reading it walked off the end of the pool into whatever
  // follows and wrote that into the destination.
  //
  // Dangling locks are ordinary in real projects (`poolCoverage` had to learn the same thing from
  // `003 AMBZ.dnprj`), so this reports them and leaves them pointing where they were rather than
  // refusing a whole merge over somebody's old untidiness. What it will not do is invent a sound.
  const outOfRange = [...seen].filter((slot) => slot >= POOL_SOUND_COUNT).sort((a, b) => a - b);
  const empty = [...seen].filter(
    (slot) => slot < POOL_SOUND_COUNT && !poolSlotHoldsSound(converted, slot),
  ).sort((a, b) => a - b);
  const needed = new Set(
    [...seen].filter((slot) => slot < POOL_SOUND_COUNT && poolSlotHoldsSound(converted, slot)),
  );

  // --- place them ------------------------------------------------------------------------------
  const free = freePoolSlots(destination);
  const pool: PoolPlacement[] = [];
  const dropped: number[] = [];
  const remap = new Map<number, number>();

  for (const from of [...needed].sort((a, b) => a - b)) {
    const sound = poolSlot(converted, from);
    const already = findIdenticalSound(destination, sound);
    if (already !== undefined) {
      pool.push({ from, to: already, reused: true, name: soundName(sound) });
      remap.set(from, already);
      continue;
    }
    const to = free.shift();
    if (to === undefined) {
      dropped.push(from);
      continue;
    }
    setPoolSlot(image, to, sound);
    pool.push({ from, to, reused: false, name: soundName(sound) });
    remap.set(from, to);
  }

  if (dropped.length > 0 && !options.allowPoolOverflow) {
    throw new MergeRefused(
      `the destination's pool has no room for ${dropped.length} of the ${needed.size} sound(s) ` +
        `these patterns need. Nothing was changed.\n\n` +
        `A partial merge is worse than none: the trigs would still fire, at whatever those slots ` +
        `happen to hold. Free some pool slots, or take fewer patterns — or go ahead knowing those ` +
        `${dropped.length} sound(s) will not be there.`,
      "pool-overflow",
    );
  }

  // --- copy the patterns in, re-pointing every lock ---------------------------------------------
  let rerouted = 0;
  patterns.forEach((from, i) => {
    const to = landingSlots[i]!;
    const pattern = Uint8Array.from(patternRecord(converted, from, DN2_LAYOUT));
    rerouted += reroute(pattern, remap);
    setPatternRecord(image, to, pattern);
    setKitRecord(image, to, kitRecord(converted, from, DN2_LAYOUT));
  });

  // Conversion notes describe the DN1 to DN2 field mapping. Without a conversion there are none,
  // and inventing an empty list to keep a shape would say the mapping ran and found nothing.
  const notes = report ? scopedNotes(report, patterns, pool) : [];
  const warnings: string[] = [];
  if (outOfRange.length > 0) {
    warnings.unshift(
      `${outOfRange.length} lock(s) point outside the 128-slot pool (${outOfRange.slice(0, 6).join(", ")}) ` +
        `— left as they are, since there is no sound to move`,
    );
  }
  if (empty.length > 0) {
    warnings.unshift(
      `${empty.length} lock(s) point at empty pool slot(s) (${empty.slice(0, 6).join(", ")}) — a ` +
        `dangling lock in the source, left as it is`,
    );
  }
  if (dropped.length > 0) {
    warnings.unshift(
      `${dropped.length} sound(s) had nowhere to go and their trigs will play whatever the ` +
        `destination already holds at those slots`,
    );
  }
  if (overwrites.length > 0) {
    warnings.unshift(`${overwrites.length} destination pattern(s) replaced: ${overwrites.map(patternName).join(", ")}`);
  }

  return {
    image,
    landingSlots,
    overwrites,
    pool,
    dropped,
    dangling: { outOfRange, empty },
    rerouted,
    freePoolSlots: free.length,
    sourceKind,
    ...(report === undefined ? {} : { report }),
    warnings,
    notes,
  };
}

/**
 * The conversion notes that are about **this merge**, folded by message.
 *
 * A merge converts the whole source project — it has to, because a pattern's kit is written by the
 * same pass that writes every other kit — and the report that comes back describes all of it. Two
 * filters make it relevant again:
 *
 * - **pattern-scoped notes** survive only for the patterns being merged. A note about pattern 90's
 *   kit describes something that is not going anywhere.
 * - **pool-scoped notes** survive only for the source slots whose sounds were actually placed.
 *
 * Notes with neither scope are project-wide and always kept. What is left is then folded by
 * message, because the same inferred field on the same offset produces the identical sentence for
 * every sound that carries it, and forty copies of it say nothing the first one did not.
 */
function scopedNotes(
  report: ConversionReport,
  patterns: readonly number[],
  pool: readonly PoolPlacement[],
): MergeNote[] {
  const inScope = new Set(patterns);
  const fromSlots = new Set(pool.map((p) => p.from));
  const counts = new Map<string, number>();

  for (const w of report.warnings) {
    if (w.pattern !== undefined && !inScope.has(w.pattern)) continue;
    if (w.poolSlot !== undefined && !fromSlots.has(w.poolSlot)) continue;
    counts.set(w.message, (counts.get(w.message) ?? 0) + 1);
  }

  return [...counts].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}

/**
 * How a merge reads to someone about to commit it.
 *
 * **Facts and findings only.** The conversion notes live in `plan.notes`, folded and scoped, and a
 * caller shows them separately — putting them here once buried the four lines that matter under a
 * thousand that did not.
 */
export function describeMerge(plan: MergePlan): string[] {
  const appended = plan.pool.filter((p) => !p.reused);
  const reused = plan.pool.length - appended.length;
  return [
    `${plan.landingSlots.length} pattern(s) → ${plan.landingSlots.map(patternName).join(", ")}`,
    `${appended.length} sound(s) appended to the pool${reused > 0 ? `, ${reused} already there and reused` : ""}`,
    `${plan.rerouted} sound lock(s) re-pointed`,
    `${plan.freePoolSlots} pool slot(s) free afterwards`,
    // Overwrites are not listed twice. `warnings` already names them, with a count, and a merge
    // that replaces a pattern should say so once in the voice that means "look at this".
    ...plan.warnings,
  ];
}

// --- pattern and pool access ----------------------------------------------------------------------

/**
 * Re-point every lock through the map. Locks with no entry are left alone.
 *
 * **Deliberately not gated on `STEP_FLAG.trig`, unlike the reader.** `soundLockedSlots` now counts
 * a lock only where a trig exists, because reading every step reported slot 0 and slot 161 locked
 * by all 128 patterns of every corpus project — unset memory, not music. This writer still visits
 * every step.
 *
 * The asymmetry is intentional for now. Gating it would touch fewer bytes and make the diff sent to
 * a device smaller, which is worth having; but it is a **write**, the reader's gate is the change
 * that has just been made, and altering both at once on the same inference is how a wrong
 * assumption gets twice as far. Worth revisiting with a round trip against the instrument.
 */
function reroute(pattern: Uint8Array, remap: Map<number, number>): number {
  let changed = 0;
  for (let t = 0; t < TRACK_COUNT; t++) {
    const at = PATTERN.trackOffset + t * PATTERN.trackSize;
    for (let step = 0; step < 128; step++) {
      const i = at + TRACK.soundLockOffset + step;
      const slot = pattern[i]!;
      if (slot === NO_LOCK) continue;
      const to = remap.get(slot);
      if (to === undefined || to === slot) continue;
      pattern[i] = to;
      changed++;
    }
  }
  return changed;
}

function poolAt(slot: number): number {
  return DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE;
}

function poolSlot(image: Uint8Array, slot: number): Uint8Array {
  const at = poolAt(slot);
  return image.subarray(at, at + DN2_SOUND_SIZE);
}

function setPoolSlot(image: Uint8Array, slot: number, sound: Uint8Array): void {
  image.set(sound, poolAt(slot));
}

function soundName(sound: Uint8Array): string {
  const raw = sound.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  const end = raw.indexOf(0);
  return new TextDecoder("windows-1252").decode(end === -1 ? raw : raw.subarray(0, end)).trim();
}

/**
 * Whether a pool slot holds a sound, by its name field.
 *
 * The same test `poolCoverage` uses, and for the same reason: a DN1's slots are all *framed*
 * whether or not they hold anything, so framing answers nothing and the name does.
 */
function poolSlotHoldsSound(image: Uint8Array, slot: number): boolean {
  const at = poolAt(slot) + SOUND_NAME_OFFSET;
  const name = image.subarray(at, at + SOUND_NAME_SIZE);
  return !name.every((b) => b === 0 || b === 0xff);
}

/** Free slots, ascending — so incoming sounds land after what is already there. */
function freePoolSlots(image: Uint8Array): number[] {
  const free: number[] = [];
  for (let slot = 0; slot < POOL_SOUND_COUNT; slot++) {
    if (!poolSlotHoldsSound(image, slot)) free.push(slot);
  }
  return free;
}

/**
 * A pool slot already holding this exact sound, if there is one.
 *
 * Byte-identical only. A looser test — same name, say — would collapse two sounds a musician
 * deliberately kept apart, and the cost of missing a match is one duplicated pool slot out of 128.
 */
function findIdenticalSound(image: Uint8Array, sound: Uint8Array): number | undefined {
  for (let slot = 0; slot < POOL_SOUND_COUNT; slot++) {
    if (!poolSlotHoldsSound(image, slot)) continue;
    const existing = poolSlot(image, slot);
    let same = true;
    for (let i = 0; i < DN2_SOUND_SIZE; i++) {
      if (existing[i] !== sound[i]) { same = false; break; }
    }
    if (same) return slot;
  }
  return undefined;
}

/**
 * Whether a destination slot already holds a pattern.
 *
 * `DN2_DEVICE.summarise` already answers this, and the manager's grid has been showing it on
 * hardware-verified data for weeks. A second implementation here would be a second opinion about
 * what "occupied" means, and the two would disagree the first time either changed.
 */
function patternOccupied(image: Uint8Array, slot: number): boolean {
  return DN2_DEVICE.summarise(image, slot).occupied === true;
}

function setPatternRecord(image: Uint8Array, slot: number, pattern: Uint8Array): void {
  image.set(pattern, DN2_LAYOUT.headerSize + slot * DN2_LAYOUT.patternSize);
}

function setKitRecord(image: Uint8Array, slot: number, kit: Uint8Array): void {
  image.set(kit, DN2_LAYOUT.kitBase + slot * DN2_LAYOUT.kitSize);
}
