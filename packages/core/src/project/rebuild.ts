/**
 * Turn a capture back into a project image.
 *
 * A `.syx` read off a device — by request or from the front panel — carries most of a project.
 * This puts those records where they belong in an image, and says plainly what it could not
 * supply. The output is an image; writing the file is `projectfile.ts`'s job and the CLI's.
 *
 * ## A capture is 99.5% of a project, and the other 0.5% matters
 *
 * Measured, not estimated. On a Digitone II, 12,889,604 bytes of image against 12,825,984 bytes
 * the wire carries:
 *
 * | Region | Bytes | On the wire |
 * |---|---|---|
 * | Image header | 512 | **no** — project name and the identity token at `0x18` |
 * | 128 patterns + 128 kits | 12,779,520 | yes, as `0x50` |
 * | Tail `+0`…`+10,756` | 10,756 | **no** — opens with a complete kit record |
 * | Sound pool | 45,952 | yes, as `0x53` |
 * | Tail `+56,708`…`+56,832` | 124 | **no** |
 * | ProjectSettings | 512 | yes, as `0x54` |
 * | Tail after settings | 52,228 | **no** — the song table and the slot array live here |
 *
 * **63,620 bytes, 0.49%, come from a donor project.** That is not a defect to be engineered away:
 * the device does not send those bytes, so there is nowhere else to get them. What matters is
 * that a caller is told, because "I backed up my project" and "I backed up my project except its
 * songs" are different sentences and only one of them is true.
 *
 * The same holds on a Digitone 1, where the shape is different and the omission is starker: a DN1
 * project dump carries **no sound pool at all**, so a rebuild from a front-panel dump has an empty
 * pool unless the pool was fetched separately. Requesting `0x63` slot by slot does fetch it —
 * which is the reason `device/readplan.ts` asks per object.
 *
 * ## Where the settings record goes — established 2026-07-29
 *
 * Both placements were found by searching real images for the captured payload, and both are
 * unambiguous:
 *
 * - **Digitone II**: `tailBase + 56,832`, 512 bytes. 510 of 512 bytes matched a corpus project,
 *   and the two that differed are the saved-cursor fields — `+9` and `+11`, the latter exactly
 *   the `SAVED_PATTERN_OFFSET` of `position.ts`. So §5b's loose bytes are **fields of this
 *   record**, not free-floating tail offsets.
 * - **Digitone 1**: `tailBase + 38,912`, 11,776 bytes — the same offset in **all 23** corpus
 *   projects at 99.5–99.9% agreement. And the arithmetic closes exactly: that offset is
 *   `tailRegionBase + TAIL.settingsOffset` (`0xFC`), and `0xFC + 11,776 = 0x2EFC` is precisely
 *   `TAIL.songOffset`. **The DN1 settings dump is the post-pool tail from the settings block up
 *   to but not including the song table** — settings, the 1,024 × 11 slot array, the CC map and
 *   the mixer, and no songs.
 *
 * That last point is worth keeping: **a DN1 dump cannot carry a song**, so a rebuild can never
 * restore one, and the standing rule about not rearranging projects whose songs matter applies
 * here with more force rather than less.
 *
 * ## Refusals, and why each one is a refusal rather than a warning
 *
 * - **A bad checksum is never written.** This module exists in its present shape because a
 *   Digitone II sent one pattern with a bad checksum and 6,433 wrong bytes, then returned it
 *   perfectly the next night. Writing that record would have put those bytes in a project file
 *   with nothing to show anything was wrong. A rejected record leaves the donor's bytes in place
 *   and is reported by name.
 * - **A group with more records than slots is refused outright.** Past 128 objects the number
 *   field reports `0` for everything, so a +Drive soundbank of 182 or 256 sounds would place its
 *   first 128 and then overwrite every one of them with the saturated remainder — silently, and
 *   at exactly the size where testing on a project would never catch it.
 *
 *   The refusal costs something worth naming: a project read **plus a second pass over its
 *   failures** also exceeds the slot count, and the two are indistinguishable from the bytes
 *   alone. Rather than pick, this refuses both and says so, and the remedy is to save a repaired
 *   second pass as its own capture. A false refusal that explains itself beats a rebuild that is
 *   plausible and wrong.
 * - **A donor of the wrong family is refused.** Sizes differ by a factor of five; the failure
 *   would otherwise be a silent misplacement rather than an error.
 */

