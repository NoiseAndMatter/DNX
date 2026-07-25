/**
 * DN1 -> DN2 sound object field mapping.
 *
 * The Digitone 1 has no selectable machines: one FM engine per synth track, whose direct
 * Digitone II equivalent is FM TONE. So every DN1 synth sound converts to exactly one DN2
 * sound, with no machine dispatch, and the conversion reduces to a field remap between a
 * 302-byte DN1 sound object and a 359-byte DN2 sound object.
 *
 * ## How this table was derived
 *
 * Elektron ships nine DN2 projects that are their own conversions of nine DN1 projects
 * (see `docs/sound-mapping.md` for the file pairing). In every one of them, DN1 kit sound
 * `i` lands in DN2 kit sound slot `i` for `i` in 0..3, and DN1 sound-pool slot `i` lands in
 * DN2 sound-pool slot `i` — confirmed by 128/128 kit-name and 128/128 pool-name agreement
 * on all nine pairs. That yields 9 x (128 x 4 + 128) = 5,760 aligned sound pairs.
 *
 * Three whole projects (`053 TECNO_EXP`, `031 DROWSY_WALK`, `051 ODD XS`) were held out and
 * never inspected while deriving. The remaining six contain 368 distinct (DN1, DN2) sound
 * pairs after deduplication — most kit slots across a project are untouched defaults.
 *
 * For every DN2 byte offset `j`, the derivation kept the set of DN1 offsets `i` where
 * `dn1[i] === dn2[j]` held in **all 368 pairs**, after normalising the version field (DN1
 * project sounds carry version 5, DN2 kit and pool sounds carry version 2). Requiring the
 * source byte to actually vary across the corpus left exactly one candidate for 139 DN2
 * offsets and zero ambiguity anywhere — a wrong source would have been eliminated by the
 * first pair that disagreed with it. No rescaling of any copied field was found.
 *
 * Twenty-five DN2 offsets vary but are explained by no DN1 offset directly. Every one of
 * them is a single-byte selector that is a **pure function** of one DN1 byte, and twenty-two
 * of them share one common value table (`SELECTOR_TABLE`) with zero conflicts across 8,096
 * observations. The remaining three have their own small tables.
 *
 * The remaining DN2 offsets hold the same value in all 368 pairs and are treated as DN2
 * defaults (`DEFAULT_BYTES` plus an implicit zero fill).
 *
 * ## Validation
 *
 * Run against the three held-out projects, the map built from the six derivation projects
 * alone got 2,067,833 of 2,067,840 bytes right (99.99966%), with 1,914 of 1,920 sounds
 * byte-exact. The 7 wrong bytes were not noise: each was a field that never left its
 * default in the derivation corpus. They are accounted for in `VALIDATION_COPIES` and in
 * one extra `SCALAR_FIELDS` entry, after which all nine projects — 5,760 sounds,
 * 2,067,840 bytes — reproduce exactly. `test/soundmap.test.ts` asserts that.
 *
 * See `docs/sound-mapping.md` for per-offset evidence and for what remains unexplained.
 */

/** Size of a sound object inside a DN1 project image. */
export const DN1_SOUND_SIZE = 302;

/** Size of a sound object inside a DN2 project image. */
export const DN2_SOUND_SIZE = 359;

/** Version field value of a sound object stored in a DN1 project. */
export const DN1_PROJECT_SOUND_VERSION = 5;

/** Version field value of a sound object stored in a DN2 project (kit slots and pool). */
export const DN2_PROJECT_SOUND_VERSION = 2;

/** Byte offset of the 16-byte sound name. Same on both families. */
export const SOUND_NAME_OFFSET = 12;
export const SOUND_NAME_SIZE = 16;

/**
 * Sound-pool offsets relative to each family's `ImageLayout.tailBase`.
 *
 * Both tails open with a u32be version word followed by 128 sound objects, except that the
 * DN2 tail puts a complete 10,752-byte kit record first. Verified on all nine DN2 payloads:
 * 128 correctly framed sound objects at `tailBase + 10756`, names matching the DN1 pool
 * 128/128 in every pair.
 */
export const DN1_POOL_OFFSET = 4;
export const DN2_POOL_OFFSET = 10_756;
export const POOL_SOUND_COUNT = 128;

/** An entry in a copy table: `[dn2Offset, dn1Offset]`. */
export type CopyEntry = readonly [number, number];

