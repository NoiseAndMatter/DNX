/**
 * What is in a project's preset pool, and what actually uses it.
 *
 * ## Why the pool is worth auditing at all
 *
 * The manual is direct about it: *"The primary benefit of presets loaded to the pool is the
 * possibility for them to be preset locked. This feature is not available for the presets in the
 * +Drive library."*
 *
 * So a pool slot earns its place by being **locked to**. A slot nothing locks is occupying one of
 * 128 places for no reason, and a lock pointing at nothing is a trig that will play whatever
 * happens to be there. Both are invisible on the instrument, which is exactly the kind of thing a
 * tool should be able to say.
 *
 * ## The device says preset; this codebase says sound
 *
 * `readSoundPool`, `SOUND_SIZE`, `soundLockCount` — all ours, all predating the manual being read.
 * This module says **preset** because that is the hardware's word, and reads the pool through the
 * existing constants. Renaming the rest is its own job.
 *
 * ## Read-only, deliberately
 *
 * Nothing here writes. Every judgement it makes — unused, dangling, duplicated — is a judgement
 * somebody should look at before acting on, and several of them are **ordinary in real projects**
 * rather than faults. `merge.ts` found a lock referencing slot 161 in the wild, and `poolCoverage`
 * had to learn the same thing from `003 AMBZ.dnprj`. An audit that quietly repaired those would be
 * changing what a project plays.
 */

import { DN1_LAYOUT, DN2_LAYOUT, type ImageLayout, patternRecord } from "../project/dn2image.js";
import {
  DN1_POOL_OFFSET,
  DN1_SOUND_SIZE,
  DN2_POOL_OFFSET,
  DN2_SOUND_SIZE,
  POOL_SOUND_COUNT,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
} from "../project/soundmap.js";
import { SOUND_MACHINE_OFFSET, machineName } from "../project/machine.js";
import { soundLockedSlots } from "../project/dn2pattern.js";
import { type Device } from "./device.js";

const latin1 = new TextDecoder("latin1");

export class PoolAuditError extends Error {}

/** Where a family keeps its pool, and how wide a preset is in it. */
interface PoolGeometry {
  layout: ImageLayout;
  offset: number;
  size: number;
}

function geometryFor(device: Device): PoolGeometry {
  return device.kind === "dn2"
    ? { layout: DN2_LAYOUT, offset: DN2_POOL_OFFSET, size: DN2_SOUND_SIZE }
    : { layout: DN1_LAYOUT, offset: DN1_POOL_OFFSET, size: DN1_SOUND_SIZE };
}

/** One preset slot, and what the project does with it. */
export interface PoolSlot {
  /** 0-based, the number a lock carries. */
  index: number;
  name: string;
  /** The machine it runs, or `undefined` for a value no capture has seen. */
  machine: string | undefined;
  /** True when the slot holds a preset at all. */
  occupied: boolean;
  /** Trigs locking this slot, across the patterns in scope. */
  lockCount: number;
  /** Patterns containing at least one lock to it, ascending. */
  patterns: number[];
}

export interface PoolAudit {
  slots: PoolSlot[];
  /** Occupied slots that nothing locks — the pool's dead weight. */
  unused: number[];
  /**
   * Locks pointing at a slot that holds no preset.
   *
   * **Ordinary, not a fault.** A trig referencing an empty slot plays whatever the device decides
   * to; it is somebody's old untidiness and reporting it is the whole point.
   */
  danglingLocks: { slot: number; patterns: number[] }[];
  /**
   * Locks pointing outside the 128-slot pool entirely.
   *
   * Found in the wild at slot 161. Kept separate from `danglingLocks` because there is not even a
   * slot to describe, and a reader should see that difference.
   */
  outOfRangeLocks: { slot: number; patterns: number[] }[];
  /**
   * Groups of slots holding byte-identical presets, each group ascending.
   *
   * **Compared by bytes, not by name.** A name is a label somebody typed; the bytes are what plays,
   * and after a few merges the same preset arrives twice under names that may or may not match.
   */
  duplicates: number[][];
  /** Slots holding no preset — where an incoming one can go. */
  free: number[];
}

export interface PoolAuditOptions {
  /**
   * Which patterns count as "in use". Defaults to every pattern in the project.
   *
   * Scope changes the answer, and that is the point: a preset used only by pattern 99 is unused
   * for somebody working on bank A, and a tool that could not say so would be answering a question
   * nobody asked.
   */
  patterns?: readonly number[];
}

/**
 * Audit one project's preset pool.
 *
 * Locks are counted by walking each pattern's lock table rather than by reusing the expander's
 * `collectSoundUsage`: that one groups by *(slot, source tracks)* for planning, which is the right
 * shape for allocation and the wrong shape for "what is in slot 12". Same bytes, different
 * question.
 */
