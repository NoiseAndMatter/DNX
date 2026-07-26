/**
 * The DN2 kit FX block, by name.
 *
 * Mapped by a device-authored capture on 2026-07-26: a pattern with a distinct value on every
 * FX parameter, diffed against the default. See `docs/dn2-pattern-format.md` §6a.
 *
 * The block is an array of **two-byte slots at a stride of 2 from kit+5810** — a coarse byte
 * carrying the value and a fine byte worth 1/256 beside it, the same shape as a p-lock slot.
 * The device writes zero into every fine byte; only Elektron's importer, which rescales, ever
 * writes a non-zero one. So the offsets below are the coarse bytes, and `offset + 1` is the
 * fine byte of the same parameter.
 *
 * Naming these mattered for two reasons. A differential diff can say "delay FDBK" instead of
 * "kit gap 5804-5963, unidentified", which is most of the work in reading a capture. And the
 * copy table in `expand/fieldmap.ts` becomes auditable: an entry landing on a named parameter
 * can be checked against what the DN1 byte is supposed to be.
 *
 * A second capture on the same day (`DATA_CAPTURE_MI.dn2prj`, pattern A7) placed the external
 * input page, which the first sheet had missed entirely. Fifteen parameters were given fifteen
 * distinct values in one pattern; all fifteen bytes moved and none collided.
 *
 * `IN R level` and `master overdrive` were both set to 127, so values alone could not tell
 * 5860 from 5880. The tie breaks on layout: balance and all three sends occupy **adjacent L/R
 * pairs**, so level does too, making 5858/5860 the pair and leaving 5880 as the overdrive. The
 * corpus agrees — 5880 takes 30 distinct values across 2,176 kits, 5860 only three. Marked
 * INFERRED until a capture sets the overdrive alone.
 */

/** How the coarse byte should be read. Bipolar values are stored offset by +64. */
export type FxKind = "unipolar" | "bipolar" | "enum";

export interface FxParameter {
  /** Offset of the coarse byte, relative to the start of the DN2 kit record. */
  offset: number;
  page: "chorus" | "delay" | "reverb" | "compressor" | "input";
  /** The abbreviation the device shows. */
  name: string;
  kind: FxKind;
  /** Notes where the device's range is not a plain 0-127. */
  note?: string;
}

/**
 * The 43 parameters two captures placed, in page order.
 *
 * The external input page sits physically **between** the reverb and compressor pages
 * (5858-5880) rather than after them, so page order in the UI is not offset order.
 *
 * One slot in that run is still unplaced: **5856**, constant `1` in all 2,176 kits sampled.
 * It is NOT a per-pattern/global switch for these pages. The DN2 has no such setting: the FX,
 * mixer and compressor values live in the pattern's kit unconditionally, which is exactly the
 * structure seen here — one FX block per kit, one kit per pattern. The device's Perform Kit
 * mode makes them behave globally by *not reloading* the kit on a pattern change, and that is
 * runtime state with nothing to store in a file.
 *
 * The mixer page's chorus, delay and reverb levels are **not** separate fields: setting the
 * mixer level moves the corresponding FX page's `VOL` byte. Two views of one parameter.
 */
