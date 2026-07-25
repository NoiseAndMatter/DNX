/**
 * DN1 -> DN2 value translation tables for pattern data.
 *
 * The two devices agree on structure but not on enumerations. Parameter-lock ids and trig
 * conditions are renumbered, non-linearly, so both need lookup tables rather than
 * arithmetic.
 *
 * Both tables were derived the same way: fourteen DN1 projects sit beside Elektron's own
 * DN2 conversions of them, and the DN1 side is fully decoded, so each DN1 value can be read
 * off against the DN2 value the importer produced at the same table position and step. Every
 * entry below is unanimous across the corpus — **zero ambiguous mappings** in either table,
 * over 959 lock records and 1,714 conditioned trigs.
 *
 * Values not in these tables were never exercised by the corpus. They are UNKNOWN, not
 * identity: `translateParameterId` and `translateTrigCondition` return undefined so the
 * caller can flag them. Guessing would write a plausible-looking wrong knob to hardware.
 *
 * ## Coverage
 *
 * **Complete for this library.** Measured across all 53 DN1 projects, every parameter id and
 * every trig condition that appears anywhere is mapped: 58 of 58 parameter ids and 35 of 35
 * conditions.
 *
 * That took fourteen matched pairs rather than nine. The first nine covered only 85.5% of
 * lock records; converting the Elektron factory project plus four others chosen by greedy
 * set cover closed the remaining 31 values. Values outside this library may still exist, so
 * the undefined-return contract stays.
 */

/**
 * Parameter-lock ids. Derived from 959 lock records across fourteen matched projects.
 *
 * Note the non-monotonicity: 64 -> 104 sits above 65 -> 95, and 67/68/69 map to 94/93/92 in
 * reverse. No arithmetic rule fits; this has to be a table.
 */
const PARAMETER_ID_MAP = new Map<number, number>([
  [1, 1],
  [2, 2],
  [3, 5],
  [4, 6],
  [5, 9],
  [6, 10],
  [7, 13],
  [8, 14],
  [9, 17],
  [10, 18],
  [11, 21],
  [12, 22],
  [13, 25],
  [14, 26],
  [15, 29],
  [16, 30],
  [17, 33],
  [18, 34],
  [19, 35],
  [20, 36],
  [21, 37],
  [22, 38],
  [23, 39],
  [24, 40],
  [25, 41],
  [27, 43],
  [28, 44],
  [29, 45],
  [30, 46],
  [31, 47],
  [32, 48],
  [33, 49],
  [34, 50],
  [35, 51],
  [38, 54],
  [50, 73],
  [51, 74],
  [52, 75],
  [53, 76],
  [54, 78],
  [55, 79],
  [56, 80],
  [57, 81],
  [58, 83],
  [59, 84],
  [60, 87],
  [61, 89],
  [62, 90],
  [63, 91],
  [64, 104],
  [65, 95],
  [66, 96],
  [67, 94],
  [68, 93],
  [69, 92],
  [70, 98],
  [71, 99],
  [72, 100],
]);

/** The DN2 parameter id for a DN1 one, or undefined when the corpus never exercised it. */
export function translateParameterId(dn1Parameter: number): number | undefined {
  return PARAMETER_ID_MAP.get(dn1Parameter);
}

/** Every DN1 parameter id we can translate, for reporting coverage. */
export function knownParameterIds(): number[] {
  return [...PARAMETER_ID_MAP.keys()].sort((a, b) => a - b);
}

/**
 * Where a translated trig condition lands.
 *
 * The DN1 keeps one condition byte per step. The DN2 splits the same information across
 * three parallel arrays in the track record, and which array is used depends on the kind of
 * condition:
 *
 * - DN1 6..21  are probabilities and land in `probability` as a percentage, 19..100.
 * - DN1 22..23 land in `conditionAlt` as 1 and 0.
 * - DN1 24..42 land in `condition` as a renumbered code.
 *
 * Exactly one field is set; the other two stay 0xFF.
 */
export interface TranslatedCondition {
  condition: number;
  conditionAlt: number;
  probability: number;
}

