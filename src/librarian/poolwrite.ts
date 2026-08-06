/**
 * Putting a preset into a project's pool.
 *
 * ## Why this is the operation worth building first
 *
 * The manual gives the reason the pool exists: *"The primary benefit of presets loaded to the pool
 * is the possibility for them to be preset locked. This feature is not available for the presets in
 * the +Drive library."* So a preset in the library can be a track's sound, and a preset in the pool
 * can be **any trig's** sound. Moving one across is the whole of `ADD TO PRESET POOL` on the device,
 * and the reason the library browser has two grids.
 *
 * ## The bytes need no conversion
 *
 * A stored preset is the object wrapped in the ordinary container — 31-byte header, body, 12-byte
 * trailer — and **the body is byte-for-byte what sits in a pool slot**. Verified on a captured
 * preset: its name reads at `SOUND_NAME_OFFSET` and its machine at `SOUND_MACHINE_OFFSET`, using the
 * project's own constants. So this module takes a body and places it; the unwrapping belongs to
 * whoever read the file.
 *
 * ## Plan, then apply
 *
 * Same split as `rearrange.ts` and `trackmove.ts`, for the same reason: every refusal here is
 * something a person should see *before* anything changes, and several of them are about work that
 * would be silently lost.
 */

import { DN1_LAYOUT, DN2_LAYOUT, type ImageLayout } from "../project/dn2image.js";
import {
  DN1_POOL_OFFSET,
  DN1_SOUND_SIZE,
  DN2_POOL_OFFSET,
  DN2_SOUND_SIZE,
  POOL_SOUND_COUNT,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
} from "../project/soundmap.js";
import { MACHINE, SOUND_MACHINE_OFFSET, machineName } from "../project/machine.js";
import { type Device } from "./device.js";
import { auditPool } from "./poolaudit.js";

export class PoolWriteError extends Error {}

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

export interface AddPresetOptions {
  /** Where to put it. Defaults to the first free slot. */
  slot?: number;
  /**
   * Overwrite a slot that already holds a preset.
   *
   * Off by default, and the refusal names what would be lost — including how many trigs lock to it,
   * because a pool slot with locks is not merely occupied, it is *in use*, and replacing it changes
   * what those trigs play.
   */
  confirmOverwrite?: boolean;
}

export interface AddPresetPlan {
  /** The slot it will occupy. */
  slot: number;
  name: string;
  machine: string | undefined;
  /** What is there now, when anything is. */
  replaces?: { name: string; lockCount: number };
  /** Free slots left afterwards, so a caller can say how much room remains. */
  freeAfter: number;
}

/**
 * Decide where a preset goes and whether it may.
 *
 * Nothing is written. Every refusal is a `PoolWriteError` naming the thing a person would need to
 * decide about.
 */
export function planAddPreset(
  image: Uint8Array,
  device: Device,
  preset: Uint8Array,
  options: AddPresetOptions = {},
): AddPresetPlan {
  const { size } = geometryFor(device);

  // **Size is the first check, because everything after it would write somewhere wrong.** A stored
  // preset's body is exactly a pool slot; a body of any other length is either the wrong family or
  // a file that was not unwrapped, and both would corrupt the slots either side.
  if (preset.length !== size) {
    throw new PoolWriteError(
      `this preset is ${preset.length} bytes and a ${device.name} pool slot is ${size}. A stored ` +
        `file carries 43 bytes of container around the body — pass the body, not the file.`,
    );
  }

  // The manual, flatly: "MIDI presets can not be added to the preset pool." Refused rather than
  // written, because the device would hold something it will not use and nothing would say why.
  const machine = preset[SOUND_MACHINE_OFFSET]!;
  if (machine === MACHINE.midi) {
    throw new PoolWriteError(
      `${readName(preset) || "this preset"} is a MIDI preset, and the pool does not take them — ` +
        `the manual is explicit, and a preset lock cannot reach one.`,
    );
  }

  const audit = auditPool(image, device);
  const slot = options.slot ?? audit.free[0];
  if (slot === undefined) {
    throw new PoolWriteError(
      `the pool is full: all ${POOL_SOUND_COUNT} slots hold a preset. ` +
        (audit.unused.length > 0
          ? `${audit.unused.length} of them are locked by nothing — slot ${audit.unused[0]} first.`
          : `Every one of them is locked by at least one trig.`),
    );
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= POOL_SOUND_COUNT) {
    throw new PoolWriteError(`${slot} is not a pool slot; the pool is 0..${POOL_SOUND_COUNT - 1}`);
  }

  const existing = audit.slots[slot]!;
  if (existing.occupied && !options.confirmOverwrite) {
    throw new PoolWriteError(
      `slot ${slot} already holds ${existing.name || "an unnamed preset"}` +
        (existing.lockCount > 0
          ? `, locked by ${existing.lockCount} trig(s) in pattern(s) ${existing.patterns.join(", ")}. ` +
            `Replacing it changes what those trigs play.`
          : `, which nothing locks.`) +
        ` Pass confirmOverwrite to replace it, or choose a free slot.`,
    );
  }

  return {
    slot,
    name: readName(preset),
    machine: machineName(machine),
    ...(existing.occupied
      ? { replaces: { name: existing.name, lockCount: existing.lockCount } }
      : {}),
    freeAfter: audit.free.filter((f) => f !== slot).length,
  };
}

/**
 * Write the preset in, returning a new image.
 *
 * **Plans again rather than trusting a plan handed to it.** A caller may have planned against an
 * image it has since changed, and re-planning costs a pool read — cheap against the cost of writing
 * over a preset somebody is using.
 */
export function applyAddPreset(
  image: Uint8Array,
  device: Device,
  preset: Uint8Array,
  options: AddPresetOptions = {},
): { image: Uint8Array; plan: AddPresetPlan } {
  const plan = planAddPreset(image, device, preset, options);
  const { layout, offset, size } = geometryFor(device);

  const out = Uint8Array.from(image);
  out.set(preset, layout.tailBase + offset + plan.slot * size);
  return { image: out, plan };
}

/** One sentence describing what a plan would do. */
export function describeAddPreset(plan: AddPresetPlan): string {
  const what = `${plan.name || "an unnamed preset"}${plan.machine ? ` (${plan.machine})` : ""}`;
  const where = plan.replaces
    ? `slot ${plan.slot}, replacing ${plan.replaces.name || "an unnamed preset"}` +
      (plan.replaces.lockCount > 0 ? ` and changing what ${plan.replaces.lockCount} trig(s) play` : "")
    : `free slot ${plan.slot}`;
  return `${what} → ${where}. ${plan.freeAfter} slot(s) free afterwards.`;
}

function readName(preset: Uint8Array): string {
  const raw = preset.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  const nul = raw.indexOf(0);
  return new TextDecoder("latin1").decode(nul === -1 ? raw : raw.subarray(0, nul)).trim();
}
