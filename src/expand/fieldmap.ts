/**
 * DN1 -> DN2 offset correspondences for fields that are copied rather than translated.
 *
 * Distinct from translate.ts, which renumbers *values*. Here the value is carried across
 * unchanged and only its position moves, because the DN2's structures are wider than the
 * DN1's and fields sit at different offsets inside them.
 *
 * Every entry was derived the same way: hold the DN1 byte against the DN2 byte Elektron's
 * own importer produced, across the fourteen matched pairs, and keep only correspondences
 * that hold for **every** sample. A byte that is constant across the whole corpus cannot be
 * located this way — but it also does not need to be, since transferring a constant is a
 * no-op. Those are listed as such rather than guessed at.
 *
 * This matters because anything not copied here silently inherits the conversion template's
 * value. That failure mode has already produced two audible bugs (pattern scale mode, track
 * levels), so the omissions below are recorded explicitly rather than left implicit.
 */

/** A byte copied from one offset to another, both relative to their block's start. */
export interface FieldCopy {
  from: number;
  to: number;
  /** What the field is, where known. Empty when only its correspondence is established. */
  name?: string;
}

/**
 * Per-track settings: DN1 16 bytes at `track+0x3C0`, DN2 35 bytes at `track+0x480`.
 *
 * Derived from 4,816 track samples. Of the sixteen DN1 bytes:
 *
 * - **nine vary and are uniquely located** — the entries below.
 * - **three are constant** on the DN1 (`+0x00` = 6, `+0x0B` = 0, `+0x0F` = 0) so there is
 *   nothing to transfer.
 * - **four vary but have no consistent DN2 destination** (`+0x01`, `+0x06`, `+0x08`,
 *   `+0x0A`). Either the importer drops them or they land outside the settings block. They
 *   are NOT guessed at; see UNPLACED_TRACK_SETTINGS.
 *
 * Two DN2 bytes (`+0x0E`, `+0x14`) vary with no DN1 source at all, so they are DN2-only and
 * correctly left to the template.
 */
export const TRACK_SETTINGS_MAP: readonly FieldCopy[] = [
  { from: 0x02, to: 0x00, name: "default note" },
  { from: 0x03, to: 0x01, name: "default velocity" },
  { from: 0x04, to: 0x02, name: "default note length" },
  { from: 0x05, to: 0x11 },
  { from: 0x07, to: 0x05 },
  { from: 0x09, to: 0x12 },
  { from: 0x0c, to: 0x0d, name: "track length in steps" },
  { from: 0x0d, to: 0x0f, name: "track speed" },
  { from: 0x0e, to: 0x10 },
];

/**
 * DN1 track-settings bytes that vary across the corpus but have no consistent home in the
 * DN2 settings block. Recorded so the gap is visible rather than forgotten.
 */
export const UNPLACED_TRACK_SETTINGS: readonly number[] = [0x01, 0x06, 0x08, 0x0a];

/**
 * Kit-level FX: the delay, chorus and reverb DEVICE settings, as distinct from the per-sound
 * send amounts, which live in the sound object and already convert correctly.
 *
 * DN1 kit+0x4D4, 122 bytes. `to` is relative to the start of the DN2 kit record, and the
 * destinations land at 5810..5881 — inside the region an earlier audit could only describe
 * as "kit gap 5804-5963, unidentified".
 *
 * Derived from 602 kit samples. Of the 122 DN1 bytes: **49 vary and are uniquely located**
 * (below), 66 are constant across the whole corpus so there is nothing to transfer, and 7
 * vary with no consistent destination (see UNPLACED_FX_BYTES). The destination offsets are
 * not a constant shift — gaps at DN1 +0x0A, +0x13, +0x25 and others mean the DN2 block has
 * fields the DN1 lacks, so this has to be a table.
 */
export const KIT_FX_MAP: readonly FieldCopy[] = [
  { from: 0x06, to: 5810 },
  { from: 0x07, to: 5811 },
  { from: 0x08, to: 5812 },
  { from: 0x09, to: 5813 },
  { from: 0x0c, to: 5816 },
  { from: 0x0d, to: 5817 },
  { from: 0x0e, to: 5818 },
  { from: 0x0f, to: 5819 },
  { from: 0x10, to: 5820 },
  { from: 0x11, to: 5821 },
  { from: 0x12, to: 5822 },
  { from: 0x16, to: 5824 },
  { from: 0x17, to: 5825 },
  { from: 0x18, to: 5826 },
  { from: 0x1a, to: 5828 },
  { from: 0x1b, to: 5829 },
  { from: 0x1c, to: 5830 },
  { from: 0x1d, to: 5831 },
  { from: 0x1e, to: 5832 },
  { from: 0x1f, to: 5833 },
  { from: 0x20, to: 5834 },
  { from: 0x21, to: 5835 },
  { from: 0x22, to: 5836 },
  { from: 0x23, to: 5837 },
  { from: 0x24, to: 5838 },
  { from: 0x26, to: 5842 },
  { from: 0x27, to: 5843 },
  { from: 0x28, to: 5844 },
  { from: 0x29, to: 5845 },
  { from: 0x2a, to: 5846 },
  { from: 0x2c, to: 5848 },
  { from: 0x2d, to: 5849 },
  { from: 0x2e, to: 5850 },
  { from: 0x2f, to: 5851 },
  { from: 0x30, to: 5852 },
  { from: 0x31, to: 5853 },
  { from: 0x32, to: 5854 },
  { from: 0x38, to: 5862 },
  { from: 0x3c, to: 5864 },
  { from: 0x3e, to: 5866 },
  { from: 0x3f, to: 5867 },
  { from: 0x40, to: 5868 },
  { from: 0x41, to: 5869 },
  { from: 0x42, to: 5870 },
  { from: 0x43, to: 5871 },
  { from: 0x44, to: 5872 },
  { from: 0x45, to: 5873 },
  { from: 0x4a, to: 5880 },
  { from: 0x4b, to: 5881 },
];