/** 0xFF in all three arrays means "no condition on this step". */
export const NO_CONDITION: TranslatedCondition = {
  condition: 0xff,
  conditionAlt: 0xff,
  probability: 0xff,
};

/** Derived from 1,714 conditioned trigs across fourteen matched projects. */
const CONDITION_MAP = new Map<number, TranslatedCondition>([
  [5, { condition: 0xff, conditionAlt: 0xff, probability: 13 }],
  [6, { condition: 0xff, conditionAlt: 0xff, probability: 19 }],
  [7, { condition: 0xff, conditionAlt: 0xff, probability: 25 }],
  [8, { condition: 0xff, conditionAlt: 0xff, probability: 33 }],
  [9, { condition: 0xff, conditionAlt: 0xff, probability: 41 }],
  [10, { condition: 0xff, conditionAlt: 0xff, probability: 50 }],
  [11, { condition: 0xff, conditionAlt: 0xff, probability: 59 }],
  [12, { condition: 0xff, conditionAlt: 0xff, probability: 67 }],
  [13, { condition: 0xff, conditionAlt: 0xff, probability: 75 }],
  [14, { condition: 0xff, conditionAlt: 0xff, probability: 81 }],
  [15, { condition: 0xff, conditionAlt: 0xff, probability: 87 }],
  [21, { condition: 0xff, conditionAlt: 0xff, probability: 100 }],
  [22, { condition: 0xff, conditionAlt: 1, probability: 0xff }],
  [23, { condition: 0xff, conditionAlt: 0, probability: 0xff }],
  [24, { condition: 0, conditionAlt: 0xff, probability: 0xff }],
  [25, { condition: 1, conditionAlt: 0xff, probability: 0xff }],
  [26, { condition: 2, conditionAlt: 0xff, probability: 0xff }],
  [27, { condition: 3, conditionAlt: 0xff, probability: 0xff }],
  [28, { condition: 4, conditionAlt: 0xff, probability: 0xff }],
  [29, { condition: 5, conditionAlt: 0xff, probability: 0xff }],
  [30, { condition: 8, conditionAlt: 0xff, probability: 0xff }],
  [31, { condition: 9, conditionAlt: 0xff, probability: 0xff }],
  [32, { condition: 10, conditionAlt: 0xff, probability: 0xff }],
  [33, { condition: 12, conditionAlt: 0xff, probability: 0xff }],
  [34, { condition: 14, conditionAlt: 0xff, probability: 0xff }],
  [35, { condition: 16, conditionAlt: 0xff, probability: 0xff }],
  [36, { condition: 18, conditionAlt: 0xff, probability: 0xff }],
  [37, { condition: 20, conditionAlt: 0xff, probability: 0xff }],
  [38, { condition: 22, conditionAlt: 0xff, probability: 0xff }],
  [40, { condition: 26, conditionAlt: 0xff, probability: 0xff }],
  [41, { condition: 28, conditionAlt: 0xff, probability: 0xff }],
  [42, { condition: 30, conditionAlt: 0xff, probability: 0xff }],
  [61, { condition: 68, conditionAlt: 0xff, probability: 0xff }],
  [63, { condition: 72, conditionAlt: 0xff, probability: 0xff }],
  [64, { condition: 74, conditionAlt: 0xff, probability: 0xff }],
]);

/**
 * Translate a DN1 trig condition, or undefined when it was never observed.
 *
 * Gaps remain in the numbering (16..20, 39, 43..60, 62) simply because no project uses those
 * values. Do not interpolate across them: the observed steps are uneven — probabilities
 * advance by roughly 8 points but 13 -> 15 jumps 12, and condition codes step by 1 up to 29
 * then by 2 — so an interpolated value would be a guess dressed up as arithmetic.
 */
export function translateTrigCondition(dn1Condition: number): TranslatedCondition | undefined {
  return CONDITION_MAP.get(dn1Condition);
}

/** Every DN1 trig condition we can translate, for reporting coverage. */
export function knownTrigConditions(): number[] {
  return [...CONDITION_MAP.keys()].sort((a, b) => a - b);
}