import { type SysExMessage } from "../sysex/container.js";
import { ProductId } from "../sysex/devices.js";
import { patternName } from "./naming.js";
import { type ImageLayout, DN1_LAYOUT, DN2_LAYOUT, PROJECT_ID_OFFSET, mintProjectId, writeProjectId } from "./dn2image.js";
import { RECORD_VERSION as DN1_RECORD_VERSION, RECORD_VERSIONS as DN1_RECORD_VERSIONS } from "./dn1.js";
import { DN1_OS143_IMAGE_SIZE } from "./dn2codec.js";
import { DN1_POOL_OFFSET, DN2_POOL_OFFSET, POOL_SOUND_COUNT } from "./soundmap.js";

/** Where a family keeps the things a dump carries, relative to `layout.tailBase`. */
export interface Placement {
  layout: ImageLayout;
  poolOffset: number;
  soundSize: number;
  /** **[verified]** by locating a captured `0x54` payload in real images. */
  settingsOffset: number;
  settingsSize: number;
}

export const PLACEMENTS: Readonly<Record<number, Placement>> = {
  [ProductId.DN1]: {
    layout: DN1_LAYOUT,
    poolOffset: DN1_POOL_OFFSET,
    soundSize: 302,
    settingsOffset: 38_912,
    settingsSize: 11_776,
  },
  [ProductId.DN2]: {
    layout: DN2_LAYOUT,
    poolOffset: DN2_POOL_OFFSET,
    soundSize: 359,
    settingsOffset: 56_832,
    settingsSize: 512,
  },
};

/** Dump types this understands. Anything else in a capture is reported and ignored. */
export const PATTERN_KIT = 0x50;
export const PATTERN_ONLY = 0x51;
export const KIT_ONLY = 0x52;
export const SOUND = 0x53;
export const SETTINGS = 0x54;

/** One record, ready to be written at a known offset. */
export interface Placed {
  /** Which slot, or 0 for the single settings record. */
  index: number;
  /** `Pattern A1`, `Sound 42`, `Project settings`. */
  label: string;
  /** Absolute offset in the image. */
  at: number;
  bytes: Uint8Array;
}

/** A record the capture offered and the plan would not take. */
export interface Rejected {
  label: string;
  reason: string;
}

export interface RebuildPlan {
  productId: number;
  placement: Placement;
  patterns: Placed[];
  kits: Placed[];
  sounds: Placed[];
  settings: Placed[];
  /**
   * Records refused, with the reason. **Never empty silently**: a rebuild that dropped a corrupt
   * pattern without saying so is the failure this whole module was written to prevent.
   */
  rejected: Rejected[];
  /**
   * Records the capture supplied more than once, later winning.
   *
   * A second pass over failed objects (`device/dumpreader.ts`'s `stepsToRetry`) appends to the
   * same capture, so duplicates are the *expected* shape of a repaired read rather than a fault.
   * Later wins because a step is only re-asked when the earlier answer was unusable.
   */
  superseded: number;
  /** Regions no capture can supply, named so a caller can say what it is really handing over. */
  fromDonor: string[];
  problems: string[];
}

/**
 * Work out where every record in a capture belongs.
 *
 * Pure: reads the messages, writes nothing. `applyRebuild` does the writing, so a caller can show
 * a user what would happen — the same plan/apply/verify shape `rearrange.ts` and `rename.ts` use.
 */
