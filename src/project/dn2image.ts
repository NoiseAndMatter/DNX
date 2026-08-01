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

/**
 * Offsets inside one DN2 kit record, relative to the start of that record.
 *
 * **This is the only home for these numbers.** They were re-declared in `expand/convert.ts`,
 * `sheet/collect.ts`, `project/locate.ts`, `expand/merge.ts` and `cli/extractblankproject.ts`, and
 * the track level was worse — it had no home at all, so it appeared as a bare `0x1c` in two
 * librarian modules. A constant with six homes cannot be corrected in one place when the next
 * differential analysis moves it, and these bytes are written to hardware.
 */
export const DN2_KIT = {
  /** Kit object: BEEFBACE + u32be version 3 + 16-byte kit name + 16 u16le track levels. */
  headerOffset: 0,
  headerSize: 60,
  /**
   * 16 track levels, **u16le**, in the kit header. The DN1's four sit at its own kit+0x14.
   *
   * The container is two bytes; the value is 0-127, as the device shows it. Across the DN2 corpus
   * — 49,152 levels — the high byte is **never** non-zero and the maximum is 127. So reading only
   * the low byte has been accidentally right, which is precisely why `trackLevel` exists below:
   * `sheet/collect.ts` read the pair and `librarian/tracksummary.ts` read one byte, and nothing
   * would have said which was wrong until the first value above 255.
   */
  levelOffset: 0x1c,
  levelSize: 2,
  levelCount: 16,
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

/**
 * A track's level, out of a DN2 kit record. `track` is 0-based.
 *
 * An accessor rather than a constant to import, because the two callers that read this by hand
 * disagreed about its width — one read the pair, one read a byte. One accessor means the next
 * caller cannot.
 */
export function trackLevel(kit: Uint8Array, track: number): number {
  assertIndex(track, DN2_KIT.levelCount, "track");
  const at = DN2_KIT.levelOffset + track * DN2_KIT.levelSize;
  return kit[at]! | (kit[at + 1]! << 8);
}

/** Write a track's level into a DN2 kit record. `track` is 0-based. */
export function setTrackLevel(kit: Uint8Array, track: number, level: number): void {
  assertIndex(track, DN2_KIT.levelCount, "track");
  const at = DN2_KIT.levelOffset + track * DN2_KIT.levelSize;
  kit[at] = level & 0xff;
  kit[at + 1] = (level >> 8) & 0xff;
}

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

/**
 * Overwrite the project name in place, NUL-padded to the full field.
 *
 * Same offset on both families. Characters outside the single-byte printable range are
 * dropped rather than mangled, and the name is truncated to leave a terminating NUL — a name
 * that filled all 16 bytes would run into whatever follows when the device read it.
 */
export function writeProjectName(image: Uint8Array, name: string): void {
  image.fill(0, 8, 8 + SOUND_NAME_SIZE);
  const bytes = [...name]
    .map((c) => c.codePointAt(0)!)
    .filter((c) => c >= 0x20 && c <= 0xff)
    .slice(0, SOUND_NAME_SIZE - 1);
  image.set(Uint8Array.from(bytes), 8);
}

/** Byte offset of the project identity token, on both families. */
export const PROJECT_ID_OFFSET = 0x18;

/**
 * The four bytes at `0x18`, which identify a project rather than checksum it.
 *
 * Established 2026-07-27 by round-tripping a generated project through a Digitone II. Not a
 * content hash — `EMPTY.dn2prj` and a converted project with entirely different contents
 * share `743a3f5b` — and not recomputed on save, since the device preserved an inherited
 * value byte for byte. `dn2-format.md` §2 has the evidence.
 */
export function projectId(image: Uint8Array): number {
  return new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(
    PROJECT_ID_OFFSET,
    false,
  );
}

export function writeProjectId(image: Uint8Array, id: number): void {
  new DataView(image.buffer, image.byteOffset, image.byteLength).setUint32(
    PROJECT_ID_OFFSET,
    id >>> 0,
    false,
  );
}

/**
 * A fresh identity for a newly authored project.
 *
 * **Why this is minted rather than inherited.** Conversion is a transplant: fields nobody
 * writes keep the template's value. For most of the image that is what makes writing safe
 * with a partial understanding of the format — but an *identity* is exactly the field where
 * inheriting is wrong. Every project built from `EMPTY.dn2prj` claimed to be `EMPTY`.
 *
 * The corpus settles what a device does: the nine DN1 projects the Digitone II upgraded on
 * first open all carry **distinct** values, while our generated ones duplicated their
 * template's. So a new project gets a new identity — and only a genuinely new one, since
 * rearranging a project is editing it rather than authoring another.
 *
 * Random rather than derived, because we do not know what the device derives it from and a
 * plausible-looking wrong derivation is worse than an honest random one. It is not validated
 * on load: files carrying an inherited value have loaded and played on hardware twice.
 */
export function mintProjectId(): number {
  // Two 16-bit halves rather than one scaled call: it keeps the low bits as well distributed
  // as the high ones, which a single `Math.random() * 2**32` does not guarantee.
  const hi = Math.floor(Math.random() * 0x10000);
  const lo = Math.floor(Math.random() * 0x10000);
  return ((hi << 16) | lo) >>> 0;
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
