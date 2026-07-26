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
 * PATTERN_KIT (0x50) and SOUND (0x53) are confirmed against real files. KIT (0x52) is
 * corroborated independently: elk-herd implements Digitakt Kit Request 0x62 / Kit Response 0x52
 * as working message types, so the convention holds on a sibling device even though no file we
 * hold uses it. See docs/references.md. The others
 * follow the documented Digitakt table and are unverified for Digitone — do not rely
 * on them without checking against a real dump.
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

/** Combinations seen in real files, used to flag anything unexpected during inspection. */
const CONFIRMED = new Set<string>([
  `${ProductId.DN1}:${DumpType.SOUND}`,
  `${ProductId.DN2}:${DumpType.PATTERN_KIT}`,
]);

export function isConfirmedCombination(productId: number, dumpType: number): boolean {
  return CONFIRMED.has(`${productId}:${dumpType}`);
}

export function describeProduct(productId: number): string {
  return PRODUCT_NAMES[productId] ?? `unknown product 0x${productId.toString(16).padStart(2, "0")}`;
}

export function describeDumpType(dumpType: number): string {
  return DUMP_TYPE_NAMES[dumpType] ?? `unknown type 0x${dumpType.toString(16).padStart(2, "0")}`;
}
