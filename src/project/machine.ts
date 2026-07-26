/**
 * The machine a sound uses — one byte inside the 359-byte sound object.
 *
 * Found 2026-07-26 by diffing pattern A6 of the device-authored capture, where three tracks
 * were switched to different machines, against a pattern where every track is FM TONE. A
 * machine change rewrites a couple of dozen bytes of the sound object (the new machine's
 * parameter defaults), but only **seven** offsets move for all three machines at once, and only
 * one of those is a small enum taking a distinct value per machine.
 *
 * Confirmed independently on the matched corpus: across 12,288 sound slots of Elektron's own
 * DN1 conversions this byte takes exactly two values, 0 on 9,216 of them and 4 on 3,072 — which
 * is precisely four slots in every kit, the four the DN1's MIDI tracks land on. The capture
 * agrees: its MIDI-machine track reads 4.
 *
 * The numbering is **not** the device's menu order (which shows FM TONE, FM DRUM, WAVETONE,
 * SWARMER). Values 5 and up have not been observed; the DN2's machine list is longer than what
 * this capture covered, so treat an unknown value as unknown rather than assuming a name.
 */

/** Offset of the machine byte, relative to the start of a sound object. */
export const SOUND_MACHINE_OFFSET = 244;

export const MACHINE = {
  fmTone: 0,
  wavetone: 1,
  fmDrum: 2,
  swarmer: 3,
  /** A MIDI track's slot. Every DN1 MIDI track lands on one of these. */
  midi: 4,
} as const;

const NAMES = new Map<number, string>([
  [MACHINE.fmTone, "FM TONE"],
  [MACHINE.wavetone, "WAVETONE"],
  [MACHINE.fmDrum, "FM DRUM"],
  [MACHINE.swarmer, "SWARMER"],
  [MACHINE.midi, "MIDI"],
]);

/** The machine's name, or `undefined` for a value this capture never saw. */
export function machineName(value: number): string | undefined {
  return NAMES.get(value);
}

/** Read the machine byte out of a 359-byte sound object. */
export function machineOf(sound: Uint8Array): number {
  return sound[SOUND_MACHINE_OFFSET]!;
}
