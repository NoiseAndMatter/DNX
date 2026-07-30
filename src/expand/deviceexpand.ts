/**
 * Expand a Digitone 1 project onto a Digitone II, both of them live, with no file in between.
 *
 * The thing this whole project was started for. Every stage already existed and had been proven
 * separately; this is the join, and the join is mostly about **refusing to do it when the source
 * is incomplete**.
 *
 * ```
 * DN1 device --0x60 x128--> patternKits --+
 *                                          +--> convertProject --> diff --> 0x50 --> DN2 device
 * DN1 panel  --pool send--> 0x53 x N   ---+
 * ```
 *
 * ## The destination device is its own template
 *
 * `convertProject` needs a DN2 project to transplant into, and until now that meant a file — a
 * blank exported from a device, found via `DN_TEMPLATE` or a sibling checkout.
 *
 * Reading the **destination** supplies one for free, and a better one: its storage version is
 * right by construction, because it came off the machine that has to load the result. §8a of
 * `dn2-format.md` is a long story about versions differing between firmwares; a template read from
 * the target cannot be the wrong version for the target.
 *
 * It also doubles as the **diff baseline**. `writeChangedRecords` sends only what differs, so
 * expanding onto a DN2 whose patterns are already mostly right costs only the patterns that
 * changed — rather than 14.6 MB every time.
 *
 * ## The refusal that matters
 *
 * **A Digitone 1's sound pool cannot be requested** (§5c): `0x63` reaches the four kit track
 * sounds, not the 128-slot pool, and a DN1 project dump carries no `0x53` at all. The pool is
 * reachable only from the front panel, as a separate capture.
 *
 * And the pool is *exactly* what expansion exists to unfold: sound-locked trigs point into it, and
 * promoting them onto their own tracks is the whole feature. So expanding from a DN1 read alone
 * would produce a project that looks complete, converts without error, writes successfully — and
 * has lost every sound-locked sound.
 *
 * `poolCoverage` is therefore not a warning helper. It is the check that decides whether this may
 * run at all, and it asks the only question that matters: **do the pool slots this project's locks
 * point at actually contain sounds?**
 */

