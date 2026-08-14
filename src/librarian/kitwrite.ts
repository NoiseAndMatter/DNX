/**
 * Loading a kit into a pattern.
 *
 * ## What a kit is, and why this operation needs a preview more than any other
 *
 * A pattern owns one kit, and a kit is **sixteen presets, sixteen levels and the synth/MIDI
 * mask** — everything about how a pattern *sounds*, and nothing about what it *plays*. The trigs,
 * their notes, their conditions and their parameter locks all live in the pattern record and are
 * untouched here.
 *
 * So loading a kit keeps the music and replaces the instruments. That is either exactly what
 * somebody wants — the same sequence through a different palette — or a catastrophe, and the two
 * are indistinguishable until it has happened. **Which is why this module's real output is the
 * per-track before/after**, not the sixteen presets it copies.
 *
 * ## Preset locks survive, and that changes the answer
 *
 * A preset lock points at the project's **pool**, which a kit does not contain and this operation
 * does not touch. A locked trig therefore keeps playing exactly what it played. So a track whose
 * trigs are all preset-locked hears nothing of a kit change, and a track with none hears all of
 * it — and that is worth saying out loud, because "16 tracks replaced" and "4 tracks replaced,
 * 12 of them only where nothing is locked" are very different sentences about the same write.
 *
 * ## Digitone II only
 *
 * The DN1 has no kits. That is not a gap in what has been decoded: a Digitone 1's `/` listing
 * answers with two directories and a Digitone II's with three, and the third is `kits`. So a DN1
 * project is refused with the reason rather than handled approximately.
 *
 * ## Plan, then apply
 *
 * Same split as `poolwrite.ts` and `trackmove.ts`. Everything a person needs in order to say yes
 * is on the plan, and nothing is written until they have.
 */

import { DN2_SPEC } from "../project/spec.js";
import { DN2_LAYOUT, kitRecord, patternRecord } from "../project/dn2image.js";
import { SOUND_NAME_SIZE } from "../project/soundmap.js";
import { soundLockCountsByTrack } from "../project/dn2pattern.js";
import { type Device } from "./device.js";
import { type KitTrack, summariseKitTracks, trigCounts } from "./tracksummary.js";

export class KitWriteError extends Error {}

/**
 * Where the kit name sits inside a kit record: `BEEFBACE`, u32be version, then 16 bytes.
 *
 * **Not `SOUND_NAME_OFFSET`.** A sound object carries four unidentified bytes before its name and
 * a kit record does not, so the two are 12 and 8 — sharing a size is not a reason to share a
 * constant. Corroborated on a kit read off a +Drive: `SOLID` reads at +8, and the sixteen u16le
 * track levels start at 0x1C exactly where the name ends.
 */
/**
 * Where a Digitone II kit keeps its name.
 *
 * **Read from the spec, not written here.** The same fact lived in `blank.ts` as well, as a record
 * keyed by device kind — two addresses for one field, which is the shape of every drift this
 * codebase has paid for. Kept as a named export because the reader below and its callers say
 * `KIT_NAME_OFFSET` and that is the clearer word at those call sites.
 */
export const KIT_NAME_OFFSET = DN2_SPEC.kit.nameOffset;

export interface LoadKitOptions {
  /** The pattern whose kit is replaced, 0-based. */
  pattern: number;
}

/**
 * The name of the kit a pattern is currently wearing.
 *
 * **Exported because a kit load was otherwise invisible.** Loading a kit replaces sixteen presets
 * and changes nothing a pattern cell displays — a cell shows the pattern's own name and its trig
 * counts, and a kit is the sound rather than the sequence. So the grid went on correctly showing an
 * unchanged pattern while everything underneath it had been replaced, and the only trace was a
 * status line the next click overwrote.
 *
 * The durable answer is not a message about what just happened. It is showing which kit is on, all
 * the time, so *"what is this pattern wearing"* is a question the page can answer at rest.
 *
 * **Empty is a real answer.** The device names a kit lazily — `KIT <slot + 1>`, supplied when it
 * loads one — so a blank here means nobody has named it, not that it could not be read.
 */
