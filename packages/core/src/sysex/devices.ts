/**
 * Elektron device and dump-type identifiers for the classic SysEx "dump" protocol.
 *
 * Framing: F0 00 20 3C <productId> <devId> <dumpType> <ver:2> <objNr> ...
 *
 * This is a different ID space from the "Transfer" protocol (header byte 0x10), which
 * addresses devices as 20 = Digitone, 43 = Digitone II and moves whole opaque
 * .dnprj/.dn2prj files over the +Drive filesystem.
 */

export const ELEKTRON_MANUFACTURER_ID = [0x00, 0x20, 0x3c] as const;

export const ProductId = {
  /** Digitone / Digitone Keys. Corroborated by libdigitone and digitools. */
  DN1: 0x0d,
  /**
   * Digitone II. Established here by inspecting real DN2 pattern dumps; it does not
   * appear in any public source at time of writing.
   */
  DN2: 0x15,
} as const;

export type ProductId = (typeof ProductId)[keyof typeof ProductId];

export const PRODUCT_NAMES: Record<number, string> = {
  [ProductId.DN1]: "Digitone",
  [ProductId.DN2]: "Digitone II",
};

/**
 * Dump type byte. Values follow the Elektron family convention of a 0x50 base for
 * dumps and 0x60 for the matching requests.
 *
 * **All five are confirmed against real captures on both instruments.** Ten combinations, every
 * one of them counted from files rather than assumed from the Digitakt table this convention was
 * originally read off. The counts are in `docs/sysex-format.md` and
 * `test/dumptypes.test.ts` recomputes them from the corpus, so this comment cannot drift from the
 * files again.
 */
export const DumpType = {
  PATTERN_KIT: 0x50,
  PATTERN: 0x51,
  KIT: 0x52,
  SOUND: 0x53,
  PROJECT_SETTINGS: 0x54,
} as const;

export type DumpType = (typeof DumpType)[keyof typeof DumpType];

export const DUMP_TYPE_NAMES: Record<number, string> = {
  [DumpType.PATTERN_KIT]: "Pattern+Kit",
  [DumpType.PATTERN]: "Pattern",
  [DumpType.KIT]: "Kit",
  [DumpType.SOUND]: "Sound",
  [DumpType.PROJECT_SETTINGS]: "ProjectSettings",
};

/**
 * Combinations seen in real files, used to flag anything unexpected during inspection.
 *
 * **This set was wrong for months and the error escaped the repository.** It listed two entries
 * while the corpus held ten, so `inspect` reported an ordinary Digitone II Sound dump as an
 * "unconfirmed product/type combination", and a reader who trusted it concluded that a Digitone II
 * might not speak `0x53` at all — 1,008 captures say otherwise. `test/dumptypes.test.ts` now walks
 * every capture and fails when one is seen that is not listed here, which is the only way a table
 * like this stays true.
 */
const CONFIRMED = new Set<string>([
  `${ProductId.DN1}:${DumpType.PATTERN_KIT}`,
  `${ProductId.DN1}:${DumpType.PATTERN}`,
  `${ProductId.DN1}:${DumpType.KIT}`,
  `${ProductId.DN1}:${DumpType.SOUND}`,
  `${ProductId.DN1}:${DumpType.PROJECT_SETTINGS}`,
  `${ProductId.DN2}:${DumpType.PATTERN_KIT}`,
  `${ProductId.DN2}:${DumpType.PATTERN}`,
  `${ProductId.DN2}:${DumpType.KIT}`,
  `${ProductId.DN2}:${DumpType.SOUND}`,
  `${ProductId.DN2}:${DumpType.PROJECT_SETTINGS}`,
]);

/**
 * Digitone dump types seen in real captures that nothing has named yet.
 *
 * Held apart from `CONFIRMED` on purpose: these are bytes we have observed, not messages we
 * understand. Listing them keeps the test honest without pretending to know what they carry.
 */
export const UNNAMED_DN1_TYPES = [0x58, 0x59, 0x5a, 0x5b] as const;

export function isConfirmedCombination(productId: number, dumpType: number): boolean {
  return CONFIRMED.has(`${productId}:${dumpType}`);
}

export function describeProduct(productId: number): string {
  return PRODUCT_NAMES[productId] ?? `unknown product 0x${productId.toString(16).padStart(2, "0")}`;
}

export function describeDumpType(dumpType: number): string {
  return DUMP_TYPE_NAMES[dumpType] ?? `unknown type 0x${dumpType.toString(16).padStart(2, "0")}`;
}