export function planRebuild(
  messages: readonly SysExMessage[],
  options: RebuildOptions = {},
): RebuildPlan {
  const dumps = messages.filter((m) => m.dumpType >= PATTERN_KIT && m.dumpType <= SETTINGS);
  const problems: string[] = [];
  const rejected: Rejected[] = [];

  const productIds = [...new Set(dumps.map((m) => m.productId))];
  if (productIds.length === 0) throw new RebuildError("the capture holds no dump messages");
  if (productIds.length > 1) {
    throw new RebuildError(
      `the capture mixes products ${productIds.join(", ")} — one project per rebuild`,
    );
  }

  const productId = productIds[0]!;
  const placement = PLACEMENTS[productId];
  if (!placement) {
    throw new RebuildError(
      `no placement recorded for product 0x${productId.toString(16)} — a rebuild needs to know ` +
        `where that family keeps its records, and guessing writes bytes into the wrong offsets`,
    );
  }

  const { layout } = placement;
  const foreign = messages.length - dumps.length;
  if (foreign > 0) problems.push(`${foreign} message(s) are not project records and were ignored`);

  // Placed by object number, which the device echoes — verified on a Digitone II, 257 objects,
  // 0..127 in request order. Past 128 the field saturates, so a group that overflows is refused
  // rather than placed by arrival order: under 128 the two agree, and above it only one is right.
  const patterns = new Slots(layout.patternCount);
  const kits = new Slots(layout.patternCount);
  const sounds = new Slots(POOL_SOUND_COUNT);
  const settings = new Slots(1);

  for (const message of dumps) {
    const label = labelFor(message);

    if (message.storedChecksum !== message.computedChecksum) {
      // The reason this module refuses rather than warns. See the module note.
      rejected.push({ label, reason: "bad checksum — corrupt in transit, read it again" });
      continue;
    }

    switch (message.dumpType) {
      case PATTERN_KIT: {
        if (!expect(message, layout.patternSize + layout.kitSize, label, rejected)) break;
        patterns.put(message.objNr, {
          index: message.objNr,
          label: `Pattern ${patternName(message.objNr)}`,
          at: layout.headerSize + message.objNr * layout.patternSize,
          bytes: message.payload.subarray(0, layout.patternSize),
        }, rejected, label);
        kits.put(message.objNr, {
          index: message.objNr,
          label: `Kit ${patternName(message.objNr)}`,
          at: layout.kitBase + message.objNr * layout.kitSize,
          bytes: message.payload.subarray(layout.patternSize),
        }, rejected, label);
        break;
      }
      case PATTERN_ONLY: {
        if (!expect(message, layout.patternSize, label, rejected)) break;
        patterns.put(message.objNr, {
          index: message.objNr,
          label,
          at: layout.headerSize + message.objNr * layout.patternSize,
          bytes: message.payload,
        }, rejected, label);
        break;
      }
      case KIT_ONLY: {
        if (!expect(message, layout.kitSize, label, rejected)) break;
        kits.put(message.objNr, {
          index: message.objNr,
          label,
          at: layout.kitBase + message.objNr * layout.kitSize,
          bytes: message.payload,
        }, rejected, label);
        break;
      }
      case SOUND: {
        if (!expect(message, placement.soundSize, label, rejected)) break;
        // The ambiguity only a caller can settle — see `Dn1Sounds`. Refusing by default is the
        // whole point: the alternative is writing kit track sounds over pool slots 0..3.
        if (productId === ProductId.DN1 && options.dn1Sounds === undefined) {
          rejected.push({
            label,
            reason:
              "a Digitone 1 sends kit track sounds and pool sounds under the same dump type — " +
              "say which these are before they are placed",
          });
          break;
        }
        if (productId === ProductId.DN1 && options.dn1Sounds === "kit") {
          // Nothing to do: the kit's track sounds are already inside the 0x50 record for that
          // pattern, so placing them separately would add nothing and could only do harm.
          rejected.push({ label, reason: "kit track sound — already carried inside its patternKit" });
          break;
        }
        sounds.put(message.objNr, {
          index: message.objNr,
          label,
          at: layout.tailBase + placement.poolOffset + message.objNr * placement.soundSize,
          bytes: message.payload,
        }, rejected, label);
        break;
      }
      case SETTINGS: {
        if (!expect(message, placement.settingsSize, label, rejected)) break;
        settings.put(0, {
          index: 0,
          label,
          at: layout.tailBase + placement.settingsOffset,
          bytes: message.payload,
        }, rejected, label);
        break;
      }
    }
  }

  // The saturation guard, and the shape of it is the point. More records of one kind than there
  // are slots means the object numbers cannot all be distinct — which is exactly what a +Drive
  // soundbank of 182 or 256 does, reporting `0` for everything past the 127th. Placing those by
  // number would write the first 128 and then overwrite every one of them with the saturated
  // remainder, silently. Refused, because the alternative is a plausible, wrong project.
  //
  // Settings is exempt: it has one slot by nature, so a second copy is a re-read rather than an
  // overflow, and the same later-wins rule that covers a repaired pattern covers it.
  for (const [what, slots] of [["pattern", patterns], ["kit", kits], ["sound", sounds]] as const) {
    if (slots.seen > slots.size) {
      throw new RebuildError(
        `the capture holds ${slots.seen} ${what} records for ${slots.size} slots. Past 128 objects ` +
          `the object number saturates at 0, so either this is a whole-bank dump rather than a ` +
          `project — a +Drive soundbank of 182 or 256 sounds looks exactly like this — or it is a ` +
          `project read plus a second pass over its failures. The two are indistinguishable from ` +
          `the bytes, so neither is guessed at: save a repaired second pass as its own capture, ` +
          `and rebuild from a bank dump is not a thing this does.`,
      );
    }
  }

  return {
    productId,
    placement,
    patterns: patterns.taken(),
    kits: kits.taken(),
    sounds: sounds.taken(),
    settings: settings.taken(),
    rejected,
    superseded: patterns.superseded + kits.superseded + sounds.superseded + settings.superseded,
    fromDonor: donorRegions(placement, sounds.count > 0, settings.count > 0),
    problems,
  };
}

