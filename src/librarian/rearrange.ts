/**
 * Rearranging patterns inside one project.
 *
 * This is the manager's spine, and every later feature is the same three beats:
 * **resolve dependencies, preview, write and verify.** Doing it first means sounds, kits
 * and song rows become variations on a proven mechanism rather than three separate
 * implementations that each rediscover the hard parts.
 *
 * ## Why intra-project is the easy case, and what replaces the difficulty
 *
 * Copying a pattern *between* projects is dominated by dependency resolution: sound locks
 * address the 128-slot pool by index, and those indices mean nothing in another project, so
 * every locked sound has to travel and every lock byte be rewritten. `librarian/copy.ts`
 * does that for the DN1.
 *
 * Inside one project none of it applies. **The pool is shared, so every sound-lock index
 * stays valid** and nothing needs remapping. What is left is smaller but not nothing:
 *
 * 1. **The record knows its own slot.** Both families store the slot index a pattern
 *    believes it occupies — DN1 at `PATTERN.slotIndexOffset`, DN2 at meta+0x1C. Move the
 *    bytes without rewriting it and the device meets a pattern that disagrees about where
 *    it lives.
 * 2. **The kit travels with the pattern.** One kit per pattern at the same index, so a move
 *    is of the *patternKit* — the unit elk-herd uses, and the same pairing that makes
 *    `patternRecord ++ kitRecord` a SysEx pattern payload.
 * 3. **Songs reference patterns by slot.** See `SongState`; the DN2's table has never been
 *    located, so it reports `unknown` and rearranging is a warning rather than a clean bill.
 *
 * ## Swap is the primitive, and that is a deliberate limit
 *
 * A true move leaves a hole, and filling a hole means writing an **empty pattern** — bytes
 * we would have to invent, which is the one thing this project never does. elk-herd solves
 * it by embedding a compressed blank patternKit per storage version; until we have an
 * equivalent source, a shuffle that empties a slot is refused with that reason.
 *
 * This costs less than it sounds. Moving a pattern to an empty slot *is* a swap, so the
 * common rearrangement works today and is lossless in both directions.
 */

import { kitRecord, patternRecord } from "../project/dn2image.js";
import { checkDn2PatternRecord } from "../project/dn2pattern.js";
import { type Device, type DeviceKind, type SongState, deviceFor } from "./device.js";
import {
  type Shuffle,
  assertWithin,
  sourceOf,
  touchedSlots,
} from "./shuffle.js";

export class RearrangeError extends Error {}

/**
 * A blocker stops the operation; a warning is shown and the operation proceeds.
 *
 * Borrowed from elk-herd's `TestPass | TestWarn | TestFail`, which is a better shape than a
 * boolean because most of what a manager needs to say is neither "fine" nor "impossible".
 */
export type Severity = "blocker" | "warning";

export interface Finding {
  severity: Severity;
  message: string;
}

export interface SlotChange {
  from: number;
  to: number;
  sourceName?: string;
  destinationName?: string;
  /** True when real work is about to be overwritten. */
  destinationOccupied: boolean;
  destinationTrigCount?: number;
}

export interface RearrangePlan {
  device: DeviceKind;
  deviceName: string;
  changes: SlotChange[];
  /** Slots the shuffle would leave empty. Always a blocker — see the module note. */
  emptied: number[];
  songState: SongState;
  findings: Finding[];
  /** True when nothing blocks the write. Warnings do not clear this flag. */
  ok: boolean;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

function blockers(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "blocker");
}

/**
 * Work out what a shuffle would do, without touching the image.
 *
 * Pure and cheap enough to run on every hover: it summarises only the slots the shuffle
 * touches, not all 128, because a DN2 pattern summary walks 8,192 trig slots.
 */