/**
 * Byte copies proven by the derivation corpus.
 *
 * Each entry survived all 368 derivation pairs as the only DN1 offset that could explain
 * that DN2 offset, and its DN1 source takes more than one value in the corpus, so the
 * agreement is not vacuous.
 */
export const VERIFIED_COPIES: readonly CopyEntry[] = [
  [8, 8], [9, 9], [10, 10], [11, 11], [30, 30], [31, 31],
  [32, 32], [33, 33], [38, 34], [40, 36], [46, 38], [48, 40],
  [62, 46], [64, 48], [70, 50], [72, 52], [78, 54], [80, 56],
  [86, 58], [87, 59], [88, 60], [89, 61], [94, 62], [96, 64],
  [98, 66], [100, 68], [101, 69], [102, 70], [103, 71], [104, 72],
  [105, 73], [106, 74], [108, 76], [110, 78], [114, 82], [116, 84],
  [118, 86], [120, 88], [122, 90], [124, 92], [126, 94], [128, 96],
  [130, 98], [132, 100], [134, 102], [136, 104], [138, 106], [140, 108],
  [142, 110], [168, 274], [170, 275], [172, 276], [176, 130], [177, 131],
  [178, 132], [179, 133], [180, 134], [181, 135], [184, 136], [186, 138],
  [188, 140], [190, 142], [192, 277], [194, 144], [195, 145], [196, 146],
  [202, 148], [206, 150], [208, 152], [210, 154], [211, 155], [212, 166],
  [213, 167], [214, 164], [215, 165], [216, 162], [217, 163], [218, 158],
  [220, 160], [221, 161], [224, 168], [226, 170], [228, 172], [236, 156],
  [237, 157], [246, 188], [250, 279], [251, 280], [252, 190], [255, 193],
  [258, 196], [261, 199], [264, 202], [267, 205], [273, 211], [276, 214],
  [277, 215], [279, 217], [280, 218], [282, 220], [283, 221], [285, 223],
  [286, 224], [288, 226], [291, 229], [294, 232], [297, 235], [300, 238],
  [301, 239], [303, 241], [304, 242], [306, 244], [309, 247], [324, 281],
  [326, 283], [328, 285], [330, 287], [331, 250], [333, 252], [334, 253],
  [335, 254], [336, 255], [337, 256], [338, 257], [339, 258], [340, 259],
  [341, 260], [342, 261], [343, 262], [344, 263], [345, 264], [346, 265],
  [347, 266], [348, 267], [349, 268], [350, 269], [351, 270], [352, 271],
  [353, 272],
];

/**
 * Byte copies completed by structure rather than proven by observation.
 *
 * Both sides of each of these entries hold the same single value throughout the derivation
 * corpus, so the corpus cannot distinguish "copied" from "DN2 default that happens to
 * match". Two structural rules pick them out:
 *
 * 1. **u16 high byte.** Sound parameters are a u16le array from offset 28. Wherever an even
 *    DN1 offset `i` is a proven copy to an even DN2 offset `j`, the high byte `i + 1` is
 *    completed to `j + 1`. Every proven pair in the corpus obeys this (`[86, 58]`/`[87, 59]`,
 *    `[176, 130]`/`[177, 131]`, `[212, 166]`/`[213, 167]`, and so on) with no counterexample.
 * 2. **Modulation triples.** DN2 `252 + 3k` for k in 0..19 is a run of 3-byte records copied
 *    from DN1 `190 + 3k`. Nineteen of the twenty first bytes and six of the second bytes are
 *    proven copies; the rest are completed to the same shape.
 *
 * Applying these changes nothing on any observed sound — output is byte-identical with or
 * without them — but preserves data for DN1 sounds outside the paired corpus. Two entries
 * carry real risk because their DN1 source does vary across the wider 53-project DN1
 * corpus: `[229, 173]` (dn1[173] takes 0 or 32) and `[270, 208]` (dn1[208] takes 0 or 56).
 * Neither can be confirmed without a matched pair that exercises them.
 */