export function auditPool(
  image: Uint8Array,
  device: Device,
  options: PoolAuditOptions = {},
): PoolAudit {
  // **Digitone II only, for now, and it refuses rather than guessing.** The DN1's preset locks are
  // read by `expand/usage.ts`, which walks a DN1 pattern with a different reader and groups its
  // results by `(slot, source tracks)` for planning. Pointing this at a DN1 image would walk DN2
  // offsets over DN1 bytes and report confident nonsense — the one outcome an audit must not have.
  if (device.kind !== "dn2") {
    throw new PoolAuditError(
      `the pool audit reads Digitone II patterns, and this is a ${device.name}. The DN1's preset ` +
        `locks are read by expand/usage.ts; bringing the two together is the next step, not a cast.`,
    );
  }
  const { layout, offset, size } = geometryFor(device);
  const patterns = options.patterns ?? [...Array(layout.patternCount).keys()];

  const locksBySlot = new Map<number, Set<number>>();
  const counts = new Map<number, number>();
  for (const pattern of patterns) {
    for (const slot of soundLockedSlots(patternRecord(image, pattern, layout))) {
      if (!locksBySlot.has(slot)) locksBySlot.set(slot, new Set());
      locksBySlot.get(slot)!.add(pattern);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
  }

  const base = layout.tailBase + offset;
  const slots: PoolSlot[] = [];
  const free: number[] = [];
  const unused: number[] = [];
  const bytesBySlot = new Map<number, string>();

  for (let index = 0; index < POOL_SOUND_COUNT; index++) {
    const at = base + index * size;
    const preset = image.subarray(at, at + size);
    const name = readName(preset);
    const occupied = !isEmpty(preset);
    const lockCount = counts.get(index) ?? 0;

    slots.push({
      index,
      name,
      machine: occupied ? machineName(preset[SOUND_MACHINE_OFFSET]!) : undefined,
      occupied,
      lockCount,
      patterns: [...(locksBySlot.get(index) ?? [])].sort((a, b) => a - b),
    });

    if (!occupied) free.push(index);
    else {
      if (lockCount === 0) unused.push(index);
      // Hex rather than a hash: the pool is 128 entries, so exactness costs nothing and a collision
      // would be a duplicate reported that is not one.
      bytesBySlot.set(index, Array.from(preset, (b) => b.toString(16).padStart(2, "0")).join(""));
    }
  }

  const byBytes = new Map<string, number[]>();
  for (const [index, hex] of bytesBySlot) {
    if (!byBytes.has(hex)) byBytes.set(hex, []);
    byBytes.get(hex)!.push(index);
  }

  const danglingLocks: PoolAudit["danglingLocks"] = [];
  const outOfRangeLocks: PoolAudit["outOfRangeLocks"] = [];
  for (const [slot, inPatterns] of [...locksBySlot].sort((a, b) => a[0] - b[0])) {
    const where = [...inPatterns].sort((a, b) => a - b);
    if (slot < 0 || slot >= POOL_SOUND_COUNT) outOfRangeLocks.push({ slot, patterns: where });
    else if (!slots[slot]!.occupied) danglingLocks.push({ slot, patterns: where });
  }

  return {
    slots,
    unused,
    danglingLocks,
    outOfRangeLocks,
    duplicates: [...byBytes.values()].filter((g) => g.length > 1).sort((a, b) => a[0]! - b[0]!),
    free,
  };
}

/** One line per finding, for a CLI or a panel. Empty when the pool is tidy. */
export function describePoolAudit(audit: PoolAudit): string[] {
  const lines: string[] = [];
  const occupied = audit.slots.filter((s) => s.occupied).length;
  lines.push(`${occupied} of ${POOL_SOUND_COUNT} slots hold a preset, ${audit.free.length} free`);

  if (audit.unused.length > 0) {
    lines.push(`${audit.unused.length} preset(s) nothing locks: ${list(audit.unused)}`);
  }
  for (const { slot, patterns } of audit.danglingLocks) {
    lines.push(`slot ${slot} is locked by ${patterns.length} pattern(s) and holds no preset`);
  }
  for (const { slot, patterns } of audit.outOfRangeLocks) {
    lines.push(`slot ${slot} is outside the pool entirely, locked by ${patterns.length} pattern(s)`);
  }
  for (const group of audit.duplicates) {
    lines.push(`slots ${list(group)} hold byte-identical presets`);
  }
  return lines;
}

function list(values: readonly number[]): string {
  return values.length > 8 ? `${values.slice(0, 8).join(", ")} and ${values.length - 8} more` : values.join(", ");
}

function readName(preset: Uint8Array): string {
  const raw = preset.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul)).trim();
}

/**
 * Whether a slot holds a preset, judged the way `merge.ts` already judges it.
 *
 * **Not "every byte is zero".** That was the first attempt and it reported 128 of 128 slots full on
 * every project in the corpus, because an unused slot is not zeroed — it carries whatever the
 * device left there. The name field is the discriminator, and `0xFF` counts as blank alongside
 * `0x00` for the same reason.
 */
function isEmpty(preset: Uint8Array): boolean {
  const name = preset.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  return name.every((b) => b === 0 || b === 0xff);
}
