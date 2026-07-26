/**
 * Naming concern: given a byte offset, say what field it is.
 *
 * Differential analysis produces offsets — "byte 88,809 changed". Turning that into "pattern
 * metadata +0x14, the master length" is the step that actually costs time, and it is the same
 * arithmetic every time. This does it once.
 *
 * Everything here is derived from the record geometry documented in `docs/dn2-format.md` and
 * `docs/dn2-pattern-format.md`. An offset in a region whose contents are unknown is named as
 * that region and marked unknown, which is the honest answer and still narrows the search.
 */

import { PATTERN, STEP_COUNT, TRACK, TRACK_COUNT, KIT_MIDI_MASK_OFFSET } from "./dn2pattern.js";
import { DN2_LAYOUT } from "./dn2image.js";
import { describeKitFx } from "./kitfx.js";

/** A SysEx pattern dump is a pattern record followed by its kit record. */
export const PATTERN_PAYLOAD_SIZE = DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize;

export interface Location {
  /** Broad area: "track 3", "trigger slots", "kit", "pattern metadata". */
  region: string;
  /** The field, where known. Absent when the region's contents are not understood. */
  field?: string;
  /** Offset within the region, for the cases where that is the useful number. */
  within: number;
  /** True when the bytes here have no documented meaning. */
  unknown: boolean;
}

/** Per-track settings offsets that have been identified. See dn2-pattern-format.md §5. */
const TRACK_SETTINGS_FIELDS: Record<number, string> = {
  0x00: "default note",
  0x01: "default velocity",
  0x02: "default note length",
  0x0d: "track length in steps",
  0x0f: "track speed",
  0x10: "track level",
};

/**
 * Pattern metadata fields, with their sizes. See dn2-pattern-format.md §6.
 *
 * Sizes matter: three of these are `u16be`, and naming only their first byte would report the
 * low byte of the master length as unidentified — the offset a capture is most likely to move,
 * since anything above 255 changes it alone.
 */
const META_FIELDS: readonly { at: number; size: number; name: string }[] = [
  { at: 0x00, size: 16, name: "pattern name" },
  { at: 0x11, size: 1, name: "copy of DN1 0x4735" },
  { at: 0x12, size: 2, name: "tempo (bpm x 120)" },
  { at: 0x14, size: 2, name: "master length / RESET" },
  { at: 0x16, size: 2, name: "change length / CHNG" },
  { at: 0x18, size: 1, name: "copy of DN1 0x473C" },
  { at: 0x19, size: 1, name: "scale mode" },
  { at: 0x1a, size: 1, name: "pattern speed" },
  { at: 0x1c, size: 1, name: "own slot index" },
  { at: 0x21, size: 1, name: "always 7 from the importer, 1 from the device" },
];

/** The six bytes of a trigger slot. */
const TRIG_SLOT_FIELDS = ["track", "step", "note", "velocity", "note length", "micro timing"];

/** DN2 kit geometry. */
const KIT_HEADER = 60;
const KIT_SOUND_SIZE = 359;
const KIT_SOUND_COUNT = 16;
const KIT_MIDI_BASE = 5_964;
const KIT_MIDI_SIZE = 268;
const KIT_MIDI_COUNT = 16;
const KIT_PER_TRACK_ARRAY = 10_264;
const KIT_PER_TRACK_STRIDE = 5;

function locateInTrack(track: number, within: number): Location {
  const region = `track ${track + 1}`;

  if (within < 0x100) {
    return { region, field: `step flags, step ${Math.floor(within / 2) + 1}`, within, unknown: false };
  }
  if (within < 0x180) return { region, field: `trig condition A, step ${within - 0x100 + 1}`, within, unknown: false };
  if (within < 0x200) return { region, field: `trig condition B, step ${within - 0x180 + 1}`, within, unknown: false };
  if (within < 0x280) return { region, field: `probability, step ${within - 0x200 + 1}`, within, unknown: false };
  if (within < 0x400) {
    const array = ["A", "B", "C"][Math.floor((within - 0x280) / STEP_COUNT)];
    return { region, field: `unidentified per-step array ${array}`, within, unknown: true };
  }
  if (within < TRACK.settingsOffset) {
    return { region, field: `sound lock, step ${within - 0x400 + 1}`, within, unknown: false };
  }

  const settingsOffset = within - TRACK.settingsOffset;
  const named = TRACK_SETTINGS_FIELDS[settingsOffset];
  return {
    region: `${region} settings`,
    ...(named ? { field: `+0x${settingsOffset.toString(16)} ${named}` } : {}),
    within: settingsOffset,
    unknown: named === undefined,
  };
}