/**
 * Write a plan onto a donor image.
 *
 * The donor supplies the 0.49% no capture carries and is otherwise entirely overwritten. It is
 * copied rather than modified, because a caller holding the donor open — the CLI reads it once
 * and may print from it afterwards — should not find it quietly rewritten underneath.
 *
 * **A new identity is minted.** `mintProjectId` exists because every project built from
 * `EMPTY.dn2prj` claimed to be `EMPTY`, and a rebuild is authoring a project rather than editing
 * the donor. Inheriting here would make every rebuilt project claim to be its template.
 *
 * `mint` is a parameter because the identity is the one thing about a rebuild that is not a
 * function of its inputs, and a caller that wants two runs to agree byte for byte — a test, a
 * diff — needs to be able to say so.
 */
export function applyRebuild(
  donor: Uint8Array, plan: RebuildPlan, mint: () => number = mintProjectId,
): Uint8Array {
  const { layout } = plan.placement;
  if (!layout.imageSizes.includes(donor.length)) {
    throw new RebuildError(
      `the donor image is ${donor.length} bytes and this capture needs ${layout.imageSizes.join(" or ")} — ` +
        `it is a project from the other family`,
    );
  }
  if (layout === DN1_LAYOUT) refuseMixedDn1Generations(donor, plan);

  const image = Uint8Array.from(donor);
  for (const group of [plan.patterns, plan.kits, plan.sounds, plan.settings]) {
    for (const placed of group) image.set(placed.bytes, placed.at);
  }
  writeProjectId(image, mint());
  return image;
}

/**
 * Check the image really holds what the plan said it would.
 *
 * Not ceremony: `applyRebuild` writes at computed offsets, and an offset that is wrong by a record
 * produces a file that opens, looks plausible and is wrong. Reading the bytes back is the only
 * check that does not share its arithmetic with the thing it is checking — the same reason
 * `rearrange.ts` verifies after writing.
 */
export function verifyRebuild(image: Uint8Array, plan: RebuildPlan): string[] {
  const problems: string[] = [];
  for (const group of [plan.patterns, plan.kits, plan.sounds, plan.settings]) {
    for (const placed of group) {
      const written = image.subarray(placed.at, placed.at + placed.bytes.length);
      if (written.length !== placed.bytes.length) {
        problems.push(`${placed.label} runs past the end of the image at ${placed.at}`);
        continue;
      }
      for (let i = 0; i < placed.bytes.length; i++) {
        if (written[i] !== placed.bytes[i]) {
          problems.push(`${placed.label} differs from the capture at byte ${i}`);
          break;
        }
      }
    }
  }
  return problems;
}

/** How many bytes of the image the capture actually supplied. */
export function coverage(plan: RebuildPlan): { supplied: number; total: number } {
  let supplied = 0;
  for (const group of [plan.patterns, plan.kits, plan.sounds, plan.settings]) {
    for (const placed of group) supplied += placed.bytes.length;
  }
  return { supplied, total: plan.placement.layout.imageSize };
}

/**
 * Refuse a Digitone 1 capture and donor written by different firmwares.
 *
 * OS 1.43 bumps every record version and moves no field, so the records line up perfectly and
 * the resulting image would assemble, open and be wrong: the instrument migrates a project on
 * **load**, against the root object version the donor carries, so version-10 records dropped
 * into a 1.43 donor are never converted, and version-11 records in a 1.42A donor are a version
 * the older firmware has never seen. Neither shows as a size or a checksum problem.
 *
 * The donor's length says which generation it belongs to, because the two firmwares that exist
 * write the Outbox block and the record version together. The captured records say theirs
 * outright. A rebuild is a write, so a disagreement is refused rather than reported.
 */
function refuseMixedDn1Generations(donor: Uint8Array, plan: RebuildPlan): void {
  const expected = donor.length === DN1_OS143_IMAGE_SIZE
    ? DN1_RECORD_VERSIONS[DN1_RECORD_VERSIONS.length - 1]!
    : DN1_RECORD_VERSION;

  for (const group of [plan.patterns, plan.kits]) {
    for (const placed of group) {
      const version = recordVersionOf(placed.bytes);
      if (version === undefined || version === expected) continue;
      throw new RebuildError(
        `${placed.label} is storage version ${version} and this ${donor.length}-byte donor holds ` +
          `version ${expected} records. The two are the same bytes at the same offsets, so the ` +
          `image would assemble and load, and the instrument would then skip the migration the ` +
          `older records need. Rebuild onto a donor saved by the firmware that produced the ` +
          `capture.`,
      );
    }
  }
}