export const KIT_FX_PARAMETERS: readonly FxParameter[] = [
  { offset: 5_810, page: "chorus", name: "DPTH", kind: "unipolar" },
  { offset: 5_812, page: "chorus", name: "SPD", kind: "unipolar" },
  { offset: 5_814, page: "chorus", name: "HPF", kind: "unipolar" },
  { offset: 5_816, page: "chorus", name: "WDTH", kind: "unipolar" },
  { offset: 5_818, page: "chorus", name: "DEL", kind: "unipolar" },
  { offset: 5_820, page: "chorus", name: "REV", kind: "unipolar" },
  { offset: 5_822, page: "chorus", name: "VOL", kind: "unipolar" },

  { offset: 5_824, page: "delay", name: "TIME", kind: "unipolar" },
  { offset: 5_826, page: "delay", name: "PING-PONG", kind: "enum", note: "0 or 1" },
  { offset: 5_828, page: "delay", name: "WID", kind: "bipolar", note: "-64 to +63" },
  {
    offset: 5_830,
    page: "delay",
    name: "FDBK",
    kind: "unipolar",
    note: "the device skips some integers -- 18 steps straight to 20",
  },
  { offset: 5_832, page: "delay", name: "HPF", kind: "unipolar" },
  { offset: 5_834, page: "delay", name: "LPF", kind: "unipolar" },
  { offset: 5_836, page: "delay", name: "REV", kind: "unipolar" },
  { offset: 5_838, page: "delay", name: "VOL", kind: "unipolar" },

  { offset: 5_842, page: "reverb", name: "PRE", kind: "unipolar" },
  { offset: 5_844, page: "reverb", name: "DEC", kind: "unipolar" },
  { offset: 5_846, page: "reverb", name: "FREQ", kind: "unipolar" },
  { offset: 5_848, page: "reverb", name: "GAIN", kind: "unipolar" },
  { offset: 5_850, page: "reverb", name: "HPF", kind: "unipolar" },
  { offset: 5_852, page: "reverb", name: "LPF", kind: "unipolar" },
  { offset: 5_854, page: "reverb", name: "VOL", kind: "unipolar" },

  { offset: 5_882, page: "compressor", name: "THR", kind: "unipolar" },
  { offset: 5_884, page: "compressor", name: "ATK", kind: "unipolar" },
  { offset: 5_886, page: "compressor", name: "REL", kind: "unipolar" },
  { offset: 5_888, page: "compressor", name: "MUP", kind: "unipolar", note: "displayed 0-24 dB" },
  { offset: 5_890, page: "compressor", name: "RAT", kind: "unipolar" },
  {
    offset: 5_892,
    page: "compressor",
    name: "SCS",
    kind: "enum",
    note: "19 entries: COMP, NOT COMP, TR1..TR16, INLR -- only INLR (18) observed",
  },
  { offset: 5_894, page: "compressor", name: "SCF", kind: "bipolar", note: "-64 to +63" },
  { offset: 5_896, page: "compressor", name: "DRY/CMP", kind: "unipolar" },
  { offset: 5_898, page: "compressor", name: "VOL", kind: "unipolar" },

  // The external input page, mapped 2026-07-26 by a second capture. Laid out as L/R pairs:
  // the left channel's parameter, then the right channel's, then on to the next parameter.
  { offset: 5_858, page: "input", name: "IN L level", kind: "unipolar" },
  { offset: 5_860, page: "input", name: "IN R level", kind: "unipolar" },
  { offset: 5_862, page: "input", name: "IN L balance", kind: "bipolar", note: "-64 to +63" },
  { offset: 5_864, page: "input", name: "IN R balance", kind: "bipolar", note: "-64 to +63" },
  { offset: 5_866, page: "input", name: "IN L chorus send", kind: "unipolar" },
  { offset: 5_868, page: "input", name: "IN R chorus send", kind: "unipolar" },
  { offset: 5_870, page: "input", name: "IN L delay send", kind: "unipolar" },
  { offset: 5_872, page: "input", name: "IN R delay send", kind: "unipolar" },
  { offset: 5_874, page: "input", name: "IN L reverb send", kind: "unipolar" },
  { offset: 5_876, page: "input", name: "IN R reverb send", kind: "unipolar" },
  {
    offset: 5_878,
    page: "input",
    name: "DUAL",
    kind: "enum",
    note: "0 stereo, 1 dual mono -- dual mono splits the page into an L and an R page",
  },
  {
    offset: 5_880,
    page: "input",
    name: "master overdrive",
    kind: "unipolar",
    note: "INFERRED: see the note above on how it was told apart from IN R level",
  },
];

const BY_OFFSET = new Map<number, { parameter: FxParameter; isFine: boolean }>();
for (const parameter of KIT_FX_PARAMETERS) {
  BY_OFFSET.set(parameter.offset, { parameter, isFine: false });
  BY_OFFSET.set(parameter.offset + 1, { parameter, isFine: true });
}

/**
 * Name the byte at a kit offset, coarse or fine, or `undefined` if it is not a placed FX byte.
 */
export function kitFxAt(offset: number): { parameter: FxParameter; isFine: boolean } | undefined {
  return BY_OFFSET.get(offset);
}

/** One line for a diff report: `delay FDBK` or `delay FDBK fine byte`. */
export function describeKitFx(offset: number): string | undefined {
  const hit = BY_OFFSET.get(offset);
  if (!hit) return undefined;
  return `${hit.parameter.page} ${hit.parameter.name}${hit.isFine ? " fine byte" : ""}`;
}
