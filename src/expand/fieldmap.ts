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
  // Found later, by correlating what remained against the whole DN1 block: all three sit at
  // 5804 + their own FX offset, the same rule most of the block above follows.
  { from: 0x37, to: 5859 },
  { from: 0x46, to: 5874 },
  { from: 0x47, to: 5875 },
];

/**
 * DN1 FX bytes that vary but have no consistent DN2 home. Recorded, not guessed.
 *
 * Was seven; `0x34`, `0x37`, `0x46` and `0x47` have since been placed — `0x34` through
 * `FX_COMPRESSOR_VOLUME` below, the other three as ordinary copies in `KIT_FX_MAP`.
 *
 * All three remaining were re-tested on 2026-07-26 against their `5804 +` destinations, now
 * that the input-page capture gave those offsets meaning:
 *
 * - **`0x3A` -> 5862 (`IN L balance`) and `0x4C` -> 5880 (`master overdrive`): rejected.**
 *   `0x3A` maps 0 and 100 alike onto a centred 64; `0x4C` maps its two values onto more than a
 *   dozen different destinations. Noise, not merely unproven.
 * `0x36` was here too, and is now placed — see `INPUT_LEFT_LEVEL`. It needed a project-level
 * flag as well as a per-kit byte, which is why every single-byte search failed on it.
 */
export const UNPLACED_FX_BYTES: readonly number[] = [0x3a, 0x4c];

/**
 * The input's left level: a per-kit byte **gated by a project-level flag**.
 *
 *     kit+5858 = (DN1 tail mixer+0x0E == 0) ? 100 : DN1 FX+0x36
 *
 * VERIFIED on 1,152 of 1,152 kit pairs, with no exceptions.
 *
 * This is the first field in the project that is not a function of one source byte, and it is
 * worth understanding why it hid for so long. `FX+0x36` alone is an exact identity on 1,024
 * pairs and fails on all 128 kits of `053 TECNO_EXP`, where the same source byte 0 produces
 * destination 100. An exhaustive search of all 2,560 bytes of the DN1's per-pattern block found
 * no consistent source, because there is none: the answer was never in that block.
 *
 * The DN1 has no kits — that is a DN2 feature — so nothing required its external-input settings
 * to be per-pattern, and in fact they are not entirely. `tail mixer+0x0E` reads 1 in eight
 * projects and 0 in `TECNO_EXP`, the one project whose output takes the alternate state
 * everywhere. Its meaning on the DN1 is UNKNOWN; only its effect on the conversion is measured.
 *
 * **The `flag == 0` branch rests on a single project.** Unanimous over 1,152 kits, but those
 * 128 alternate-state kits all come from one file. A second DN1 project with the flag clear
 * would settle it.
 */
export const INPUT_LEFT_LEVEL = {
  /** Within the DN1's per-pattern FX block. */
  from: 0x36,
  /** Within the DN1 tail's mixer block. */
  flagAt: 0x0e,
  /** Destination, relative to the DN2 kit record. */
  to: 5_858,
  /** What the importer writes for every kit when the flag is clear. */
  whenFlagClear: 100,
} as const;

/**
 * DN2 input-page bytes that vary in Elektron's output and that no DN1 byte explains.
 *
 * Searched exhaustively: every one of the 2,560 bytes of the DN1's per-pattern block, against
 * all 1,152 kit pairs. Not one is a consistent source for either.
 *
 *   kit+5860  IN R level   0 in 960 kits, 100 in 192
 *   kit+5878  DUAL         1 in 961 kits, 0 in 191
 *
 * Both nearly track `5858`, and neither is a function of it. `5858 = 100` gives `5860 = 100`
 * except once, where `5858 = 6` also gives `5860 = 100`; `DUAL` disagrees with the majority
 * reading in 66 kits spread across projects. So they are a related state, not a derived one.
 *
 * `INPUT_LEFT_LEVEL` above shows the shape of the answer — a per-kit byte gated by a
 * project-level tail flag — and the same shape is the obvious thing to try here next.
 *
 * **Deliberately not written.** A majority-vote constant would be right about 83% of the time
 * and wrong the rest, and `DUAL` changes how the device treats the external input — guessing it
 * is the kind of plausible-looking wrong value this project refuses to send to hardware.
 *
 * The shape of the failures points somewhere specific. `TECNO_EXP` contradicts the `5858`
 * correspondence uniformly, across all 128 of its kits, and the 192/191-kit minorities at
 * `5860` and `5878` are similarly lumpy rather than scattered. That is what a **project-level**
 * source looks like reflected into a per-pattern field. The DN1 stores no kits at all — its
 * per-pattern block is our own analogy — so nothing says the external input has to be
 * per-pattern on that device. **The DN1 tail is where to look next**, not the kit.
 */
export const UNEXPLAINED_INPUT_BYTES: readonly number[] = [5_860, 5_878];

