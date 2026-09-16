/**
 * The arpeggiator, as it is stored in a Digitone II sound object.
 *
 * ## Why this is here and not in the sound explorer
 *
 * An arp changes **what a pattern sounds**. A track with the arp engaged does not play the notes
 * written on its trigs: it plays each of them offset by a per-step table, so a pattern's pitch
 * content and the key it fits are both wrong without this. That makes it analysis input, not a
 * parameter display.
 *
 * ## Where the fields are, and how they were found
 *
 * Captured on hardware on 2026-09-16 against stock Elektron 1.11. Fourteen presets were saved from
 * a single baseline, one control moved by one step each, and **every save moved exactly one byte**
 * — which is what names the fields rather than inferring them. The objects and the full write-up
 * are in the corpus at `99_HardwareTest/arp-dn2-2026-09-16/`.
 *
 * ```
 * 331  MODE        0 = OFF, then TRUE, UP, DOWN, CYCL. The firmware clamps it to 0..4.
 * 332  SPD         see the version note below
 * 333  RNG         octave range
 * 334  N.LEN       note length
 * 335  LEN         active steps, zero-based: 15 means sixteen
 * 336  enable      u16, one bit per step, **bit 0 is step 1** and the bits run LSB first
 * 338  offsets     sixteen signed bytes, semitones, two's complement
 * ```
 *
 * **Offsets 324..330 are not arp**, though they sit immediately before it and a disassembly makes
 * them look like one block: all seven sat unchanged through all fourteen saves.
 *
 * ## Two things that will bite a reader who skips them
 *
 * **The region only exists in a full-length object.** A short sound object terminates at 315,
 * forty bytes before MODE would begin, so the field is absent rather than zero. `readArp` returns
 * `undefined` for those rather than reading padding as an arp that is switched off.
 *
 * **State survives past LEN.** Shorten the arp and the instrument keeps the enable bits and the
 * offsets on the steps it dropped, exactly as a shortened track keeps the trigs on the pages it no
 * longer plays. 60 of the 333 engaged tracks in the corpus carry state out there. Anything reading
 * the table has to stop at LEN or it will add pitch classes that never sound.
 *
 * ## `SPD` is not comparable across object versions
 *
 * A version-1 object stores an index into an eighteen-value list; a version-2 or later one stores a
 * value in a 0..22 list with five inserted. The firmware remaps on promotion. The corpus shows it
 * from both ends: v1 records span 0..17 and use the five inserted positions, v2 records span 0..22
 * and land on none of them. Nothing here reads `SPD` for meaning, and anything that starts to must
 * remap first.
 */

/** Where each field sits, as an offset into the sound object. */
export const ARP = {
  modeOffset: 331,
  speedOffset: 332,
  rangeOffset: 333,
  noteLengthOffset: 334,
  lengthOffset: 335,
  enableOffset: 336,
  offsetsOffset: 338,
  /** The table is always sixteen entries wide, whatever LEN says is live. */
  steps: 16,
  /** A sound object that does not carry the region ends before this. */
  terminatorOffset: 355,
} as const;

/** `MODE`, by the names the instrument shows. Index is the stored byte. */
export const ARP_MODE = ["OFF", "TRUE", "UP", "DOWN", "CYCL"] as const;

export interface ArpStep {
  /** Whether this step sounds. Every step is on until somebody switches one off. */
  on: boolean;
  /** Semitones, signed. Zero for a step at the root, and also for one that is switched off. */
  offset: number;
}

export interface ArpState {
  /** 0 is OFF, and an OFF arp still carries whatever was set before it was switched off. */
  mode: number;
  /** `MODE` by name, or the raw byte for a value this table cannot name. */
  modeName: string;
  speed: number;
  range: number;
  noteLength: number;
  /** Active steps, 1..16. Stored zero-based. */
  length: number;
  /** The live steps only — `length` of them, never the whole sixteen. */
  steps: ArpStep[];
}

/** True when the object is long enough to carry the arp region at all. */
function hasRegion(sound: Uint8Array): boolean {
  const at = ARP.terminatorOffset;
  return sound.length >= at + 4 &&
    sound[at] === 0xba && sound[at + 1] === 0xce && sound[at + 2] === 0xf0 && sound[at + 3] === 0x0c;
}

/**
 * The arp state in a sound object, or `undefined` when the object does not carry one.
 *
 * `undefined` means *this object has no arp region*, which is a different fact from `mode === 0`
 * meaning *the arp is switched off*. A caller deciding whether pitch content is trustworthy needs
 * to tell those apart.
 */
export function readArp(sound: Uint8Array): ArpState | undefined {
  if (!hasRegion(sound)) return undefined;

  const mode = sound[ARP.modeOffset]!;
  // Stored zero-based, and clamped: a byte outside 0..15 would otherwise index past the table.
  const length = Math.min(ARP.steps, Math.max(1, sound[ARP.lengthOffset]! + 1));
  const enable = (sound[ARP.enableOffset]! << 8) | sound[ARP.enableOffset + 1]!;

  const steps: ArpStep[] = [];
  for (let i = 0; i < length; i++) {
    const raw = sound[ARP.offsetsOffset + i]!;
    steps.push({
      on: (enable & (1 << i)) !== 0,
      // Two's complement. Confirmed both ways: +7 stores 0x07 and -7 stores 0xf9 on hardware, and
      // the corpus's own offsets read -17..+22 signed against a meaningless 1..255 unsigned.
      offset: raw > 127 ? raw - 256 : raw,
    });
  }

  return {
    mode,
    modeName: ARP_MODE[mode] ?? String(mode),
    speed: sound[ARP.speedOffset]!,
    range: sound[ARP.rangeOffset]!,
    noteLength: sound[ARP.noteLengthOffset]!,
    length,
    steps,
  };
}

/**
 * The semitone offsets a held note is actually sounded at, ascending and distinct.
 *
 * Empty when the arp is off, which is the caller's signal to use the written note unchanged.
 *
 * **MODE is deliberately not consulted beyond on/off.** TRUE, UP, DOWN and CYCL differ in the
 * *order* the steps are played, and order does not change which pitches sound. Nor does `RNG`,
 * which adds octaves: an octave is the same pitch class. So for pitch content and for a key fit,
 * the mode only matters as a switch.
 */
export function arpIntervals(arp: ArpState | undefined): number[] {
  if (!arp || arp.mode === 0) return [];
  const seen = new Set<number>();
  for (const step of arp.steps) if (step.on) seen.add(step.offset);
  return [...seen].sort((a, b) => a - b);
}