export const INFERRED_COPIES: readonly CopyEntry[] = [
  [39, 35], [41, 37], [47, 39], [49, 41], [63, 47], [65, 49],
  [71, 51], [73, 53], [79, 55], [81, 57], [95, 63], [97, 65],
  [99, 67], [107, 75], [109, 77], [111, 79], [115, 83], [117, 85],
  [119, 87], [121, 89], [123, 91], [125, 93], [127, 95], [129, 97],
  [131, 99], [133, 101], [135, 103], [137, 105], [139, 107], [141, 109],
  [143, 111], [185, 137], [187, 139], [189, 141], [191, 143], [197, 147],
  [203, 149], [207, 151], [209, 153], [219, 159], [225, 169], [227, 171],
  [229, 173], [247, 189], [253, 191], [256, 194], [259, 197], [262, 200],
  [265, 203], [268, 206], [270, 208], [271, 209], [274, 212], [289, 227],
  [292, 230], [295, 233], [298, 236], [307, 245], [310, 248],
];

/**
 * Copies recovered by diagnosing the held-out validation failures.
 *
 * The map built from the six derivation projects alone reproduced the three held-out
 * projects to 7 wrong bytes out of 2,067,840. Every one of those bytes was a field that
 * simply never left its default in the derivation corpus. Diagnosing them yielded this
 * block, which then held with zero mismatches across all 5,760 pairs in all nine projects:
 *
 * - DN1 174..181 (four u16le, default `0x0040`) -> DN2 160..167. This settles which four of
 *   the twelve `0x0040` u16le slots at DN2 144..167 belong to them: the last four.
 *   Directly evidenced by dn1[175] = 115, dn1[176] = 32 and dn1[181] = 47 in three sounds.
 * - DN1 182..183 -> DN2 182..183, evidenced by dn1[182] = 50 in two sounds.
 *
 * These are honest facts about the corpus, but note the provenance: unlike
 * `VERIFIED_COPIES` they were not confirmed on data withheld from their own derivation, and
 * the varying ones rest on one or two sounds each.
 */
export const VALIDATION_COPIES: readonly CopyEntry[] = [
  [160, 174], [161, 175], [162, 176], [163, 177],
  [164, 178], [165, 179], [166, 180], [167, 181],
  [182, 182], [183, 183],
];

/** Every copy applied by the converter. */
export const COPY_MAP: readonly CopyEntry[] = [
  ...VERIFIED_COPIES,
  ...INFERRED_COPIES,
  ...VALIDATION_COPIES,
];

/**
 * DN2 bytes that hold a fixed non-zero value in all 368 derivation pairs and are explained
 * by no DN1 field. Offsets absent from this list and from `COPY_MAP` / `SELECTOR_FIELDS` /
 * `SCALAR_FIELDS` / the name field are zero in every pair.
 *
 * 0..3 and 355..358 are the object magic and terminator; 7 is the version field.
 */
export const DEFAULT_BYTES: readonly CopyEntry[] = [
  [0, 0xbe], [1, 0xef], [2, 0xba], [3, 0xce], [7, DN2_PROJECT_SOUND_VERSION],
  [34, 0x70], [42, 0x03], [50, 0x40], [90, 0x40],
  [144, 0x40], [146, 0x40], [148, 0x40], [150, 0x40], [152, 0x40], [154, 0x40],
  [156, 0x40], [158, 0x40],
  [198, 0x01], [204, 0x7f], [222, 0x01], [249, 0x01],
  [355, 0xba], [356, 0xce], [357, 0xf0], [358, 0x0c],
];

/**
 * Single-byte selector fields: DN2 offset, DN1 offset. The stored value is an index into
 * some device-internal list whose DN2 numbering differs from DN1's, so it is remapped
 * through `SELECTOR_TABLE` rather than copied.
 *
 * The first two sit in the head of the parameter array; the other twenty are the third byte
 * of the twenty 3-byte records at DN2 252 / DN1 190. The DN2 numbering is a superset of the
 * DN1 numbering over most of the range (a constant +16 shift through the middle) but is not
 * monotone at the top, so no arithmetic rule fits and a table is required.
 *
 * What these selectors mean is not established. Their shape — one byte per modulation
 * record, drawn from a list of about 70 entries — is consistent with a modulation
 * destination or parameter id.
 */
export const SELECTOR_FIELDS: readonly CopyEntry[] = [
  [54, 42], [56, 44],
  [254, 192], [257, 195], [260, 198], [263, 201], [266, 204], [269, 207],
  [272, 210], [275, 213], [278, 216], [281, 219], [284, 222], [287, 225],
  [290, 228], [293, 231], [296, 234], [299, 237], [302, 240], [305, 243],
  [308, 246], [311, 249],
];

