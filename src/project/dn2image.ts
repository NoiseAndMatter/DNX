/**
 * Geometry of the decompressed Digitone II project image.
 *
 * Once `dn2codec.decodeProjectImage` has run, the project stops being a variable-length
 * puzzle and becomes a flat, fixed-offset image. Everything below is arithmetic on
 * constants — no scanning, no magic hunting.
 *
 * The single most useful fact here: a **project pattern record concatenated with its kit
 * record is byte-for-byte the same thing as a SysEx pattern dump payload**.
 *
 *   sysex pattern payload (99,840 bytes) = patternRecord (89,088) ++ kitRecord (10,752)
 *
 * So every offset learned from the emnyeca SysEx capture corpus applies unchanged to
 * project patterns. The trigger slot array at 0x4A34, the 1187-byte track records, the
 * 359-byte sound slots — all of it transfers directly.
 *
 * DN1 uses the same image shape with smaller records, which is what makes DN1 -> DN2
 * conversion tractable: both sides are fixed-offset arrays of 128 patterns and 128 kits.
 */

import { DN1_IMAGE_SIZE, DN2_IMAGE_SIZE } from "./dn2codec.js";

/** Layout constants for one device family's decoded project image. */
export interface ImageLayout {
  /** Total decoded image size. Constant across every corpus payload for this family. */
  imageSize: number;
  /** Bytes before the pattern array. Holds the root object and the project name. */
  headerSize: number;
  /** Number of pattern slots. 128 on both families (16 banks x 8, or 8 x 16). */
  patternCount: number;
  /** Size of one pattern record. */
  patternSize: number;
  /** Byte offset of the kit array. Always `headerSize + patternCount * patternSize`. */
  kitBase: number;
  /** Size of one kit record. One kit per pattern, same index. */
  kitSize: number;
  /** Byte offset of the region after the kit array. Contents only partly identified. */
  tailBase: number;
  /** Size of that trailing region. */
  tailSize: number;
}

/**
 * Digitone II, container kind 15, format version "0050".
 *
 * Verified on 9 payloads: the kit array base is where an unbroken run of 128 kit records
 * begins, and `kitBase - headerSize` divides exactly by 128 to give `patternSize`.
 */
export const DN2_LAYOUT: ImageLayout = {
  imageSize: DN2_IMAGE_SIZE,
  headerSize: 0x200,
  patternCount: 128,
  patternSize: 89_088, // 0x15C00
  kitBase: 0xae0200,
  kitSize: 10_752, // 0x2A00
  tailBase: 0xc30200,
  tailSize: 109_572,
};

/** Digitone 1, container kind 9, format version "0097". Verified on 53 payloads. */
export const DN1_LAYOUT: ImageLayout = {
  imageSize: DN1_IMAGE_SIZE,
  headerSize: 0x200,
  patternCount: 128,
  patternSize: 18_432, // 0x4800
  kitBase: 0x240200,
  kitSize: 2_560, // 0xA00
  tailBase: 0x290200,
  tailSize: 94_212,
};

/** Pick the layout that matches a decoded image, by its size. */
export function layoutFor(image: Uint8Array): ImageLayout {
  if (image.length === DN2_LAYOUT.imageSize) return DN2_LAYOUT;
  if (image.length === DN1_LAYOUT.imageSize) return DN1_LAYOUT;
  throw new Error(`Unrecognised decoded image size ${image.length}`);
}

/** Offsets inside one DN2 kit record, relative to the start of that record. */
export const DN2_KIT = {
  /** Kit object: BEEFBACE + u32be version 3 + 16-byte kit name + 16 u16le track levels. */
  headerOffset: 0,
  headerSize: 60,
  /** 16 sound slots, one per track, each a complete BEEFBACE sound object. */
  soundOffset: 60,
  soundSize: 359,
  soundCount: 16,
  /** 160 bytes between the last sound and the first MIDI record. Contents unidentified. */
  midiOffset: 5964,
  midiSize: 268,
  midiCount: 16,
  /** 500 bytes after the last MIDI record. Contents unidentified. */
  trailingOffset: 10_252,
} as const;

/** Offsets inside one DN1 kit record. DN1 has 4 synth tracks, hence 4 sound slots. */
export const DN1_KIT = {
  /** BEEFBACE-less header: u32be version + 16-byte kit name + 4 u16le track levels. */
  headerOffset: 0,
  headerSize: 28,
  soundOffset: 28,
  soundSize: 302,
  soundCount: 4,
} as const;

/**
 * Byte offset of a 16-byte sound name inside a sound object.
 *
 * A sound object is `BEEFBACE` (4) + u32be version (4) + 4 unidentified bytes + name.
 * Same on both families and on SysEx sound dumps.
 */
export const SOUND_NAME_OFFSET = 12;
export const SOUND_NAME_SIZE = 16;

/** Slice pattern `index` out of a decoded image. */
export function patternRecord(image: Uint8Array, index: number, layout = layoutFor(image)): Uint8Array {
  assertIndex(index, layout.patternCount, "pattern");
  const at = layout.headerSize + index * layout.patternSize;
  return image.subarray(at, at + layout.patternSize);
}

/** Slice the kit belonging to pattern `index`. */
export function kitRecord(image: Uint8Array, index: number, layout = layoutFor(image)): Uint8Array {
  assertIndex(index, layout.patternCount, "kit");
  const at = layout.kitBase + index * layout.kitSize;
  return image.subarray(at, at + layout.kitSize);
}

/**
 * Rebuild the SysEx pattern-dump payload for pattern `index`.
 *
 * The result is exactly what an 8-in-7-decoded `F0 00 20 3C 15 00 50 ...` pattern dump
 * carries, so it can be fed straight to any code written against the SysEx corpus.
 * DN2 only — the DN1 record sizes do not correspond to a DN1 pattern dump this way, and
 * that has not been checked.
 */
export function patternAsSysexPayload(image: Uint8Array, index: number): Uint8Array {
  const layout = layoutFor(image);
  if (layout !== DN2_LAYOUT) {
    throw new Error("patternAsSysexPayload is only verified for Digitone II images");
  }
  const out = new Uint8Array(layout.patternSize + layout.kitSize);
  out.set(patternRecord(image, index, layout), 0);
  out.set(kitRecord(image, index, layout), layout.patternSize);
  return out;
}

/** Read the 16 sound-slot names of a DN2 kit. Empty string means an unused slot. */
export function dn2KitSoundNames(image: Uint8Array, index: number): string[] {
  const kit = kitRecord(image, index, DN2_LAYOUT);
  const names: string[] = [];
  for (let i = 0; i < DN2_KIT.soundCount; i++) {
    const at = DN2_KIT.soundOffset + i * DN2_KIT.soundSize + SOUND_NAME_OFFSET;
    names.push(readName(kit, at));
  }
  return names;
}

/** Project name from the image header. 16-byte field directly after the root object version. */
export function projectName(image: Uint8Array): string {
  return readName(image, 8);
}

function readName(data: Uint8Array, at: number): string {
  const raw = data.subarray(at, at + SOUND_NAME_SIZE);
  const end = raw.indexOf(0);
  return new TextDecoder("latin1").decode(end === -1 ? raw : raw.subarray(0, end));
}

function assertIndex(index: number, count: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`${what} index ${index} out of range 0..${count - 1}`);
  }
}
