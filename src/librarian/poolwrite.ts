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
 * ## The bytes need no conversion — **within a family**
 *
 * A stored preset is the object wrapped in the ordinary container — 31-byte header, body, 12-byte
 * trailer — and the body is byte-for-byte what sits in a pool slot *of the same family*. The
 * captured preset that established this reads its name at `SOUND_NAME_OFFSET` and its machine at
 * `SOUND_MACHINE_OFFSET` using the project's own constants — but **both of those offsets are the
 * same on the DN1 and the DN2**, so that check could not tell the two apart, and the preset it ran
 * on turned out to be a Digitone 1 one: container kind 9, format `"0097"`, a 302-byte body.
 *
 * A Digitone 1's preset library is a perfectly ordinary place to want a sound from, and a DN1
 * preset is exactly a DN1 pool slot, which `convertDn1SoundToDn2` already turns into a DN2 one —
 * the same conversion the whole expander rests on. So a 302-byte body bound for a DN2 pool is
 * converted here rather than refused. The captured preset converts with zero warnings.
 *
 * The other direction has no answer and is refused: nothing converts a DN2 sound back to a DN1.
 *
 * > **What a Digitone II's own `/soundbanks` holds is still unmeasured.** Every preset listing this
 * > project has taken came off a Digitone 1. If a DN2 preset is 359 bytes it lands with no
 * > conversion; if it is 302 it converts. Both work — but the fact is assumed, not known, and
 * > `docs/device-storage.md` says so in the same terms.
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
import { convertDn1SoundToDn2Detailed } from "../project/soundmap.js";
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
  /**
   * Set when the preset came from the other family and had to be converted on the way in.
   *
   * Surfaced rather than done quietly: a converted preset is a very good likeness and not the
   * same object, and the person dropping it should know which one they got.
   */
  converted?: { from: "Digitone 1"; warnings: string[] };
  /** What is there now, when anything is. */
  replaces?: { name: string; lockCount: number };
  /** Free slots left afterwards, so a caller can say how much room remains. */
  freeAfter: number;
}

/** A preset as the destination pool needs it, plus what it cost to get there. */
interface FittedPreset {
  sound: Uint8Array;
  converted?: { from: "Digitone 1"; warnings: string[] };
}

/**
 * Make a preset fit the destination pool, or explain why it cannot.
 *
 * The size check comes first because everything after it would write somewhere wrong: a body of
 * an unexpected length is either a foreign family or a file that was never unwrapped, and both
 * would corrupt the slots either side.
 */
function fitToPool(preset: Uint8Array, device: Device): FittedPreset {
  const { size } = geometryFor(device);
  if (preset.length === size) return { sound: preset };

  // A Digitone 1 preset into a Digitone II pool: exactly the conversion the expander does, on
  // exactly the same bytes — a DN1 stored preset *is* a DN1 pool slot.
  if (device.kind === "dn2" && preset.length === DN1_SOUND_SIZE) {
    const { sound, warnings } = convertDn1SoundToDn2Detailed(preset);
    return {
      sound,
      converted: { from: "Digitone 1", warnings: warnings.map((w) => w.detail) },
    };
  }

  // The other direction has no answer. Refused with the reason rather than the arithmetic,
  // because "359 is not 302" tells a person nothing they can act on.
  if (device.kind === "dn1" && preset.length === DN2_SOUND_SIZE) {
    throw new PoolWriteError(
      `that is a Digitone II preset and this is a Digitone 1 project. Nothing converts a DN2 ` +
        `sound back to a DN1 — the DN2 has machines and parameters the DN1 has no field for.`,
    );
  }

  throw new PoolWriteError(
    `this preset is ${preset.length} bytes, and neither family's pool slot is that size ` +
      `(${DN1_SOUND_SIZE} on a Digitone 1, ${DN2_SOUND_SIZE} on a Digitone II). A stored file ` +
      `carries 43 bytes of container around the body — pass the body, not the file.`,
  );
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
  const { sound, converted } = fitToPool(preset, device);

  // The manual, flatly: "MIDI presets can not be added to the preset pool." Refused rather than
  // written, because the device would hold something it will not use and nothing would say why.
  // Asked of the *fitted* sound: the machine byte is what the pool will hold, not what arrived.
  const machine = sound[SOUND_MACHINE_OFFSET]!;
  if (machine === MACHINE.midi) {
    throw new PoolWriteError(
      `${readName(sound) || "this preset"} is a MIDI preset, and the pool does not take them — ` +
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
    name: readName(sound),
    machine: machineName(machine),
    ...(converted ? { converted } : {}),
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
  // Fitted again rather than carried on the plan. The plan is a *description* — the thing a person
  // is shown before saying yes — and putting 359 bytes of payload on it would make it two things.
  // `fitToPool` is deterministic, and it has already refused anything it cannot fit.
  const { sound } = fitToPool(preset, device);

  const out = Uint8Array.from(image);
  out.set(sound, layout.tailBase + offset + plan.slot * size);
  return { image: out, plan };
}

/** One sentence describing what a plan would do. */
export function describeAddPreset(plan: AddPresetPlan): string {
  const what = `${plan.name || "an unnamed preset"}${plan.machine ? ` (${plan.machine})` : ""}`;
  const where = plan.replaces
    ? `slot ${plan.slot}, replacing ${plan.replaces.name || "an unnamed preset"}` +
      (plan.replaces.lockCount > 0 ? ` and changing what ${plan.replaces.lockCount} trig(s) play` : "")
    : `free slot ${plan.slot}`;
  // The conversion is said first. It is the one part of this sentence that changes what the person
  // ends up with, rather than only where it goes.
  const from = plan.converted
    ? `Converted from a ${plan.converted.from} preset` +
      (plan.converted.warnings.length > 0
        ? ` with ${plan.converted.warnings.length} field(s) the mapping is unsure of. `
        : `, cleanly. `)
    : "";
  return `${from}${what} → ${where}. ${plan.freeAfter} slot(s) free afterwards.`;
}

function readName(preset: Uint8Array): string {
  const raw = preset.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  const nul = raw.indexOf(0);
  return new TextDecoder("latin1").decode(nul === -1 ? raw : raw.subarray(0, nul)).trim();
}