/**
 * DN1 selector value -> DN2 selector value.
 *
 * Built from all 22 selector fields at once: 8,096 observations, every DN1 value mapping to
 * one DN2 value, zero conflicts between fields. Support is uneven — 0 -> 0 appears 7,037
 * times while several entries rest on a single sound — but no entry is contradicted.
 * Twenty-two of the forty-nine entries are corroborated by more than one field.
 */
export const SELECTOR_TABLE: ReadonlyMap<number, number> = new Map([
  [0, 0], [1, 1], [2, 2], [3, 5], [4, 6], [5, 9], [9, 17], [10, 18], [11, 21],
  [15, 29], [16, 30], [17, 33], [18, 34], [19, 35], [20, 36], [21, 37], [22, 38],
  [23, 39], [24, 40], [27, 43], [29, 45], [30, 46], [32, 48], [34, 50], [42, 58],
  [43, 59], [44, 60], [45, 61], [46, 62], [49, 65], [51, 74], [52, 75], [53, 76],
  [54, 78], [55, 79], [57, 81], [58, 83], [59, 84], [60, 87], [61, 89], [62, 90],
  [63, 91], [64, 104], [65, 95], [66, 96], [67, 94], [68, 93], [69, 92], [73, 66],
]);

/**
 * Fields that are a function of one DN1 byte through their own small table.
 *
 * `dn1[128]` drives two unrelated DN2 bytes at once and its domain (0..3) is fully covered
 * by the wider 53-project DN1 corpus, so those two tables are complete. `dn1[251]` has
 * domain 0..15 in the wider corpus, of which 10 values are observed here.
 */
export interface ScalarField {
  dn2Offset: number;
  dn1Offset: number;
  table: ReadonlyMap<number, number>;
}

export const SCALAR_FIELDS: readonly ScalarField[] = [
  { dn2Offset: 174, dn1Offset: 128, table: new Map([[0, 3], [1, 0], [2, 1], [3, 0]]) },
  { dn2Offset: 245, dn1Offset: 128, table: new Map([[0, 4], [1, 4], [2, 4], [3, 1]]) },
  {
    dn2Offset: 332,
    dn1Offset: 251,
    // [2, 4] came from the held-out set: two ODD XS sounds carry dn1[251] = 2.
    table: new Map([
      [0, 0], [2, 4], [6, 9], [8, 12], [9, 13], [10, 14], [11, 16], [12, 17], [13, 18], [14, 19],
      [15, 20],
    ]),
  },
];

/**
 * DN1 offsets that no DN2 offset receives, and that hold a value other than zero in at
 * least one of the 1,102 distinct DN1 sounds across all 53 DN1 projects. These are the
 * honest gaps: real settings the converter drops. They affect 4 of those 1,102 sounds.
 *
 * DN1 112..127 (eight u16le, `0x0040`) is also unclaimed and its natural home is the eight
 * remaining `0x0040` u16le slots at DN2 144..159, by analogy with DN1 174..181 -> DN2
 * 160..167. That is not asserted here because those sixteen bytes hold `40 00` in all 1,102
 * DN1 sounds, so writing them changes nothing and cannot be checked either way.
 */
export const DROPPED_DN1_OFFSETS: readonly number[] = [284, 286];

/** How a converted byte got its value. */
export type FieldProvenance = "verified" | "inferred" | "interpolated" | "unmapped";

export interface ConversionWarning {
  dn1Offset: number;
  dn2Offset: number;
  value: number;
  kind: FieldProvenance;
  detail: string;
}

export interface SoundConversion {
  sound: Uint8Array;
  warnings: ConversionWarning[];
}

export class SoundMapError extends Error {}

/**
 * Map one selector value.
 *
 * Values absent from `SELECTOR_TABLE` are filled in when the nearest mapped neighbour below
 * and the nearest above share the same DN2-minus-DN1 delta. That covers 25, 26, 28, 31, 33,
 * 35..41, 47, 48 and 56, all inside +16 or +24 runs. Anything else — 6..8, 12..14, 50, 70..72
 * and everything above 73 — is passed through unchanged and reported, because the table is
 * not monotone at the top of its range and guessing there would put an arbitrary destination
 * into a sound written to hardware.
 */
