/**
 * The eight LFO slots, described once.
 *
 * ## Why this file exists
 *
 * Two modules described the same eight controls and **disagreed about three of them**.
 * `soundparams.ts` reads them out of a sound object by offset; `plockparams.ts` names them by lock
 * id. Both needed to know what a stored byte means, so both grew their own answer, and the two
 * drifted exactly as `docs/PRINCIPLES.md` §4 says two copies of one thing always do:
 *
 * | slot | `soundparams` said | `plockparams` said | measured |
 * |---|---|---|---|
 * | SPD | bipolar | fine | bipolar **and** fine |
 * | MULT | enum | unipolar | enum, 0..23 |
 * | FADE | bipolar | unipolar | bipolar |
 * | DEP | fine | fine | bipolar **and** fine |
 *
 * **Neither could have been right**, because each carried a single value for two independent
 * facts. A control is unipolar, bipolar or an enumeration, *and* separately it either has a fine
 * byte beside it or it does not. `SPD` and `DEP` are both, and there was nowhere to say so.
 * `plockparams` got `FADE` and `MULT` wrong by falling through the default branch of a ternary,
 * which is how a table ends up asserting something nobody ever decided.
 *
 * ## Where the numbers come from
 *
 * Counted across the corpus: 53,248 sound records, 159,744 readings of each slot. `restsAt` is the
 * value the overwhelming majority of records hold, which is what identifies polarity — a bipolar
 * control stored as `value + 64` sits at 64 when it is doing nothing, a unipolar one sits at 0.
 *
 * `SPD` is the one that does not announce itself that way: it rests at **112**, which is `+48`
 * read as bipolar and is the factory default speed. Its polarity is inherited from
 * `soundparams.ts`, which had it before this file existed, rather than re-derived here.
 *
 * **The `fine` column is independently confirmed from the firmware.** OS 1.11 carries a
 * fine-resolution flag at `+0x14` of each parameter record, and reading it for these eight
 * reproduces the corpus count exactly: `SPD` and `DEP` set, `FADE` clear. Two methods with
 * nothing in common — 159,744 readings of what instruments wrote, against a flag in the firmware
 * that decides it — reaching the same answer. Read from the image by the firmware session on
 * 2026-09-16.
 */

/** What a stored byte means. Separate from resolution: a control can be bipolar *and* fine. */
export type LfoPolarity = "unipolar" | "bipolar" | "enum";

export interface LfoSlot {
  /** As the instrument labels it on the MOD pages. */
  name: string;
  polarity: LfoPolarity;
  /** True when a fine byte sits beside the coarse one, carrying 1/128 of a step each. */
  fine: boolean;
  /** Coarse-byte range observed across the corpus, inclusive. */
  range: readonly [number, number];
  /** The value almost every record holds, and the reason `polarity` reads as it does. */
  restsAt: number;
}

/**
 * In page order, which is the order both the sound object and the lock table step through.
 *
 * The sound object lays them out as `30 + 8 * slot + 2 * lfo`; the lock table interleaves the same
 * eight as `4 * slot + lfo`. Different strides, same order, so this index serves both.
 */
export const LFO_SLOTS: readonly LfoSlot[] = [
  { name: "SPD", polarity: "bipolar", fine: true, range: [0, 127], restsAt: 112 },
  { name: "MULT", polarity: "enum", fine: false, range: [0, 23], restsAt: 3 },
  { name: "FADE", polarity: "bipolar", fine: false, range: [0, 127], restsAt: 64 },
  { name: "DEST", polarity: "enum", fine: false, range: [0, 104], restsAt: 0 },
  { name: "WAVE", polarity: "enum", fine: false, range: [0, 6], restsAt: 0 },
  { name: "SPH", polarity: "unipolar", fine: false, range: [0, 127], restsAt: 0 },
  { name: "MODE", polarity: "enum", fine: false, range: [0, 4], restsAt: 0 },
  { name: "DEP", polarity: "bipolar", fine: true, range: [0, 127], restsAt: 64 },
] as const;

/** Slot names in page order, for callers that only need the labels. */
export const LFO_SLOT_NAMES: readonly string[] = LFO_SLOTS.map((s) => s.name);

/** One slot by name, or `undefined` for a name the LFO pages do not carry. */
export function lfoSlot(name: string): LfoSlot | undefined {
  return LFO_SLOTS.find((s) => s.name === name);
}

/**
 * **`FADE` is the only bipolar slot without a fine byte.** That much is measured and holds.
 *
 * It was briefly a lead for something else and **that lead is dead**, recorded here because a
 * falsified hypothesis left lying around gets picked up again by the next reader.
 *
 * The firmware session is hunting why `FADE` draws a widget the other LFO controls do not, and no
 * predicate naming its parameter ids has ever been found. Since this combination is unique to
 * `FADE` on the page, the widget might have been selected from the value encoding, which would
 * explain the absent predicate. **It is not.** `ENV` on the filter page carries the identical
 * encoding — maximum 127, default 64, no fine byte — and draws an ordinary bipolar knob, as do
 * `GAIN`, `DEC` and `REL`. Three identical encodings, three different widgets, so the encoding is
 * not doing the selecting.
 *
 * What survives is the one-way half: every *fine* parameter checked draws a plain knob. The
 * converse fails.
 */
export const BIPOLAR_WITHOUT_FINE = LFO_SLOTS.filter((s) => s.polarity === "bipolar" && !s.fine);
