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
 * selected machine and have their own, machine-relative ids — see `machineplock.ts`.
 */

import { LFO_SLOTS } from "./lfoslots.js";

/**
 * How the coarse byte should be read. See `lockvalue.ts`.
 *
 * **`fine` used to be a fourth value here and that was the bug.** Resolution is independent of
 * polarity: `SPD` and `DEP` are bipolar *and* carry a fine byte, and one word could not say so.
 * `lfoslots.ts` records how two tables describing these controls came to disagree.
 */
export type PlockKind = "unipolar" | "bipolar" | "enum";

export interface PlockParameter {
  id: number;
  /** The page as the device labels it. */
  page: string;
  /** The abbreviation the device shows. */
  name: string;
  kind: PlockKind;
  /**
   * True when a fine byte sits beside the coarse one.
   *
   * Only the LFO slots have been measured for this. Absent elsewhere means unmeasured rather than
   * known-absent, which is why it is optional rather than defaulted to false.
   */
  fine?: boolean;
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
 * Verified on all 24 observed ids with no exceptions, and **independently confirmed from the
 * firmware's own translation table**: the forward map at `0x401fcf20` in OS 1.11 carries slots
 * 1..8 to 1, 5, 9, 13, 17, 21, 25, 29 and slots 9..16 to 2, 6, 10, 14, 18, 22, 26, 30. Two
 * methods with no shared assumption, same rule.
 *
 * **The lane at `4 * slot + 0` — ids 0, 4, 8, 12, 16, 20, 24, 28 — is padding, not reserved
 * space.** It was tempting to read it as room for a fourth LFO, and the sound object has a
 * matching unused fourth slot in each group of eight, which looked like corroboration. It is not:
 * both layers round three up to four, which is what alignment does every time, so the two
 * observations are one convention seen twice rather than two sources agreeing.
 *
 * Settled by measurement rather than by argument. The firmware's inverse map at `0x401fd0b0`
 * folds **every** lane-0 id onto slot 0, the same no-lock sentinel as the known gaps at 65, 100
 * and 104. Nothing in OS 1.11 can address a fourth LFO's locks. Read from the image by the
 * firmware session on 2026-09-16; corroborated from that side rather than measured here.
 */
export const LFO_STRIDE = 4;

/**
 * The eight slots come from `lfoslots.ts`, shared with `soundparams.ts`.
 *
 * They were described separately once, and the ternary that used to stand here classified `FADE`
 * and `MULT` by falling through to its default branch: it asserted `unipolar` for a bipolar
 * control and for a 24-value enumeration, because nobody had written a case for either. This file
 * now contributes the ids and nothing else.
 */
function lfoParameters(): PlockParameter[] {
  const out: PlockParameter[] = [];
  for (let slot = 0; slot < LFO_SLOTS.length; slot++) {
    for (let lfo = 1; lfo <= 3; lfo++) {
      const { name, polarity, fine } = LFO_SLOTS[slot]!;
      out.push({
        id: LFO_STRIDE * slot + lfo,
        page: `MOD ${lfo} (LFO ${lfo})`,
        name,
        kind: polarity,
        ...(fine ? { fine: true } : {}),
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
 * What is left unaccounted for, now that the machine pages have been captured.
 *
 * The prediction that 32..76 held the machine pages was right in substance: they occupy 33..76
 * and 78..81, and their ids are **machine-relative** — see `machineplock.ts`. What remains:
 *
 *   32        never observed on any page or machine
 *   63..65    inside the SYN range but claimed by no captured machine
 *   86        between FLTR 2's RSET (85) and the AMP envelope (87)
 *
 * Down from twelve: FM DRUM's capture claimed 42 and 57..62, exactly filling holes FM TONE left.
 * That is what the SYN id space looks like — a shared pool each machine draws from densely, where
 * one machine's gap is another's control. 63..65 may belong to a machine variant not captured, or
 * to nothing.
 */
export const UNMAPPED_IDS: readonly number[] = [32, 63, 64, 65, 86];

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