/**
 * A DN1 FX byte the importer rescales onto the DN2's compressor volume.
 *
 * The destination is **two fields, not one number** — corrected 2026-07-26 by a capture the
 * device wrote itself. `kit+5898` is the compressor VOL, a plain 0-127 integer (default 100,
 * read back as 119 after the user set it there), and `kit+5899` is its fine byte, worth 1/256
 * each. The device leaves the fine byte at zero in every pattern of the capture; only
 * Elektron's importer ever writes a non-zero one, because only the importer rescales.
 *
 * The earlier reading here — one `u16be` scaled by "roughly x201.57" — wrote the right bytes
 * for the wrong reason. Every value in the table below is the byte pair Elektron produces.
 *
 * The rescale it performs, on all four observed inputs:
 *
 *     coarse.fine = min( floor(dn1 x 25600 / 127), 25599 ) / 256
 *
 * That is a 0-127 source mapped onto a 0-100 scale, in 1/256 steps, clamped one unit below
 * 100.00. It reproduces 73, 94, 100 and 127 exactly, fine byte included. It is left as a
 * **table rather than a formula** because why a 0-127 source lands on a 0-100 scale is
 * unexplained, and the DN2 plainly accepts 119 here when a human sets it.
 *
 * A value outside the table leaves the destination alone and reports a warning, rather than
 * extrapolating from a rule that is not understood.
 */
export const FX_COMPRESSOR_VOLUME = {
  from: 0x34,
  /** Integer part, relative to the DN2 kit record. */
  coarseAt: 5898,
  /** Fraction in 1/256 steps. Zero in everything the device writes. */
  fineAt: 5899,
  table: new Map<number, readonly [coarse: number, fine: number]>([
    [64, [50, 100]],
    [73, [57, 122]],
    [94, [74, 4]],
    [100, [78, 189]],
    [127, [99, 255]],
  ]),
} as const;

/**
 * Pattern metadata: DN1 trailer at `pattern+0x4724`, DN2 44-byte block at `pattern+0x15AD4`.
 *
 * Offsets are relative to each block's start, and the two blocks share a layout for every
 * field identified so far — name at +0, tempo at +0x12, master length at +0x14, change length
 * at +0x16, scale mode at +0x19, speed at +0x1A. These two are the same story: unanimous
 * across all 1,152 matched pattern pairs, at the same relative offset on both devices.
 *
 * Their meaning is UNKNOWN on both sides. `docs/dn1-project-format.md` §3 lists
 * `0x4735` and `0x473C` among the DN1 trailer bytes that vary with no known purpose; this
 * says where they go, not what they are.
 */
export const PATTERN_META_MAP: readonly FieldCopy[] = [
  { from: 0x11, to: 0x11 },
  { from: 0x18, to: 0x18 },
];

/**
 * Pattern-metadata byte the importer always sets, which no DN1 field explains.
 *
 * `+0x21` reads 7 in all 1,152 records Elektron converted and 1 in all 419 native captures.
 * A template written by the device therefore holds 1, and inheriting it accounted for 768 of
 * the 810 bytes this block used to differ by — the "constant across the corpus is not the
 * same as nothing to write" trap, again.
 */
export const PATTERN_META_CONSTANTS: readonly FieldConstant[] = [{ at: 0x21, value: 7 }];

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
  // Constant in all 1,152 Elektron-converted kits, and named by the input-page capture. No DN1
  // source is needed because there is nothing to vary — but they still have to be *written*,
  // or a template that is not EMPTY leaks its own values through. That distinction is the
  // whole subject of the first section of KNOWN-ISSUES.
  { at: 5814, value: 0 }, // chorus HPF
  { at: 5815, value: 0 }, // chorus HPF, fine byte
  { at: 5856, value: 1 }, // unidentified, but unanimous
  { at: 5857, value: 0 },
  { at: 5876, value: 0 }, // input right reverb send
  // The compressor page. **The DN1 has no compressor** — it is a DN2 feature — so there is
  // nothing to transfer, and every one of these is constant across all 1,152 converted kits,
  // agreeing with both `EMPTY.dn2prj` and the device's own defaults. Writing them reproduces
  // Elektron rather than inheriting whatever compressor a non-blank template happened to have.
  // `VOL` at 5898 is the exception and is handled by `FX_COMPRESSOR_VOLUME`.
  { at: 5882, value: 32 }, // THR
  { at: 5883, value: 0 },
  { at: 5884, value: 24 }, // ATK
  { at: 5885, value: 0 },
  { at: 5886, value: 32 }, // REL
  { at: 5887, value: 0 },
  { at: 5888, value: 64 }, // MUP
  { at: 5889, value: 0 },
  { at: 5890, value: 3 }, // RAT
  { at: 5891, value: 0 },
  { at: 5892, value: 0 }, // SCS
  { at: 5893, value: 0 },
  { at: 5894, value: 80 }, // SCF
  { at: 5895, value: 0 },
  { at: 5896, value: 0 }, // DRY/CMP
  { at: 5897, value: 0 },
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