export function planRearrange(image: Uint8Array, shuffle: Shuffle): RearrangePlan {
  const device = deviceFor(image);
  assertWithin(shuffle, device.patternCount);

  const findings: Finding[] = [];
  const changes: SlotChange[] = [];
  const emptied: number[] = [];

  for (const to of touchedSlots(shuffle)) {
    const from = sourceOf(shuffle, to);
    if (from === undefined) {
      emptied.push(to);
      continue;
    }
    if (from === to) continue;

    const source = device.summarise(image, from);
    const destination = device.summarise(image, to);

    if (!source.supported) {
      findings.push({
        severity: "blocker",
        message:
          `Pattern ${from} is storage version ${source.version}, and we read and write ` +
          `version ${device.patternVersion} on the ${device.name}. Moving it would mean ` +
          `guessing at offsets that change between versions.`,
      });
    }
    if (!destination.supported) {
      findings.push({
        severity: "blocker",
        message:
          `Pattern ${to} is storage version ${destination.version}, not ` +
          `${device.patternVersion}. Refusing to overwrite a record we cannot read.`,
      });
    }

    changes.push({
      from,
      to,
      ...(source.name === undefined ? {} : { sourceName: source.name }),
      ...(destination.name === undefined ? {} : { destinationName: destination.name }),
      destinationOccupied: destination.occupied ?? false,
      ...(destination.trigCount === undefined
        ? {}
        : { destinationTrigCount: destination.trigCount }),
    });
  }

  if (emptied.length > 0) {
    findings.push({
      severity: "blocker",
      message:
        `This would leave ${emptied.length} slot(s) empty (${emptied.join(", ")}), and we ` +
        `have no blank pattern to write there. Swap two slots instead — moving a pattern ` +
        `onto an empty slot is a swap, and it loses nothing.`,
    });
  }

  const songState = device.songState(image);
  if (songState === "occupied") {
    findings.push({
      severity: "warning",
      message:
        `This project has at least one song, and songs reference patterns by slot. ` +
        `Rearranging patterns may desync them.`,
    });
  } else if (songState === "unknown") {
    findings.push({
      severity: "warning",
      message:
        `We cannot check this project for songs: the ${device.name}'s song table has ` +
        `never been located. If you use song mode, verify your songs after loading.`,
    });
  }

  return {
    device: device.kind,
    deviceName: device.name,
    changes,
    emptied,
    songState,
    findings,
    ok: blockers(findings).length === 0,
  };
}

function writeSlotIndex(record: Uint8Array, device: Device, slot: number): void {
  record[device.slotIndexOffset] = slot;
}

/**
 * Apply a shuffle, returning a new image. The input is not modified.
 *
 * Refuses when the plan reports a blocker. There is no `force`: every blocker here is a
 * case where proceeding would write bytes we cannot stand behind — a record at a version we
 * do not parse, or a hole we would have to invent an empty pattern to fill. A warning is
 * the mechanism for "risky but the user's call".
 */
export function applyRearrange(
  image: Uint8Array,
  shuffle: Shuffle,
): { image: Uint8Array; plan: RearrangePlan; verification: VerifyResult } {
  const plan = planRearrange(image, shuffle);
  if (!plan.ok) {
    throw new RearrangeError(
      `Cannot rearrange:\n${blockers(plan.findings)
        .map((f) => `  - ${f.message}`)
        .join("\n")}`,
    );
  }

  const device = deviceFor(image);
  const out = Uint8Array.from(image);

  // Read every source from the ORIGINAL image and write into the copy, so overlapping
  // moves — a swap is two of them — cannot read a byte that has already been overwritten.
  for (const to of touchedSlots(shuffle)) {
    const from = sourceOf(shuffle, to);
    if (from === undefined || from === to) continue;

    const sourcePattern = patternRecord(image, from, device.layout);
    const sourceKit = kitRecord(image, from, device.layout);

    const patternAt = device.layout.headerSize + to * device.layout.patternSize;
    const kitAt = device.layout.kitBase + to * device.layout.kitSize;

    out.set(sourcePattern, patternAt);
    out.set(sourceKit, kitAt);

    // The record carries the slot it believes it occupies, so it has to be told it moved.
    writeSlotIndex(out.subarray(patternAt, patternAt + device.layout.patternSize), device, to);
  }

  return { image: out, plan, verification: verifyRearrange(out, shuffle) };
}

/**
 * Re-read what was just written and check it, before anyone is offered the file.
 *
 * Cheap, and the difference between a tool you trust with your music and one you do not.
 * It checks the two things a rearrangement can get wrong — a record whose version was
 * mangled by a bad offset, and a slot-index field that disagrees with where the record now
 * lives — plus the DN2's full record check where one exists.
 */
export function verifyRearrange(image: Uint8Array, shuffle: Shuffle): VerifyResult {
  const device = deviceFor(image);
  const problems: string[] = [];

  for (const to of touchedSlots(shuffle)) {
    if (sourceOf(shuffle, to) === undefined) continue;

    const summary = device.summarise(image, to);
    if (!summary.supported) {
      problems.push(
        `pattern ${to} reads as version ${summary.version} after the write, expected ` +
          `${device.patternVersion}`,
      );
      continue;
    }

    const record = patternRecord(image, to, device.layout);
    const storedSlot = record[device.slotIndexOffset];
    if (storedSlot !== to) {
      problems.push(`pattern ${to} still believes it occupies slot ${storedSlot}`);
    }

    if (device.kind === "dn2") {
      const check = checkDn2PatternRecord(record);
      if (!check.ok) problems.push(`pattern ${to}: ${check.problems.join("; ")}`);
    }
  }

  if (image.length !== device.layout.imageSize) {
    problems.push(`image is ${image.length} bytes, expected ${device.layout.imageSize}`);
  }

  return { ok: problems.length === 0, problems };
}