/** The bare u32be version at the head of a Digitone 1 pattern or kit record. */
function recordVersionOf(record: Uint8Array): number | undefined {
  if (record.length < 4) return undefined;
  return new DataView(record.buffer, record.byteOffset, 4).getUint32(0, false);
}

export class RebuildError extends Error {}

/**
 * What a Digitone 1's `0x53` records in this capture are.
 *
 * **The one place a caller has to tell us something the bytes cannot.** On a Digitone 1 the same
 * dump type carries two different objects depending on how it was asked for:
 *
 * - a **request** (`0x63 n`) returns the active kit's four track sounds, `n` = 0..3 — verified on
 *   hardware, each one matching the corresponding track slot of one pattern's kit;
 * - a **front-panel sound-pool send** returns project pool slots.
 *
 * Both are `0x53` with an object number and a 302-byte payload. Nothing distinguishes them.
 *
 * Placing kit sounds into the pool would overwrite sound-lock targets 0–3 with the four presets
 * the tracks happen to be using — silent corruption of exactly the data a DN1→DN2 expansion
 * depends on. So with nothing specified, DN1 sound records are **not placed**, and the plan says
 * why. A Digitone II has no such ambiguity: `0x63` is the pool there, both ways.
 */
export type Dn1Sounds = "pool" | "kit";

export interface RebuildOptions {
  /** Required before a Digitone 1 capture's `0x53` records will be placed anywhere. */
  dn1Sounds?: Dn1Sounds;
}

/**
 * What the donor has to supply, named rather than counted.
 *
 * A number is not the useful thing here. "63,620 bytes came from somewhere else" tells a user
 * nothing; "the song table came from somewhere else" tells them whether to care.
 */
function donorRegions(placement: Placement, hasSounds: boolean, hasSettings: boolean): string[] {
  const regions = [
    "the image header — project name and the identity token at 0x18",
    "the tail before the sound pool",
    "the tail after the project settings — the song table and the slot array",
  ];
  if (!hasSounds) {
    // The normal outcome on a Digitone 1, whose project dump carries no 0x53 at all and whose
    // 0x63 reaches only the kit. Its pool is real — 128 slots, and what every sound lock points
    // at — but it comes from the front panel's own pool send or from nowhere.
    regions.push(
      placement.layout.patternSize === DN1_LAYOUT.patternSize
        ? "the whole 128-slot sound pool — no request we know of reaches a Digitone 1's pool, so " +
          "send it from SETTINGS > SYSEX DUMP and capture that separately if sound locks matter"
        : "the whole sound pool — no sound records were in this capture",
    );
  }
  if (!hasSettings) regions.push("the project settings record");
  return regions;
}

function labelFor(message: SysExMessage): string {
  switch (message.dumpType) {
    case PATTERN_KIT: return `PatternKit ${patternName(message.objNr)}`;
    case PATTERN_ONLY: return `Pattern ${patternName(message.objNr)}`;
    case KIT_ONLY: return `Kit ${patternName(message.objNr)}`;
    case SOUND: return `Sound ${message.objNr}`;
    default: return "Project settings";
  }
}

function expect(
  message: SysExMessage, size: number, label: string, rejected: Rejected[],
): boolean {
  if (message.payload.length === size) return true;
  rejected.push({
    label,
    reason: `payload is ${message.payload.length} bytes, expected ${size} — not this family's record`,
  });
  return false;
}

/**
 * Slots indexed by object number.
 *
 * Counts what it was offered as well as what it kept, because those differ in two different ways
 * and only one of them is benign: a re-read supersedes a slot, while a bank dump offers more
 * records than there are slots. `seen` is what lets the caller tell them apart.
 */
class Slots {
  private readonly slots: (Placed | undefined)[];
  superseded = 0;
  seen = 0;

  constructor(readonly size: number) {
    this.slots = new Array<Placed | undefined>(size).fill(undefined);
  }

  get count(): number {
    return this.slots.filter((s) => s !== undefined).length;
  }

  put(index: number, placed: Placed, rejected: Rejected[], label: string): void {
    this.seen++;
    if (index < 0 || index >= this.slots.length) {
      rejected.push({ label, reason: `object number ${index} is outside 0..${this.size - 1}` });
      return;
    }
    if (this.slots[index] !== undefined) this.superseded++;
    this.slots[index] = placed;
  }

  taken(): Placed[] {
    return this.slots.filter((s): s is Placed => s !== undefined);
  }
}

export { PROJECT_ID_OFFSET };
