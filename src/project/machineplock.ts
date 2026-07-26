/**
 * Parameter-lock ids on the **machine-dependent** pages.
 *
 * The SYN pages and FLTR page 1 change with the selected machine, and so do their lock ids:
 * **the same id means a different parameter on a different machine.** An id alone is therefore
 * meaningless in this range — a reader must know the track's machine first. That is the single
 * most important thing this table records, and it changes what an editor has to model.
 *
 * Measured on 2026-07-26 from pattern H2 of `MORNING_JA 1640(2).dn2prj`, which captured four
 * machines on four tracks of one pattern, each control locked on its own step. Of the 22 ids
 * that FM TONE and WAVETONE both use, **all 22 name different parameters**. In the filters, id
 * 75 is `RESO` on MULTI-MODE and `FDBK` on COMB-, and id 73 is `TYPE` versus `LPF`.
 *
 * By contrast the machine-*independent* ids in `plockparams.ts` are absolute: 1..31 for the
 * LFOs, and 77, 82..85, 87..106 for the fixed pages.
 *
 * Note that FLTR page 1 and page 2 **interleave**: page 1 uses 73..76 and 78..81, while 77 is
 * page 2's `DEL` and is absolute. So the machine-relative ids are not one contiguous span, and
 * anything that treats them as 33..81 will mis-resolve `DEL`.
 */

/** A control on a machine page: its id, where it sits, and what the device calls it. */
export interface MachinePlock {
  id: number;
  /** `SYN 1`..`SYN 4` or `FLTR 1`. */
  page: string;
  /** Knob A..H. */
  knob: string;
  /** The device's abbreviation, or undefined where it was not read off the screen. */
  name?: string;
}

/**
 * FM TONE. Ids 33..72, with 42 and 57..65 unused by this machine — 42 belongs to a control
 * WAVETONE has and FM TONE does not.
 *
 * SYN page 2's names were not captured, so its eight ids are recorded by position only. That is
 * deliberate: an id with a position is useful, an id with a guessed name is worse than nothing.
 */
export const FM_TONE_PLOCKS: readonly MachinePlock[] = [
  { id: 33, page: "SYN 1", knob: "A", name: "ALGO" },
  { id: 34, page: "SYN 1", knob: "B", name: "RATIO C" },
  { id: 35, page: "SYN 1", knob: "C", name: "RATIO A" },
  { id: 36, page: "SYN 1", knob: "D", name: "RATIO B" },
  { id: 37, page: "SYN 1", knob: "E", name: "HARM" },
  { id: 38, page: "SYN 1", knob: "F", name: "DTUN" },
  { id: 39, page: "SYN 1", knob: "G", name: "FDBK" },
  { id: 40, page: "SYN 1", knob: "H", name: "MIX" },
  { id: 43, page: "SYN 2", knob: "A" },
  { id: 44, page: "SYN 2", knob: "B" },
  { id: 45, page: "SYN 2", knob: "C" },
  { id: 46, page: "SYN 2", knob: "D" },
  { id: 47, page: "SYN 2", knob: "E" },
  { id: 48, page: "SYN 2", knob: "F" },
  { id: 49, page: "SYN 2", knob: "G" },
  { id: 50, page: "SYN 2", knob: "H" },
  { id: 51, page: "SYN 3", knob: "A", name: "ADEL" },
  { id: 52, page: "SYN 3", knob: "B", name: "ATRG" },
  { id: 53, page: "SYN 3", knob: "C", name: "ARST" },
  // Out of sequence: PHRT is id 41 while its page neighbours are 51..56.
  { id: 41, page: "SYN 3", knob: "D", name: "PHRT" },
  { id: 54, page: "SYN 3", knob: "E", name: "BDEL" },
  { id: 55, page: "SYN 3", knob: "F", name: "BTRG" },
  { id: 56, page: "SYN 3", knob: "G", name: "BRST" },
  // SYN 3 knob H is blank on the device.
  { id: 66, page: "SYN 4", knob: "A", name: "FTUN C" },
  { id: 67, page: "SYN 4", knob: "B", name: "FTUN A" },
  { id: 68, page: "SYN 4", knob: "C", name: "FTUN B1" },
  { id: 69, page: "SYN 4", knob: "D", name: "FTUN B2" },
  // SYN 4 knob E is blank on the device.
  { id: 70, page: "SYN 4", knob: "F", name: "KTRK A" },
  { id: 71, page: "SYN 4", knob: "G", name: "KTRK B1" },
  { id: 72, page: "SYN 4", knob: "H", name: "KTRK B2" },
];

/**
 * WAVETONE. Ids **33..55 with no gaps** — 23 controls, 23 consecutive ids.
 *
 * The order is the machine's own, not page order: `TBL1` from SYN page 2 takes id 35, between
 * SYN page 1's `WAV1` and `PD1`. So an id cannot be derived from a knob position even within
 * one machine.
 */
