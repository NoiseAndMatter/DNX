/**
 * What a parameter-lock id means.
 *
 * A lock record's first byte is an id, and nothing in the file says which control it is. This
 * table names them, so an editor can show what a lock does rather than "parameter 89 = 55".
 *
 * Derived from a device-authored capture on 2026-07-26 (`docs/dn2-capture-plan.md`): 61
 * controls, each locked on its **own step** of one pattern, so a record's single locked step
 * names it by position. 47 records came back, every one with exactly one locked step and no
 * ambiguity. The design tolerated two deliberate gaps and twelve controls that turned out not
 * to use the lock table at all, without any of it disturbing the mapping.
 *
 * These are the **machine-independent** pages. The SYN pages and FLTR page 1 vary with the
 * selected machine and are not covered — see the note on `UNMAPPED_ID_RANGE` below.
 */

/** How the coarse byte should be read. See `lockvalue.ts`. */
export type PlockKind = "unipolar" | "bipolar" | "enum" | "fine";

export interface PlockParameter {
  id: number;
  /** The page as the device labels it. */
  page: string;
  /** The abbreviation the device shows. */
  name: string;
  kind: PlockKind;
  /** True when the id was not observed directly — see each entry's note. */
  inferred?: boolean;
}

/**
 * The three LFOs are **interleaved with a stride of 4**, not stored one after another.
 *
 *     id = 4 * slot + lfo        slot 0..7 in page order, lfo 1..3
 *
 *     SPD  1  2  3      DEST 13 14 15      MODE 25 26 27
 *     MULT 5  6  7      WAVE 17 18 19      DEP  29 30 31
 *     FADE 9 10 11      SPH  21 22 23
 *
 * Verified on all 24 observed ids with no exceptions. Note that `4 * slot + 0` — ids 4, 8, 12,
 * 16, 20, 24, 28 and id 0 — is never used by the three LFOs, so the layout has room for a
 * fourth. Whether that is reserved space or belongs to something else is UNKNOWN.
 */
export const LFO_STRIDE = 4;
const LFO_SLOTS = ["SPD", "MULT", "FADE", "DEST", "WAVE", "SPH", "MODE", "DEP"] as const;
/** `SPD` and `DEP` carry a fine byte; the rest were all observed with fine = 0. */
const LFO_FINE = new Set(["SPD", "DEP"]);

function lfoParameters(): PlockParameter[] {
  const out: PlockParameter[] = [];
  for (let slot = 0; slot < LFO_SLOTS.length; slot++) {
    for (let lfo = 1; lfo <= 3; lfo++) {
      const name = LFO_SLOTS[slot]!;
      out.push({
        id: LFO_STRIDE * slot + lfo,
        page: `MOD ${lfo} (LFO ${lfo})`,
        name,
        kind: LFO_FINE.has(name) ? "fine" : name === "WAVE" || name === "MODE" || name === "DEST" ? "enum" : "unipolar",
      });
    }
  }
  return out;
}

export const PLOCK_PARAMETERS: readonly PlockParameter[] = [
  ...lfoParameters(),

  // TRIG page 2. Only these two of its six controls use the lock table.
  { id: 99, page: "TRIG 2", name: "PORT", kind: "unipolar" },
  { id: 100, page: "TRIG 2", name: "PTIM", kind: "unipolar" },

  { id: 77, page: "FLTR 2", name: "DEL", kind: "unipolar" },
  { id: 82, page: "FLTR 2", name: "KEY.T", kind: "unipolar" },
  { id: 83, page: "FLTR 2", name: "BASE", kind: "unipolar" },
  { id: 84, page: "FLTR 2", name: "WDTH", kind: "unipolar" },
  { id: 85, page: "FLTR 2", name: "RSET", kind: "enum" },
  { id: 105, page: "FLTR 2", name: "BW.RT", kind: "enum" },

  // The AMP envelope runs 87..91 in page order, with 88 the only gap — see AMP_HOLD_ID.
  { id: 87, page: "AMP", name: "ATK", kind: "unipolar" },
  { id: 88, page: "AMP", name: "HOLD", kind: "unipolar", inferred: true },
  { id: 89, page: "AMP", name: "DEC", kind: "unipolar" },
  { id: 90, page: "AMP", name: "SUS", kind: "unipolar" },
  { id: 91, page: "AMP", name: "REL", kind: "unipolar" },
  { id: 95, page: "AMP", name: "PAN", kind: "bipolar" },
  { id: 96, page: "AMP", name: "VOL", kind: "unipolar" },
  { id: 97, page: "AMP", name: "MODE", kind: "enum", inferred: true },
  { id: 98, page: "AMP", name: "RSET", kind: "enum" },

  { id: 92, page: "FX", name: "CHR", kind: "unipolar" },
  { id: 93, page: "FX", name: "DEL", kind: "unipolar" },
  { id: 94, page: "FX", name: "REV", kind: "unipolar" },
  { id: 101, page: "FX", name: "BR", kind: "unipolar" },
  { id: 102, page: "FX", name: "SRR", kind: "unipolar" },
  { id: 103, page: "FX", name: "SR.RT", kind: "enum" },
  { id: 104, page: "FX", name: "OVER", kind: "unipolar" },
  { id: 106, page: "FX", name: "OD.RT", kind: "enum" },
];

/**
 * Controls that are **not** in the lock table, confirmed by the same capture.
 *
 * Each was locked on its own step and produced no record at all, because these live in their
 * own per-step arrays inside the track record rather than the shared lock pool — the trigger
 * slot holds note, velocity and length; the track record holds probability and the two trig
 * condition arrays. A reader looking for them in the lock table will never find them.
 *
 * `LFO.T`, `FLT.T`, `FILL`, `RTRG`, `VFAD`, `RATE` and TRIG 2's `LEN` produced nothing either,
 * and their storage is UNKNOWN — they are not in any array this project has identified.
 */
export const NOT_LOCKABLE: readonly { page: string; name: string }[] = [
  { page: "TRIG 1", name: "NOTE" },
  { page: "TRIG 1", name: "VEL" },
  { page: "TRIG 1", name: "LEN" },
  { page: "TRIG 1", name: "PROB" },
  { page: "TRIG 1", name: "LFO.T" },
  { page: "TRIG 1", name: "FLT.T" },
  { page: "TRIG 1", name: "FILL" },
  { page: "TRIG 1", name: "COND" },
  { page: "TRIG 2", name: "RTRG" },
  { page: "TRIG 2", name: "VFAD" },
  { page: "TRIG 2", name: "LEN" },
  { page: "TRIG 2", name: "RATE" },
];

/**
 * Ids 32..76 are unaccounted for, and that is where the machine pages almost certainly live.
 *
 * Everything named above sits in 1..31 (the LFOs) or 77..106. The SYN pages and FLTR page 1
 * were deliberately excluded from the capture because they change with the selected machine,
 * and 45 free ids is about the right size for them. INFERRED from the gap, not observed.
 */
export const UNMAPPED_ID_RANGE = { from: 32, to: 76 } as const;

const BY_ID = new Map(PLOCK_PARAMETERS.map((p) => [p.id, p]));

/** Name a lock id, or `undefined` when it is not one this capture reached. */
export function plockParameter(id: number): PlockParameter | undefined {
  return BY_ID.get(id);
}

/** One line for a UI or a diff: `MOD 1 (LFO 1) DEP`. */
export function describePlock(id: number): string | undefined {
  const p = BY_ID.get(id);
  return p && `${p.page} ${p.name}`;
}
