/**
 * Where the device was when the project was saved — **VERIFIED on hardware 2026-07-28.**
 *
 * The user noticed a built test project opening on `G2`, the pattern it had been seeded *from*,
 * even though the file puts its reference at `A1`. That should not happen if position is device
 * state, and it turned out the file carries it: our builder inherits the source project's tail
 * **verbatim** — 0 differing bytes of 109,572 — so it inherited the source's saved position too.
 *
 * ## How it was found, and how the first guess was wrong
 *
 * The corpus narrowed it. Asking which tail offsets **vary across projects and always hold a
 * plausible value** produced a candidate pair; two independent properties made them credible.
 * The pattern byte names an *occupied* pattern in 20 of 26 projects, and it **walks forward in
 * capture order** — six `MORNING_JAM` variants exported over one evening read `H1, H2, H3, H3,
 * H4, H4` by timestamp. Nothing else in a project has a reason to be non-decreasing across
 * successive saves.
 *
 * **The track guess was wrong, and plausibility is why.** It landed on `+56_840`, one byte
 * along, which reads 5 everywhere — in the source project and in both later saves. A constant
 * passes "is this a plausible track index?" trivially, so the check could never have failed.
 * The prediction said track 6; the user reported track 1; the byte one position earlier reads
 * 0. **A hypothesis that can only be confirmed by plausible-looking values is not being
 * tested.**
 *
 * ## What settled it
 *
 * A controlled pair, run on the device: the same project saved twice from the same pattern,
 * once on track 1 and once on track 5. **15 bytes** of the 109,572-byte tail differ, and
 * exactly two go `0 -> 4` — `SAVED_TRACK_OFFSET` and its mirror. The pattern byte held at 97
 * across both, which is right, because both saves were made from `G2`.
 *
 * Twelve of the remaining thirteen differing bytes sit at a stride of **359**, the DN2 sound
 * size — one byte in each of twelve consecutive sound-pool entries, going 1 to 0. Unexplained,
 * and recorded rather than guessed at.
 *
 * ## Nothing writes them, deliberately
 *
 * A librarian that rearranged patterns leaves this field pointing at whatever now occupies the
 * old slot — so a project reopens somewhere the user did not leave it. Now that the field is
 * confirmed that is a real defect rather than a hypothetical one, and **it is still not fixed
 * here**: reading is one change and rewriting on every move is another, with its own question
 * (does a moved pattern take the cursor with it, or does the cursor stay put?) that only the user
 * can answer. Recorded in `docs/KNOWN-ISSUES.md`.
 */

import { DN2_LAYOUT, layoutFor } from "./dn2image.js";

/**
 * First byte after the last kit record.
 *
 * The tail is everything the pattern and kit layout does not claim: song data, project settings,
 * and — apparently — this.
 */
export function tailStart(layout = DN2_LAYOUT): number {
  return layout.kitBase + layout.patternCount * layout.kitSize;
}

/**
 * **[verified]** Offset of the saved pattern, relative to the tail.
 *
 * Found by asking which tail offsets vary across the corpus *and* hold a value in 0..127 — the
 * search that works, unlike the first attempt, which looked for one specific value and so could
 * only ever confirm what it already assumed. Confirmed on hardware: a project whose byte reads 97
 * opened on `G2`, and it held at 97 across two further saves both made from `G2`.
 */
export const SAVED_PATTERN_OFFSET = 56_843;

/**
 * **[verified]** Offset of the saved track.
 *
 * Settled by a controlled experiment the user ran: the same project saved twice from the same
 * pattern, once with track 1 selected and once with track 5. Only **15 bytes** of the 109,572-byte
 * tail differ between them, and exactly two go `0 -> 4` — this offset and its mirror.
 *
 * **The first guess was `+56_840`, one byte along, and it was wrong.** That byte reads 5 in the
 * source project *and* in both saves, so it survived a check that only ever asked "is this value
 * plausible for a track?" — a question a constant passes trivially. What caught it was the user
 * reporting the original sat on **track 1** while the prediction said track 6. A hypothesis that
 * can only be confirmed by plausible-looking values is not being tested.
 */
export const SAVED_TRACK_OFFSET = 56_839;

/**
 * **[verified]** A second copy of the saved track, which the device keeps in step.
 *
 * Both bytes moved together in the controlled pair, and they agree in **24 of 24** corpus
 * projects. Read rather than ignored because disagreement would mean the field is not what we
 * think, or that one of the two is something else that merely correlates — and a silent
 * disagreement is exactly the kind of thing that turns into a wrong write later.
 */
export const SAVED_TRACK_MIRROR_OFFSET = 56_920;

export interface SavedPosition {
  /** 0-based pattern index, or `undefined` when the byte is not a possible slot. */
  pattern: number | undefined;
  /** 0-based track index, or `undefined` when the byte is not a possible track. */
  track: number | undefined;
  /**
   * True when the track's two copies disagree.
   *
   * Surfaced rather than resolved. They agree in every project we hold, so a disagreement means
   * something we believe about this field is wrong — and quietly picking one would hide it.
   */
  trackMirrorDisagrees: boolean;
  /** Absolute image offsets, so a result can be checked by hand against a hex dump. */
  at: { pattern: number; track: number; trackMirror: number };
}

/**
 * Read the saved position, if the bytes are plausible.
 *
 * Returns `undefined` per field rather than a number when the value cannot be a slot or a track,
 * because "the byte says 200" is evidence *against* the hypothesis and should not be dressed up
 * as a pattern index.
 */
export function readSavedPosition(image: Uint8Array, layout = layoutFor(image)): SavedPosition {
  const base = tailStart(layout);
  const patternAt = base + SAVED_PATTERN_OFFSET;
  const trackAt = base + SAVED_TRACK_OFFSET;
  const mirrorAt = base + SAVED_TRACK_MIRROR_OFFSET;

  const pattern = image[patternAt];
  const track = image[trackAt];
  const mirror = image[mirrorAt];

  return {
    pattern: pattern !== undefined && pattern < layout.patternCount ? pattern : undefined,
    track: track !== undefined && track < 16 ? track : undefined,
    trackMirrorDisagrees: track !== mirror,
    at: { pattern: patternAt, track: trackAt, trackMirror: mirrorAt },
  };
}