export function mapSelector(value: number): { value: number; kind: FieldProvenance } {
  const direct = SELECTOR_TABLE.get(value);
  if (direct !== undefined) return { value: direct, kind: "verified" };

  let below = -1;
  let above = -1;
  for (const key of SELECTOR_TABLE.keys()) {
    if (key < value && key > below) below = key;
    if (key > value && (above === -1 || key < above)) above = key;
  }
  if (below !== -1 && above !== -1) {
    const deltaBelow = SELECTOR_TABLE.get(below)! - below;
    const deltaAbove = SELECTOR_TABLE.get(above)! - above;
    if (deltaBelow === deltaAbove) return { value: value + deltaBelow, kind: "interpolated" };
  }
  return { value, kind: "unmapped" };
}

/**
 * Convert a 302-byte DN1 sound object into a 359-byte DN2 sound object, reporting every
 * field whose value did not come from a proven mapping.
 */
export function convertDn1SoundToDn2Detailed(dn1: Uint8Array): SoundConversion {
  if (dn1.length !== DN1_SOUND_SIZE) {
    throw new SoundMapError(`Expected a ${DN1_SOUND_SIZE}-byte DN1 sound, got ${dn1.length}`);
  }
  if (dn1[0] !== 0xbe || dn1[1] !== 0xef || dn1[2] !== 0xba || dn1[3] !== 0xce) {
    throw new SoundMapError("DN1 sound does not start with the BEEFBACE object magic");
  }

  const out = new Uint8Array(DN2_SOUND_SIZE);
  for (const [offset, value] of DEFAULT_BYTES) out[offset] = value;

  // The name is copied only up to its NUL terminator. DN1 leaves the bytes after the
  // terminator as residue from whatever name the slot held before; DN2 clears them.
  // Verified on all 368 derivation pairs.
  for (let i = 0; i < SOUND_NAME_SIZE; i++) {
    const c = dn1[SOUND_NAME_OFFSET + i]!;
    if (c === 0) break;
    out[SOUND_NAME_OFFSET + i] = c;
  }

  for (const [dn2Offset, dn1Offset] of COPY_MAP) out[dn2Offset] = dn1[dn1Offset]!;

  const warnings: ConversionWarning[] = [];

  for (const [dn2Offset, dn1Offset] of SELECTOR_FIELDS) {
    const raw = dn1[dn1Offset]!;
    const mapped = mapSelector(raw);
    out[dn2Offset] = mapped.value;
    if (mapped.kind !== "verified") {
      warnings.push({
        dn1Offset,
        dn2Offset,
        value: raw,
        kind: mapped.kind,
        detail:
          mapped.kind === "interpolated"
            ? `selector ${raw} interpolated to ${mapped.value} from equal neighbouring deltas`
            : `selector ${raw} is absent from SELECTOR_TABLE and was passed through unchanged`,
      });
    }
  }

  for (const field of SCALAR_FIELDS) {
    const raw = dn1[field.dn1Offset]!;
    const mapped = field.table.get(raw);
    if (mapped === undefined) {
      out[field.dn2Offset] = raw;
      warnings.push({
        dn1Offset: field.dn1Offset,
        dn2Offset: field.dn2Offset,
        value: raw,
        kind: "unmapped",
        detail: `value ${raw} is absent from the table for dn2[${field.dn2Offset}] and was passed through unchanged`,
      });
    } else {
      out[field.dn2Offset] = mapped;
    }
  }

  // Every inferred copy reads zero throughout the derivation corpus, so a non-zero value
  // here is a case the matched pairs never exercised.
  for (const [dn2Offset, dn1Offset] of INFERRED_COPIES) {
    const value = dn1[dn1Offset]!;
    if (value === 0) continue;
    warnings.push({
      dn1Offset,
      dn2Offset,
      value,
      kind: "inferred",
      detail: `dn1[${dn1Offset}] = ${value} was written to dn2[${dn2Offset}] by a structural rule that no matched pair exercises`,
    });
  }

  for (const dn1Offset of DROPPED_DN1_OFFSETS) {
    const value = dn1[dn1Offset]!;
    if (value === 0) continue;
    warnings.push({
      dn1Offset,
      dn2Offset: -1,
      value,
      kind: "unmapped",
      detail: `dn1[${dn1Offset}] = ${value} has no known DN2 destination and was dropped`,
    });
  }

  return { sound: out, warnings };
}

/** Convert a 302-byte DN1 sound object into a 359-byte DN2 sound object. */
export function convertDn1SoundToDn2(dn1: Uint8Array): Uint8Array {
  return convertDn1SoundToDn2Detailed(dn1).sound;
}