/** DN1 FX bytes that vary but have no consistent DN2 home. Recorded, not guessed. */
export const UNPLACED_FX_BYTES: readonly number[] = [0x34, 0x36, 0x37, 0x3a, 0x46, 0x47, 0x4c];

/**
 * MIDI track configuration: DN1 172 bytes at `kit+0x54E`, DN2 268 bytes at `kit+5964`.
 *
 * DN1 MIDI track *n* lands on DN2 track *4+n*, the same positional rule the pattern records
 * follow. Both `to` and `from` are relative to their own record.
 *
 * Derived from 7,168 record samples — 14 matched pairs x 128 kits x 4 MIDI tracks. Of the 18
 * DN2 bytes that vary across the corpus, 14 have exactly one DN1 source that agrees on every
 * sample, three are ambiguous and resolved below, and one has no DN1 source at all.
 *
 * Until this existed a DN1 project's MIDI channels and CC assignments were dropped entirely —
 * about 3,072 bytes per project, the largest single gap in the conversion.
 */
export const MIDI_TRACK_MAP: readonly FieldCopy[] = [
  { from: 0, to: 30 },
  { from: 1, to: 31 },
  { from: 2, to: 32 },
  { from: 4, to: 38 },
  { from: 16, to: 62 },
  { from: 28, to: 86 },
  { from: 29, to: 87 },
  { from: 32, to: 94 },
  // Ambiguous by value — dn1[34], [36] and [38] hold the same value as each other in all
  // 7,168 samples, so the corpus cannot tell them apart. Both sides run at stride 2, and the
  // positional assignment holds on every sample; the alternative orderings do too, which is
  // exactly why this is INFERRED rather than verified. Nothing observed changes either way.
  { from: 34, to: 96 },
  { from: 36, to: 98 },
  { from: 38, to: 100 },
  { from: 48, to: 110 },
  { from: 50, to: 112 },
  { from: 64, to: 142, name: "CC number 1" },
  { from: 66, to: 144, name: "CC number 2" },
  { from: 158, to: 256 },
  { from: 159, to: 257 },
];

/**
 * DN2 MIDI-record bytes with no DN1 source that the importer nevertheless fixes.
 *
 * The 16-byte track name at `+0x0C`: a native DN2 track is named `MIDI 1`..`MIDI 16`, and
 * Elektron's importer **clears it** on every imported MIDI track. Constant in all 7,168
 * samples, and different from what the template holds — the failure mode this file exists to
 * prevent. Only `+12..+17` are non-zero in the template, the rest of the field already being
 * zero on both sides; the whole field is cleared because that is what the name *is*.
 */
export const MIDI_TRACK_CONSTANTS: readonly FieldConstant[] = Array.from(
  { length: 16 },
  (_, i) => ({ at: 12 + i, value: 0 }),
);

/**
 * DN2 MIDI-record byte that varies with no DN1 source: `dn2[54]`, taking 0, 41 and 42.
 * Left to the template rather than guessed, and recorded so the gap stays visible.
 */
export const UNPLACED_MIDI_BYTES: readonly number[] = [54];

/**
 * A byte the importer always writes to a fixed value, which the template gets wrong.
 *
 * Distinct from a copy: there is no DN1 source, either because the DN1 field is constant
 * across the whole corpus or because the DN2 field has no DN1 counterpart at all. Either
 * way the importer's value is the same in every one of its conversions, so writing it is
 * safe and leaving it out means inheriting whatever the template happens to hold.
 *
 * This is the category that made "constant on the DN1, nothing to transfer" a mistake:
 * nothing to transfer is not the same as nothing to write.
 */
export interface FieldConstant {
  at: number;
  value: number;
}

/** Track-settings bytes with no DN1 source that the importer nevertheless fixes. */
export const TRACK_SETTINGS_CONSTANTS: readonly FieldConstant[] = [
  { at: 0x03, value: 6 },
  { at: 0x06, value: 0 },
  { at: 0x07, value: 0 },
  { at: 0x08, value: 0 },
];

/** Kit FX bytes with no DN1 source that the importer nevertheless fixes. */
export const KIT_FX_CONSTANTS: readonly FieldConstant[] = [
  { at: 5808, value: 0 },
  { at: 5957, value: 7 },
];

/** Write a set of fixed values into a block. */
export function applyFieldConstants(
  destination: Uint8Array,
  destinationBase: number,
  constants: readonly FieldConstant[],
): void {
  for (const c of constants) destination[destinationBase + c.at] = c.value;
}

/** Apply a set of copies from one block to another. */
export function applyFieldCopies(
  destination: Uint8Array,
  destinationBase: number,
  source: Uint8Array,
  sourceBase: number,
  copies: readonly FieldCopy[],
): void {
  for (const copy of copies) {
    destination[destinationBase + copy.to] = source[sourceBase + copy.from]!;
  }
}