export function readPatternKitName(image: Uint8Array, device: Device, pattern: number): string {
  // A Digitone 1 has no kits at all, which is why its +Drive has no `/kits`. Nothing to report
  // rather than an error: this is a display helper and a grid still has to draw.
  if (device.kind !== "dn2") return "";
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= DN2_LAYOUT.patternCount) return "";
  return readName(kitRecord(image, pattern, DN2_LAYOUT), KIT_NAME_OFFSET);
}

/** One track's side of the change. `before` and `after` differ only in what a kit holds. */
export interface KitTrackChange {
  index: number;
  label: string;
  before: KitTrack;
  after: KitTrack;
  /** True when anything a person would notice differs — preset, machine, level or track mode. */
  changed: boolean;
  /**
   * True when the **preset itself** differs, as opposed to only its level.
   *
   * Kept apart from `changed` because the two deserve different sentences. A track whose level
   * moves from 99 to 100 has changed; saying it "will play something else" would be false, and a
   * preview that overstates gets ignored exactly as fast as one that understates.
   */
  presetChanged: boolean;
  /** Trigs on this track. They do not move; they will play something else. */
  trigCount: number;
  /**
   * Trigs whose preset is locked to the pool, and which therefore keep the sound they have.
   *
   * Never larger than `trigCount`. When it equals it, the kit change is inaudible on this track.
   */
  lockedTrigs: number;
}

export interface LoadKitPlan {
  pattern: number;
  /** The incoming kit's name, or empty — the device leaves an untouched kit unnamed. */
  name: string;
  /** The name of the kit being replaced. */
  replaces: string;
  tracks: KitTrackChange[];
  /** Tracks where something a person would notice differs. */
  changedTracks: number[];
  /**
   * Tracks that carry trigs and will hear the change on at least one of them.
   *
   * The number that matters: a changed track nobody plays is a detail, and a changed track with
   * forty trigs on it is the whole point.
   */
  audibleTracks: number[];
}

/**
 * Work out what loading this kit would do. Nothing is written.
 *
 * Every refusal is a `KitWriteError` naming the thing a person would have to decide about.
 */
export function planLoadKit(
  image: Uint8Array,
  device: Device,
  kit: Uint8Array,
  options: LoadKitOptions,
): LoadKitPlan {
  if (device.kind !== "dn2") {
    throw new KitWriteError(
      `${device.name} projects have no kits — the Digitone 1 has none at all, which is why its ` +
        `+Drive has no /kits directory. There is nothing here to load a kit into.`,
    );
  }

  const { pattern } = options;
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= DN2_LAYOUT.patternCount) {
    throw new KitWriteError(
      `${pattern} is not a pattern; a project holds 0..${DN2_LAYOUT.patternCount - 1}`,
    );
  }

  // Size first, because everything after it would read or write somewhere wrong. A stored kit file
  // is 10,795 bytes — the record plus the 43-byte container — and passing the file instead of the
  // body is the mistake worth naming, since it is the one that produces a plausible-looking result.
  if (kit.length !== DN2_LAYOUT.kitSize) {
    throw new KitWriteError(
      `this kit is ${kit.length} bytes and a Digitone II kit record is ${DN2_LAYOUT.kitSize}. ` +
        `A stored file carries 43 bytes of container around the body — pass the body, not the file.`,
    );
  }

  const current = kitRecord(image, pattern, DN2_LAYOUT);
  const before = summariseKitTracks(current);
  const after = summariseKitTracks(kit);
  const trigs = trigCounts(image, pattern);
  const locked = soundLockCountsByTrack(patternRecord(image, pattern, DN2_LAYOUT));

  const tracks = before.map((was, index) => {
    const now = after[index]!;
    const presetChanged =
      was.presetName !== now.presetName || was.machine !== now.machine || was.midi !== now.midi;
    return {
      index,
      label: was.label,
      before: was,
      after: now,
      changed: presetChanged || was.level !== now.level,
      presetChanged,
      trigCount: trigs[index]!,
      // Clamped, because the two are counted from different tables and a lock count above the trig
      // count would be a decoding error surfacing as a nonsense sentence rather than as a problem.
      lockedTrigs: Math.min(locked[index]!, trigs[index]!),
    };
  });

  return {
    pattern,
    name: readName(kit, KIT_NAME_OFFSET),
    replaces: readName(current, KIT_NAME_OFFSET),
    tracks,
    changedTracks: tracks.filter((t) => t.changed).map((t) => t.index),
    // `presetChanged`, not `changed`: a level moving is not a trig playing something else.
    audibleTracks: tracks
      .filter((t) => t.presetChanged && t.trigCount > t.lockedTrigs)
      .map((t) => t.index),
  };
}