function locateInKit(within: number): Location {
  if (within < KIT_HEADER) {
    const field =
      within < 4 ? "object magic" :
      within < 8 ? "record version" :
      within < 0x18 ? "kit name" :
      within < 0x1c ? "unidentified" :
      `track level ${Math.floor((within - 0x1c) / 2) + 1}`;
    return { region: "kit header", field, within, unknown: field === "unidentified" };
  }

  const soundArea = within - KIT_HEADER;
  if (soundArea < KIT_SOUND_COUNT * KIT_SOUND_SIZE) {
    const slot = Math.floor(soundArea / KIT_SOUND_SIZE);
    const inSound = soundArea % KIT_SOUND_SIZE;
    const field = inSound < 12 ? "object header" : inSound < 28 ? "sound name" : "sound parameters";
    return { region: `kit sound slot ${slot + 1}`, field: `+${inSound} ${field}`, within: inSound, unknown: false };
  }

  if (within < KIT_MIDI_BASE) {
    const fx = describeKitFx(within);
    if (fx) return { region: "kit FX", field: fx, within: within - 5_804, unknown: false };
    return { region: "kit gap 5804-5963", field: "FX and unidentified", within: within - 5_804, unknown: true };
  }

  const midiArea = within - KIT_MIDI_BASE;
  if (midiArea < KIT_MIDI_COUNT * KIT_MIDI_SIZE) {
    const record = Math.floor(midiArea / KIT_MIDI_SIZE);
    const inRecord = midiArea % KIT_MIDI_SIZE;
    const field =
      inRecord < 12 ? "object header" :
      inRecord < 28 ? "track name" :
      inRecord >= 0x8e && inRecord < 0xae ? `CC number ${Math.floor((inRecord - 0x8e) / 2) + 1}` :
      inRecord >= 0xb0 && inRecord < 0x108 ? "CC value name" :
      "unidentified";
    return {
      region: `kit MIDI record ${record + 1}`,
      field: `+0x${inRecord.toString(16)} ${field}`,
      within: inRecord,
      unknown: field === "unidentified",
    };
  }

  if (within === KIT_MIDI_MASK_OFFSET || within === KIT_MIDI_MASK_OFFSET + 1) {
    return { region: "kit", field: "synth/MIDI track mask", within, unknown: false };
  }

  if (within >= KIT_PER_TRACK_ARRAY && within < KIT_PER_TRACK_ARRAY + KIT_MIDI_COUNT * KIT_PER_TRACK_STRIDE) {
    const entry = Math.floor((within - KIT_PER_TRACK_ARRAY) / KIT_PER_TRACK_STRIDE);
    return {
      region: "kit per-track array at 10264",
      field: `entry ${entry + 1}, byte ${(within - KIT_PER_TRACK_ARRAY) % KIT_PER_TRACK_STRIDE}`,
      within,
      unknown: true,
    };
  }

  return { region: "kit gap 10252-10751", within, unknown: true };
}

/**
 * Locate an offset inside a SysEx pattern payload — pattern record then kit record, the
 * 99,840-byte shape a `Pattern+Kit` dump decodes to.
 */
export function locateInPatternPayload(offset: number): Location {
  if (offset < 0 || offset >= PATTERN_PAYLOAD_SIZE) {
    return { region: "outside the payload", within: offset, unknown: true };
  }

  if (offset >= DN2_LAYOUT.patternSize) return locateInKit(offset - DN2_LAYOUT.patternSize);

  if (offset < PATTERN.trackOffset) return { region: "pattern record", field: "record version", within: offset, unknown: false };

  const trackArea = offset - PATTERN.trackOffset;
  if (trackArea < TRACK_COUNT * TRACK.size) {
    return locateInTrack(Math.floor(trackArea / TRACK.size), trackArea % TRACK.size);
  }

  if (offset < PATTERN.lockOffset) {
    const slotArea = offset - PATTERN.trigOffset;
    const slot = Math.floor(slotArea / PATTERN.trigSize);
    const byte = slotArea % PATTERN.trigSize;
    return { region: `trigger slot ${slot}`, field: TRIG_SLOT_FIELDS[byte]!, within: byte, unknown: false };
  }

  if (offset < PATTERN.metaOffset) {
    const lockArea = offset - PATTERN.lockOffset;
    const record = Math.floor(lockArea / PATTERN.lockSize);
    const byte = lockArea % PATTERN.lockSize;
    const field =
      byte === 0 ? "parameter id" : byte === 1 ? "track" : `step ${Math.floor((byte - 2) / 2) + 1} value`;
    return { region: `lock record ${record}`, field, within: byte, unknown: false };
  }

  if (offset < PATTERN.metaOffset + 44) {
    const within = offset - PATTERN.metaOffset;
    const named = META_FIELDS.find((f) => within >= f.at && within < f.at + f.size);
    return {
      region: "pattern metadata",
      ...(named ? { field: `+0x${named.at.toString(16)} ${named.name}` } : {}),
      within,
      unknown: named === undefined,
    };
  }

  return { region: "pattern record trailer", field: "0xFF padding", within: offset - PATTERN.metaOffset - 44, unknown: false };
}

/** One line, for a diff report. */
export function describeOffset(offset: number): string {
  const at = locateInPatternPayload(offset);
  const suffix = at.field ? ` ${at.field}` : at.unknown ? " (unidentified)" : "";
  return `${at.region}${suffix}`;
}
