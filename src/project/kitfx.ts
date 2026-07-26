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
 */

/** How the coarse byte should be read. Bipolar values are stored offset by +64. */
export type FxKind = "unipolar" | "bipolar" | "enum";

export interface FxParameter {
  /** Offset of the coarse byte, relative to the start of the DN2 kit record. */
  offset: number;
  page: "chorus" | "delay" | "reverb" | "compressor";
  /** The abbreviation the device shows. */
  name: string;
  kind: FxKind;
  /** Notes where the device's range is not a plain 0-127. */
  note?: string;
}

/**
 * The 31 parameters the capture placed, in page order.
 *
 * Gaps between pages are real: nothing was observed at 5840, and 5856-5880 sits between the
 * reverb and compressor pages with no parameter yet attached to it, though the copy table does
 * transfer bytes there.
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