import { DN1_LAYOUT, DN2_LAYOUT } from "../project/dn2image.js";
import { SYNTH_TRACK_COUNT, TRACK, trackRecord } from "../project/dn1.js";
import { DN1_POOL_OFFSET, SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "../project/soundmap.js";
import { patternName } from "../sheet/naming.js";
import { type ConversionReport, convertProject } from "./convert.js";
import type { ExpansionPlan } from "./types.js";

/** One DN1 sound record. 302 bytes on that family. */
const DN1_SOUND_SIZE = 302;

export class DeviceExpandRefused extends Error {}

export interface PoolCoverage {
  /** Pool slots the project's sound locks point at, ascending. */
  referenced: number[];
  /** Referenced slots that hold no sound. */
  missing: number[];
  /** How many trigs are sound-locked at all. Zero means the pool is irrelevant to this project. */
  lockedTrigs: number;
  /** How many of the 128 slots hold a named sound. */
  populated: number;
  /**
   * True when the pool was **never captured** — locks exist and not one slot holds a sound.
   *
   * **This is the distinction the corpus forced.** The first version of this guard refused on any
   * empty referenced slot, and `003 AMBZ.dnprj` promptly failed it: five trigs locked to slot 11,
   * which holds a framed but nameless sound. That is a **dangling lock in a real project** — the
   * sound was deleted or never loaded — and it has nothing to do with how the project was read.
   * The file-based expander has always coped with it.
   *
   * A DN1 read over SysEx is a different thing entirely: **every** slot is empty, because no
   * request reaches the pool. That is the catastrophe worth refusing, and it looks nothing like
   * ordinary untidiness once you count the whole pool rather than only the slots in question.
   *
   * Note that every slot of a DN1 pool is *framed* whether or not it holds anything — 128/128 in
   * `AMBZ` — so framing cannot be used to answer this. The name field can.
   */
  looksUncaptured: boolean;
  /** True when every slot the project needs is populated. */
  complete: boolean;
}

/**
 * Whether a DN1 image's sound pool actually contains what its patterns point at.
 *
 * Reads the locks rather than counting pool entries, because the question is not "is the pool
 * full" but "is *this project's* pool complete". A project that sound-locks eleven slots needs
 * eleven, and a pool holding ninety-three unrelated sounds would not help it.
 *
 * A slot counts as populated if its name field is non-empty. That is a weaker test than framing,
 * and deliberately so: a half-written pool is not something to reason confidently about, and the
 * caller is being told to go and capture one properly either way.
 */
export function poolCoverage(dn1Image: Uint8Array): PoolCoverage {
  if (dn1Image.length !== DN1_LAYOUT.imageSize) {
    throw new DeviceExpandRefused(
      `the source is ${dn1Image.length} bytes, not a Digitone 1 image (${DN1_LAYOUT.imageSize})`,
    );
  }

  const referenced = new Set<number>();
  let lockedTrigs = 0;

  for (let index = 0; index < DN1_LAYOUT.patternCount; index++) {
    const at = DN1_LAYOUT.headerSize + index * DN1_LAYOUT.patternSize;
    const pattern = dn1Image.subarray(at, at + DN1_LAYOUT.patternSize);
    for (let t = 0; t < SYNTH_TRACK_COUNT; t++) {
      const track = trackRecord(pattern, t);
      for (let step = 0; step < 64; step++) {
        const slot = track[TRACK.soundLockOffset + step]!;
        if (slot === 0xff) continue;
        lockedTrigs++;
        referenced.add(slot);
      }
    }
  }

  const poolAt = DN1_LAYOUT.tailBase + DN1_POOL_OFFSET;
  const holdsSound = (slot: number): boolean => {
    const at = poolAt + slot * DN1_SOUND_SIZE + SOUND_NAME_OFFSET;
    const name = dn1Image.subarray(at, at + SOUND_NAME_SIZE);
    return !name.every((b) => b === 0 || b === 0xff);
  };

  let populated = 0;
  for (let slot = 0; slot < 128; slot++) if (holdsSound(slot)) populated++;

  const sorted = [...referenced].sort((a, b) => a - b);
  const missing = sorted.filter((slot) => !holdsSound(slot));

  return {
    referenced: sorted,
    missing,
    lockedTrigs,
    populated,
    looksUncaptured: lockedTrigs > 0 && populated === 0,
    complete: missing.length === 0,
  };
}

export interface DeviceExpandOptions {
  /** The Digitone 1 project, read from the source device (and its pool, if separately captured). */
  source: Uint8Array;
  /** The Digitone II project as it is now — the transplant target and the diff baseline. */
  destination: Uint8Array;
  plan?: ExpansionPlan;
  projectName?: string;
  /**
   * Proceed even though pool slots the project references are empty.
   *
   * Exists so the refusal can be overridden knowingly — a DN1 project with no sound locks at all
   * never trips it, and someone converting a sketch they know has no locks should not be blocked.
   * It is not a flag to set by default: what it silences is the loss of every sound-locked sound.
   */
  allowIncompletePool?: boolean;
}

export interface DeviceExpandPlan {
  /** The converted DN2 image, ready to be diffed against `destination` and written. */
  image: Uint8Array;
  report: ConversionReport;
  pool: PoolCoverage;
  /** DN2 pattern slots that differ from what the destination holds now. */
  changedSlots: number[];
  /** Roughly what the write will cost, framing included. */
  estimatedBytes: number;
  /** Anything the caller should say out loud before writing. */
  warnings: string[];
}

/**
 * Work out what expanding this DN1 onto this DN2 would do. Sends nothing.
 *
 * Separate from the write, like every other plan in this codebase, because the interesting
 * decision — *is this going to lose my sound locks, and how many patterns will it overwrite* —
 * has to be answerable before anything reaches an instrument.
 */
export function planDeviceExpand(options: DeviceExpandOptions): DeviceExpandPlan {
  const { source, destination } = options;

  if (destination.length !== DN2_LAYOUT.imageSize) {
    throw new DeviceExpandRefused(
      `the destination is ${destination.length} bytes, not a Digitone II image. Expansion targets ` +
        `a DN2; a DN1 cannot receive one.`,
    );
  }

  const pool = poolCoverage(source);

  // Refused only when the pool was never captured at all — not for a few dangling locks, which
  // real projects have and the file path has always tolerated. See `looksUncaptured`.
  if (pool.looksUncaptured && !options.allowIncompletePool) {
    throw new DeviceExpandRefused(
      `this project locks ${pool.lockedTrigs} trig(s) to ${pool.referenced.length} sound-pool ` +
        `slot(s), and **the whole pool is empty** — all 128 slots.\n\n` +
        `That is what a Digitone 1 read over SysEx looks like: its pool cannot be requested, and ` +
        `a DN1 project dump carries no sounds either, so the pool comes only from ` +
        `SETTINGS > SYSEX DUMP on the device itself.\n\n` +
        `Expanding now would move every sound-locked trig onto its own track and find nothing to ` +
        `put there — losing precisely what this feature exists to move. Capture the pool and ` +
        `merge it first.`,
    );
  }

  const { image, report } = convertProject(source, destination, {
    ...(options.plan === undefined ? {} : { plan: options.plan }),
    ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
  });

  const changedSlots: number[] = [];
  for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) {
    if (recordDiffers(destination, image, slot)) changedSlots.push(slot);
  }

  const warnings = report.warnings.map((w) => w.message);
  if (!pool.complete) {
    // Worth saying even when it is the project's own pre-existing untidiness, because after a
    // conversion those trigs sit on their own tracks where a silent one is more obvious.
    warnings.unshift(
      `${pool.missing.length} referenced pool slot(s) hold no sound (${pool.missing
        .slice(0, 6)
        .join(", ")}) — trigs locked to them will arrive silent. ${
        pool.looksUncaptured
          ? "The whole pool is empty: it was never captured."
          : `${pool.populated} of 128 slots do hold sounds, so this is a dangling lock in the project rather than a missing capture.`
      }`,
    );
  }
  if (changedSlots.length === 0) {
    warnings.push("nothing to write — the destination already holds this conversion");
  }

  // The wire cost, since it is the number that decides whether this is seconds or minutes.
  const perRecord = Math.ceil(((DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize) * 8) / 7) + 15;

  return {
    image,
    report,
    pool,
    changedSlots,
    estimatedBytes: changedSlots.length * perRecord,
    warnings,
  };
}

