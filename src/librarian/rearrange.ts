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
 * ## Vacating a slot needs a blank, and the blank is captured
 *
 * A move leaves a hole and a delete is nothing but a hole, so both need an empty patternKit
 * to write. Those bytes are **captured from a device-initialised project** rather than
 * synthesised — see `blank.ts` — because a patternKit contains regions whose meaning we have
 * never established, and filling them with zeros would be inventing device state.
 */

import { kitRecord, patternRecord } from "../project/dn2image.js";
import { checkDn2PatternRecord } from "../project/dn2pattern.js";
import { blankFits, blankPatternKit, blankSource } from "./blank.js";
import { type Device, type DeviceKind, type SongState, deviceFor } from "./device.js";
import { type Shuffle, outOfRange, sourceOf, touchedSlots } from "./shuffle.js";

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

/** Work that an operation would destroy, and what is replacing it. */
export interface Collision {
  slot: number;
  name?: string;
  trigCount: number;
  /** The slot whose contents land here, or `undefined` when the slot is being emptied. */
  replacedBy?: number;
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
  /**
   * Every slot whose existing work would be destroyed — landed on, or emptied.
   *
   * The list a confirmation prompt should show. `applyRearrange` refuses while this is
   * non-empty unless the caller explicitly acknowledges it.
   */
  destructive: Collision[];
  /** Slots that will be filled with a captured blank patternKit. */
  emptied: number[];
  /** Provenance of that blank, so a preview can say where the bytes came from. */
  blankSource: string;
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

  const findings: Finding[] = [];
  const changes: SlotChange[] = [];
  const destructive: Collision[] = [];
  const emptied: number[] = [];

  // A batch that runs off the end of the bank is a mistake to explain, not to crash on.
  const stray = outOfRange(shuffle, device.patternCount);
  if (stray.length > 0) {
    return {
      device: device.kind,
      deviceName: device.name,
      changes,
      destructive: [],
      emptied,
      blankSource: blankSource(device),
      songState: device.songState(image),
      findings: [
        {
          severity: "blocker",
          message:
            `Slot(s) ${stray.join(", ")} are outside this ${device.name}'s ` +
            `0..${device.patternCount - 1}. A batch landing at consecutive slots needs room ` +
            `for all of them.`,
        },
      ],
      ok: false,
    };
  }

  for (const to of touchedSlots(shuffle)) {
    const from = sourceOf(shuffle, to);
    if (from === undefined) {
      const destination = device.summarise(image, to);
      emptied.push(to);
      if (destination.occupied) {
        destructive.push({
          slot: to,
          ...(destination.name === undefined ? {} : { name: destination.name }),
          trigCount: destination.trigCount ?? 0,
        });
      }
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

    if (destination.occupied) {
      destructive.push({
        slot: to,
        ...(destination.name === undefined ? {} : { name: destination.name }),
        trigCount: destination.trigCount ?? 0,
        replacedBy: from,
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

  // A blank whose record sizes disagree with the layout would corrupt the image. This can
  // only happen if the captured data and the layout constants drift apart, which is a bug
  // rather than anything a user did — but it is cheap to refuse rather than discover later.
  if (emptied.length > 0 && !blankFits(device)) {
    findings.push({
      severity: "blocker",
      message:
        `The captured blank patternKit does not match the ${device.name}'s record sizes. ` +
        `Regenerate it with \`npm run extract-blank\`.`,
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
    // Unreachable for both families since the DN2's song table was located, and kept because the
    // tri-state is the honest shape: a device whose songs we cannot find must not read as "empty".
    findings.push({
      severity: "warning",
      message:
        `We cannot check this project for songs: this build cannot locate the ${device.name}'s ` +
        `song table. If you use song mode, verify your songs after loading.`,
    });
  }

  if (destructive.length > 0) {
    const total = destructive.reduce((n, c) => n + c.trigCount, 0);
    findings.push({
      severity: "warning",
      message:
        `${destructive.length} slot(s) holding ${total} trigs will be destroyed. ` +
        `This needs confirmation.`,
    });
  }

  return {
    device: device.kind,
    deviceName: device.name,
    changes,
    destructive,
    emptied,
    blankSource: blankSource(device),
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
 * Refuses on a blocker, always: those are cases where proceeding would write bytes we cannot
 * stand behind, such as a record at a version we do not parse.
 *
 * **Also refuses to destroy work without being told to.** Any landing on an occupied slot,
 * or the emptying of one, is destructive and needs `confirmOverwrite`. There is no way to
 * pass it accidentally, which is the point: for most people the +Drive is the only copy of
 * that work. `plan.destructive` is exactly what a confirmation prompt should list.
 */
export function applyRearrange(
  image: Uint8Array,
  shuffle: Shuffle,
  options: { confirmOverwrite?: boolean } = {},
): { image: Uint8Array; plan: RearrangePlan; verification: VerifyResult } {
  const plan = planRearrange(image, shuffle);
  if (!plan.ok) {
    throw new RearrangeError(
      `Cannot rearrange:\n${blockers(plan.findings)
        .map((f) => `  - ${f.message}`)
        .join("\n")}`,
    );
  }
  if (plan.destructive.length > 0 && options.confirmOverwrite !== true) {
    const lines = plan.destructive.map(
      (c) =>
        `  - slot ${c.slot} "${c.name ?? "?"}" (${c.trigCount} trigs)` +
        (c.replacedBy === undefined ? " would be emptied" : ` would be replaced by slot ${c.replacedBy}`),
    );
    const one = plan.destructive.length === 1;
    throw new RearrangeError(
      `This would destroy work in ${plan.destructive.length} slot${one ? "" : "s"}:\n` +
        `${lines.join("\n")}\nNothing was changed.`,
    );
  }

  const device = deviceFor(image);
  const out = Uint8Array.from(image);

  // Read every source from the ORIGINAL image and write into the copy, so overlapping
  // moves — a swap is two of them — cannot read a byte that has already been overwritten.
  for (const to of touchedSlots(shuffle)) {
    const from = sourceOf(shuffle, to);
    if (from === to) continue;

    const patternAt = device.layout.headerSize + to * device.layout.patternSize;
    const kitAt = device.layout.kitBase + to * device.layout.kitSize;

    // A vacated slot gets the captured blank, already stamped with its new slot index.
    const { pattern, kit } =
      from === undefined
        ? blankPatternKit(device, to)
        : {
            pattern: patternRecord(image, from, device.layout),
            kit: kitRecord(image, from, device.layout),
          };

    out.set(pattern, patternAt);
    out.set(kit, kitAt);

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
    const summary = device.summarise(image, to);

    // A slot that was vacated must read back as a genuinely empty pattern. Checking this
    // catches a blank written at the wrong offset, which would otherwise look like success.
    if (sourceOf(shuffle, to) === undefined && summary.supported && summary.occupied) {
      problems.push(`slot ${to} was cleared but still reports ${summary.trigCount} trigs`);
    }

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