/**
 * Write the kit in, returning a new image.
 *
 * **Plans again rather than trusting a plan handed to it**, for the same reason `applyAddPreset`
 * does: a caller may have planned against an image it has since changed, and re-planning is cheap
 * against the cost of replacing sixteen presets in the wrong pattern.
 */
export function applyLoadKit(
  image: Uint8Array,
  device: Device,
  kit: Uint8Array,
  options: LoadKitOptions,
): { image: Uint8Array; plan: LoadKitPlan } {
  const plan = planLoadKit(image, device, kit, options);

  const out = Uint8Array.from(image);
  out.set(kit, DN2_LAYOUT.kitBase + plan.pattern * DN2_LAYOUT.kitSize);
  return { image: out, plan };
}

/**
 * A few lines describing what a plan would do, most consequential first.
 *
 * Lines rather than a sentence: sixteen tracks do not fit in one, and the thing a person is
 * deciding about is which of them they are about to lose.
 */
export function describeLoadKit(plan: LoadKitPlan): string[] {
  const lines: string[] = [];
  const what = plan.name || "an unnamed kit";
  const over = plan.replaces || "an unnamed kit";

  if (plan.changedTracks.length === 0) {
    return [`${what} is identical to ${over} on all sixteen tracks. Loading it changes nothing.`];
  }

  lines.push(
    `${what} → pattern ${plan.pattern}, replacing ${over}. ` +
      `${plan.changedTracks.length} of 16 track(s) change.`,
  );

  const silent = plan.changedTracks.filter((t) => !plan.audibleTracks.includes(t));
  if (plan.audibleTracks.length > 0) {
    const trigs = plan.tracks
      .filter((t) => plan.audibleTracks.includes(t.index))
      .reduce((n, t) => n + t.trigCount - t.lockedTrigs, 0);
    lines.push(
      `${trigs} trig(s) on ${plan.audibleTracks.length} track(s) will play something else: ` +
        plan.audibleTracks.map((t) => plan.tracks[t]!.label).join(", "),
    );
  }
  // Split by *why* they are silent. "Only the level moves" and "every trig is preset-locked" are
  // both reasons a track will not sound different, and lumping them together loses the one a
  // person might want to act on.
  const levelOnly = silent.filter((t) => !plan.tracks[t]!.presetChanged);
  const unheard = silent.filter((t) => plan.tracks[t]!.presetChanged);
  if (unheard.length > 0) {
    lines.push(
      `${unheard.length} track(s) get a different preset that nothing will hear — no trigs, or ` +
        `every trig preset-locked to the pool, which a kit does not touch.`,
    );
  }
  if (levelOnly.length > 0) {
    lines.push(
      `${levelOnly.length} track(s) keep their preset and only change level: ` +
        levelOnly.map((t) => plan.tracks[t]!.label).join(", "),
    );
  }

  for (const track of plan.tracks) {
    if (!track.changed) continue;
    lines.push(
      `  ${track.label}: ${track.before.presetName || "unnamed"} → ` +
        `${track.after.presetName || "unnamed"}` +
        (track.before.level === track.after.level
          ? ""
          : ` · level ${track.before.level} → ${track.after.level}`) +
        (track.before.midi === track.after.midi
          ? ""
          : ` · ${track.after.midi ? "becomes a MIDI track" : "becomes a synth track"}`) +
        (track.trigCount === 0
          ? " · no trigs"
          : track.lockedTrigs === 0
            ? ` · ${track.trigCount} trig(s)`
            : ` · ${track.trigCount} trig(s), ${track.lockedTrigs} preset-locked and unaffected`),
    );
  }
  return lines;
}

function readName(record: Uint8Array, at: number): string {
  const raw = record.subarray(at, at + SOUND_NAME_SIZE);
  const nul = raw.indexOf(0);
  return new TextDecoder("latin1").decode(nul === -1 ? raw : raw.subarray(0, nul)).trim();
}