/** How a plan reads to a person about to commit it. */
export function describeDeviceExpand(plan: DeviceExpandPlan): string[] {
  const lines = [
    `${plan.report.patternsWritten} pattern(s) converted, ${plan.report.trigsPromoted} trig(s) promoted`,
    `${plan.changedSlots.length} slot(s) differ from the device: ${
      plan.changedSlots.slice(0, 12).map(patternName).join(", ")
    }${plan.changedSlots.length > 12 ? ` +${plan.changedSlots.length - 12} more` : ""}`,
    `about ${(plan.estimatedBytes / 1_000_000).toFixed(1)} MB to send`,
  ];
  if (plan.pool.lockedTrigs > 0) {
    lines.push(
      `sound pool: ${plan.pool.referenced.length} slot(s) referenced by ${plan.pool.lockedTrigs} ` +
        `locked trig(s)${plan.pool.complete ? ", all present" : `, ${plan.pool.missing.length} MISSING`}`,
    );
  }
  return lines;
}

function recordDiffers(a: Uint8Array, b: Uint8Array, slot: number): boolean {
  const patternAt = DN2_LAYOUT.headerSize + slot * DN2_LAYOUT.patternSize;
  for (let i = 0; i < DN2_LAYOUT.patternSize; i++) {
    if (a[patternAt + i] !== b[patternAt + i]) return true;
  }
  const kitAt = DN2_LAYOUT.kitBase + slot * DN2_LAYOUT.kitSize;
  for (let i = 0; i < DN2_LAYOUT.kitSize; i++) {
    if (a[kitAt + i] !== b[kitAt + i]) return true;
  }
  return false;
}