export const WAVETONE_PLOCKS: readonly MachinePlock[] = [
  { id: 33, page: "SYN 1", knob: "A", name: "TUN1" },
  { id: 34, page: "SYN 1", knob: "B", name: "WAV1" },
  { id: 37, page: "SYN 1", knob: "C", name: "PD1" },
  { id: 38, page: "SYN 1", knob: "D", name: "TBL1" },
  { id: 39, page: "SYN 1", knob: "E", name: "TUN2" },
  { id: 40, page: "SYN 1", knob: "F", name: "WAV2" },
  { id: 43, page: "SYN 1", knob: "G", name: "PD2" },
  { id: 44, page: "SYN 1", knob: "H", name: "TBL2" },
  { id: 36, page: "SYN 2", knob: "A", name: "OFS1" },
  { id: 35, page: "SYN 2", knob: "B", name: "TBL1" },
  { id: 45, page: "SYN 2", knob: "C", name: "MOD" },
  { id: 47, page: "SYN 2", knob: "D", name: "RSET" },
  { id: 42, page: "SYN 2", knob: "E", name: "OFS2" },
  { id: 41, page: "SYN 2", knob: "F", name: "TBL2" },
  // SYN 2 knob G is blank on the device.
  { id: 46, page: "SYN 2", knob: "H", name: "DRIF" },
  { id: 48, page: "SYN 3", knob: "A", name: "ATK" },
  { id: 49, page: "SYN 3", knob: "B", name: "HOLD" },
  { id: 50, page: "SYN 3", knob: "C", name: "DEC" },
  { id: 51, page: "SYN 3", knob: "D", name: "NLEV" },
  { id: 52, page: "SYN 3", knob: "E", name: "BASE" },
  { id: 53, page: "SYN 3", knob: "F", name: "WDTH" },
  { id: 54, page: "SYN 3", knob: "G", name: "TYPE" },
  { id: 55, page: "SYN 3", knob: "H", name: "CHAR" },
];

/** FLTR MULTI-MODE. Ids 73..76 and 78..81; 77 belongs to FLTR page 2's `DEL`. */
export const MULTI_MODE_PLOCKS: readonly MachinePlock[] = [
  { id: 78, page: "FLTR 1", knob: "A", name: "ATK" },
  { id: 79, page: "FLTR 1", knob: "B", name: "DEC" },
  { id: 80, page: "FLTR 1", knob: "C", name: "SUS" },
  { id: 81, page: "FLTR 1", knob: "D", name: "REL" },
  { id: 74, page: "FLTR 1", knob: "E", name: "FREQ" },
  { id: 75, page: "FLTR 1", knob: "F", name: "RESO" },
  { id: 73, page: "FLTR 1", knob: "G", name: "TYPE" },
  { id: 76, page: "FLTR 1", knob: "H", name: "ENV" },
];

/** FLTR COMB-. Same ids as MULTI-MODE, and two of them mean something else. */
export const COMB_MINUS_PLOCKS: readonly MachinePlock[] = [
  { id: 78, page: "FLTR 1", knob: "A", name: "ATK" },
  { id: 79, page: "FLTR 1", knob: "B", name: "DEC" },
  { id: 80, page: "FLTR 1", knob: "C", name: "SUS" },
  { id: 81, page: "FLTR 1", knob: "D", name: "REL" },
  { id: 74, page: "FLTR 1", knob: "E", name: "FREQ" },
  { id: 75, page: "FLTR 1", knob: "F", name: "FDBK" },
  { id: 73, page: "FLTR 1", knob: "G", name: "LPF" },
  { id: 76, page: "FLTR 1", knob: "H", name: "ENV" },
];

/** Machines whose ids have been measured. Keyed by the name the device shows. */
export const MACHINE_PLOCKS: Readonly<Record<string, readonly MachinePlock[]>> = {
  "FM TONE": FM_TONE_PLOCKS,
  WAVETONE: WAVETONE_PLOCKS,
  "MULTI-MODE": MULTI_MODE_PLOCKS,
  "COMB-": COMB_MINUS_PLOCKS,
};

/** Machines the DN2 offers that have **not** been captured. Their ids are unknown. */
export const UNCAPTURED_MACHINES: readonly string[] = [
  "FM DRUM",
  "SWARMER",
  "LOWPASS 4",
  "LEGACY LP/HP",
  "COMB+",
  "EQUALIZER",
];

/**
 * The id range whose meaning depends on the machine.
 *
 * Below 33 and above 81 the ids are absolute. Inside it, resolving one without knowing the
 * machine is not possible — which is why `machinePlock` takes the machine as an argument and
 * has no single-argument form.
 */
export const MACHINE_RELATIVE_IDS: readonly { from: number; to: number }[] = [
  { from: 33, to: 76 },
  { from: 78, to: 81 },
];

/**
 * True when an id's meaning depends on the track's machine.
 *
 * The two ranges exist because of one exception: **77 is absolute** — it is FLTR page 2's `DEL`
 * — and it sits in the middle of FLTR page 1's run. Writing this as a single 33..81 span is
 * wrong, and a test caught exactly that.
 */
export function isMachineRelative(id: number): boolean {
  return MACHINE_RELATIVE_IDS.some((r) => id >= r.from && id <= r.to);
}

/** Resolve an id **for a given machine**. Undefined when the machine has not been captured. */
export function machinePlock(machine: string, id: number): MachinePlock | undefined {
  return MACHINE_PLOCKS[machine]?.find((p) => p.id === id);
}
