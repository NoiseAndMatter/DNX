/**
 * The track-operation hardware test, as data.
 *
 * Track operations have never been near a device. That matters more than usual here, because
 * PR #33 fixed two bugs that only a device can fully confirm are gone:
 *
 *   - **the lock table's parameter ids.** A lock record is `parameter | track | …` while a trig
 *     slot is `track | step | …`, and the first cut read byte 0 as the track in both. It matched
 *     the wrong records *and* stamped a track number over each survivor's parameter id, so a
 *     lock on CUTOFF became a lock on parameter 3. Our own reader agrees with our own writer
 *     about this; only the device knows which knob moves.
 *   - **the MIDI mask.** A moved track's synth/MIDI bit lives in the kit at +10,260 and was in
 *     no region, so a moved MIDI track arrived as a synth track.
 *
 * And `--scope preset` has no precedent at all in anything that has been tested.
 *
 * ## One pattern per operation
 *
 * A pattern has 16 tracks, which is not enough room to keep thirteen operations from stepping
 * on each other. So the region an operation gets is a whole **pattern**: every step works on
 * its own copy of the same reference pattern, and the reference itself sits untouched in `A1`.
 *
 * That is the pattern-level test's layout moved up a level, and it buys the thing that test
 * did not have: the tester can flip back to `A1` at any point and read the *before* off the
 * device rather than off the sheet.
 *
 * ## What is checkable at a device, and what the halves buy us
 *
 * A track has no name of its own, so identity is read from four places the device shows
 * directly: the **preset name**, the **trig count**, the **lock count**, and whether the track
 * is **MIDI**. The scope split makes each half separately falsifiable, which is why the three
 * scopes of the same move come first on the sheet:
 *
 *   - `sequence` — the trigs and locks arrive, the destination keeps its own preset name
 *   - `preset`   — the preset name arrives, the destination keeps its own trigs
 *   - `both`     — both, plus the track level
 *
 * A bug that moves too much or too little is visible in one of those three rows. A test that
 * only ran `both` could not tell a working split from a composite pretending to be one.
 *
 * ## The expectations are stated here, not computed by the mover
 *
 * `expectedAfter` restates the scope rule from scratch. It looks like a duplicate of the CLI's
 * preview and is deliberately not shared with it: an expectation derived from `applyTrackMove`
 * would agree with `applyTrackMove` whatever either of them did, and the generator's guard —
 * "does the file actually show what the sheet is about to claim?" — would check nothing.
 *
 * It reads its *inputs* through `summariseTracks`, which is not fully independent: `trigCounts`
 * and `lockCounts` come from the module under test. That is the residue the device settles. The
 * sheet prints the counts it expects and the tester counts them on the hardware.
 */

import { type Shuffle, clear, copyMany, moveMany, sourceOf, swap } from "./shuffle.js";
import { type TrackScope } from "./trackmove.js";
import { type TrackSummary, trackName } from "./tracksummary.js";

/** The untouched copy of the source pattern, `A1`. Nothing is ever written to it. */
export const REFERENCE = 0;

/** Steps land from `A2` upward, one pattern each. */
export const FIRST_STEP = 1;

/**
 * Which track of the source pattern plays which role.
 *
 * Chosen from real content rather than fixed, because a test aimed at empty tracks would pass
 * on a mover that did nothing at all.
 */
export interface TrackSeeds {
  /**
   * A synth track carrying both trigs and parameter locks. The lock-table regression rides on
   * this one: its locks must arrive intact, and the track it leaves must show none.
   */
  locked: number;
  /** A second synth track with trigs and a *different* preset name, so a swap is checkable. */
  other: number;
  /** A MIDI track with trigs, or `undefined` when the source pattern has none. */
  midi: number | undefined;
  /**
   * Two **adjacent** empty synth tracks to land on.
   *
   * Synth, so "it became MIDI" is a visible change. Adjacent because a batch lands its sources
   * consecutively from the destination — picking the spares independently would have the sheet
   * claim the second source arrives on a track the batch never touches, and on this project's
   * seed pattern the two happened to be adjacent anyway, so it would have looked correct.
   */
  spare: [number, number];
}

/**
 * A usable set of seeds, or the reason this pattern cannot supply one.
 *
 * `problem` is one clause and no advice. It is printed whole in two places — a refusal, where
 * the caller adds what to do about it, and a survey line, where there is room for one reason and
 * not for a paragraph. A message that has to be truncated to fit somewhere gets truncated
 * mid-sentence, which is how "so the lock-table fix" ended up being a reason.
 */
export type SeedChoice = { seeds: TrackSeeds } | { problem: string };

/**
 * Pick the seed tracks out of one pattern, or say why it will not do.
 *
 * A missing MIDI track is not a refusal — MIDI tracks are rare in a sketch and the other eleven
 * steps are still worth a session. The two steps that need one are dropped, and the sheet says
 * so rather than quietly shipping eleven rows where thirteen were expected.
 */
export function chooseSeeds(before: readonly TrackSummary[]): SeedChoice {
  const named = before.filter((t) => !t.midi && t.trigCount > 0 && t.presetName.trim() !== "");
  if (named.length < 2) {
    // A track has no name of its own, so the preset name is the only identity the device shows,
    // and two are needed before a swap can be read off the screen.
    return { problem: `only ${named.length} synth track(s) have both trigs and a preset name` };
  }

  // Prefer a locked track, and prefer the one with the most locks: a single lock proves the
  // record survived, several prove the table was rebuilt in the right order.
  const locked = [...named].sort((a, b) => b.lockCount - a.lockCount)[0]!;
  if (locked.lockCount === 0) {
    return { problem: "no synth track carries parameter locks, so the lock-table fix goes unchecked" };
  }

  const other = named.find((t) => t.index !== locked.index && t.presetName !== locked.presetName);
  if (!other) {
    // A swap or a reordered batch would look identical either way.
    return { problem: `every synth track with trigs is named "${locked.presetName}"` };
  }

  // A destination that already held something cannot show whether the right thing arrived, and
  // the pair has to be adjacent because that is where a batch puts its second source.
  const free = (t: TrackSummary): boolean =>
    !t.midi && t.empty && t.index !== locked.index && t.index !== other.index;
  const spare = before.find((t, i) => free(t) && i + 1 < before.length && free(before[i + 1]!));
  if (!spare) {
    return { problem: "no two adjacent empty synth tracks are free to land on" };
  }

  const midi = before.find((t) => t.midi && t.trigCount > 0);

  return {
    seeds: {
      locked: locked.index,
      other: other.index,
      midi: midi?.index,
      spare: [spare.index, spare.index + 1],
    },
  };
}

/** What the device must show on one track once the step has run. */
export interface TrackExpectation {
  track: number;
  /**
   * The preset name the device must show — always a concrete string, never "it will be blank".
   *
   * An emptied track is **not** an unnamed one: the captured blank names each track's preset
   * `PRESET 1` … `PRESET 16`, by track number. The first cut of this module assumed a cleared
   * track came back with an empty name, and the generator's own guard caught it before any
   * sheet was printed. Stating the real name is also better for the tester, who now has
   * something to read off the screen rather than a judgement to make about what counts as blank.
   */
  presetName: string;
  /** True when that name is the captured blank's, i.e. this track was emptied rather than filled. */
  initialised: boolean;
  trigCount: number;
  lockCount: number;
  /** True when the device must show a MIDI machine here. */
  midi: boolean;
  /** Track level as the MIX page shows it, 0..127. */
  level: number;
}

/** One row of the check sheet: an operation, where it runs, and what to read afterwards. */
export interface TrackTestStep {
  /** Ordinal, matching the printed sheet. */
  n: number;
  /** The pattern this operation is applied to — its own copy of the reference. */
  pattern: number;
  operation: string;
  scope: TrackScope;
  shuffle: Shuffle;
  /** The tracks the tester must look at. Always exactly the tracks we make a claim about. */
  inspect: number[];
  /** Anything the per-track table cannot express. */
  note?: string;
  /** True where the step destroys work, which the librarian requires be acknowledged. */
  destructive: boolean;
}

/**
 * What a track holds after a shuffle, per the scope rule.
 *
 * Restated from the rule rather than shared with the mover — see the module note.
 *
 * `blank` is the 16 tracks of a **captured** blank pattern in the same image, never synthesised,
 * because what the device writes for an emptied track is a fact and not something to assume.
 * It is indexed by *destination*: a vacated track takes the blank's track of the same number,
 * not the blank's track 1, so the two must line up here the way they do in the mover.
 */
export function expectedAfter(
  before: readonly TrackSummary[],
  blank: readonly TrackSummary[],
  shuffle: Shuffle,
  track: number,
  scope: TrackScope,
): TrackExpectation {
  const source = sourceOf(shuffle, track);
  const empty = blank[track]!;
  const from = source === undefined ? empty : before[source]!;
  const mine = before[track]!;

  // Each half either arrives from the source or stays put, and nothing else can happen to it.
  const sequence = scope === "preset" ? mine : from;
  const preset = scope === "sequence" ? mine : from;
  const level = scope === "both" ? from.level : mine.level;

  return {
    track,
    presetName: preset.presetName,
    initialised: preset === empty,
    trigCount: sequence.trigCount,
    lockCount: sequence.lockCount,
    midi: preset.midi,
    level,
  };
}

/** Every expectation a step makes, in the order the sheet lists them. */
export function expectationsFor(
  step: TrackTestStep,
  before: readonly TrackSummary[],
  blank: readonly TrackSummary[],
): TrackExpectation[] {
  return step.inspect.map((track) => expectedAfter(before, blank, step.shuffle, track, step.scope));
}

/**
 * The operations, each in its own pattern.
 *
 * Ordered by value, not by kind. The two regressions and the three scopes come first, so a
 * session cut short still answers the questions it was called for; the routine copies and
 * clears follow. The tester works `A2` upward and never leaves bank A.
 */
export function stepsFor(seeds: TrackSeeds, before: readonly TrackSummary[]): TrackTestStep[] {
  const { locked, other, midi, spare } = seeds;
  const lockedName = before[locked]!.presetName;
  const otherName = before[other]!.presetName;
  const lockCount = before[locked]!.lockCount;
  const lockedTrigs = before[locked]!.trigCount;
  const otherTrigs = before[other]!.trigCount;

  const steps: Omit<TrackTestStep, "n" | "pattern">[] = [
    {
      operation: `Move ${trackName(locked)} onto ${trackName(other)}`,
      scope: "both",
      shuffle: moveMany([locked], other),
      inspect: [locked, other],
      note:
        `The composite the hardware does not offer. ${trackName(other)} should now be ` +
        `"${lockedName}" with ${lockedTrigs} trigs and ${lockCount} locks, and its own ` +
        `"${otherName}" gone. Check the ${lockCount} lock(s) still move the same knobs they ` +
        `did on ${trackName(locked)} — a lock on the wrong parameter is the exact failure this ` +
        `session exists to rule out.`,
      destructive: true,
    },
    {
      operation: `Move ${trackName(locked)} onto ${trackName(other)}, sequence only`,
      scope: "sequence",
      shuffle: moveMany([locked], other),
      inspect: [locked, other],
      note:
        `The device's own TRACK SEQUENCE paste. ${trackName(other)} keeps its sound — still ` +
        `"${otherName}" — and plays ${trackName(locked)}'s notes. ${trackName(locked)} keeps ` +
        `"${lockedName}" and falls silent. If ${trackName(other)} reads "${lockedName}", the ` +
        `preset moved when it should not have.`,
      destructive: true,
    },
    {
      operation: `Move ${trackName(locked)} onto ${trackName(other)}, preset only`,
      scope: "preset",
      shuffle: moveMany([locked], other),
      inspect: [locked, other],
      note:
        `The device's own PRESET paste, and the one nothing has ever tested. The opposite of ` +
        `the row above: ${trackName(other)} sounds like "${lockedName}" but still plays its ` +
        `own ${otherTrigs} trigs, and ${trackName(locked)} keeps all ${lockedTrigs} of its ` +
        `trigs with a blank preset under them. LEVEL is in the kit and not in the preset, so ` +
        `${trackName(other)}'s level must not have changed.`,
      destructive: true,
    },
  ];

  if (midi !== undefined) {
    steps.push(
      {
        operation: `Move MIDI track ${trackName(midi)} onto ${trackName(spare[0])}`,
        scope: "both",
        shuffle: moveMany([midi], spare[0]),
        inspect: [midi, spare[0]],
        note:
          `The MIDI-mask regression. ${trackName(spare[0])} started as a synth track; it must ` +
          `now be a MIDI track, with the same channel and CC assignments. A synth machine ` +
          `there means the mask at kit +10,260 did not travel — the bug PR #33 fixed.`,
        destructive: true,
      },
      {
        operation: `Swap MIDI track ${trackName(midi)} with ${trackName(locked)}`,
        scope: "both",
        shuffle: swap(midi, locked),
        inspect: [midi, locked],
        note:
          `The mask has to cross in both directions at once. ${trackName(locked)} becomes a ` +
          `MIDI track and ${trackName(midi)} becomes "${lockedName}". A swap that sets one bit ` +
          `without clearing the other leaves two MIDI tracks or none.`,
        destructive: true,
      },
    );
  }

  steps.push(
    {
      operation: `Swap ${trackName(locked)} with ${trackName(other)}`,
      scope: "both",
      shuffle: swap(locked, other),
      inspect: [locked, other],
      note: `Before the swap ${trackName(locked)} held "${lockedName}" and ${trackName(other)} held "${otherName}".`,
      destructive: true,
    },
    {
      operation: `Swap ${trackName(locked)} with ${trackName(other)}, sequence only`,
      scope: "sequence",
      shuffle: swap(locked, other),
      inspect: [locked, other],
      note:
        `The notes cross and the sounds stay: ${trackName(locked)} is still "${lockedName}" ` +
        `playing ${otherTrigs} trigs, ${trackName(other)} still "${otherName}" playing ` +
        `${lockedTrigs}. Both halves are wrong in the same row if either name moved.`,
      destructive: true,
    },
    {
      operation: `Copy ${trackName(locked)} to ${trackName(spare[0])}`,
      scope: "both",
      shuffle: copyMany([locked], spare[0]),
      inspect: [locked, spare[0]],
      note: `A copy leaves the source alone — both tracks play, both carry the same preset name.`,
      destructive: false,
    },
    {
      operation: `Copy ${trackName(locked)} to ${trackName(other)}, preset only`,
      scope: "preset",
      shuffle: copyMany([locked], other),
      inspect: [locked, other],
      note:
        `Two tracks now share "${lockedName}" and play different things. ${trackName(other)} ` +
        `must still have its own ${otherTrigs} trigs: a preset copy that dragged the trigs ` +
        `along would look like a working copy until you counted them.`,
      destructive: true,
    },
    {
      operation: `Clear ${trackName(locked)}`,
      scope: "both",
      shuffle: clear(locked),
      inspect: [locked],
      note:
        `Empty is not enough. Select the track, check the preset reads as initialised, and ` +
        `record a trig into it. A track that looks blank but refuses a trig is a different ` +
        `bug — and check the ${lockCount} lock(s) are gone rather than showing on a parameter ` +
        `nobody chose, which is how the lock bug presented.`,
      destructive: true,
    },
    {
      operation: `Clear ${trackName(locked)}, sequence only`,
      scope: "sequence",
      shuffle: clear(locked),
      inspect: [locked],
      note:
        `The trigs and locks go, "${lockedName}" stays. Hold a trig key and it should still ` +
        `make the sound it always did.`,
      destructive: true,
    },
    {
      operation: `Clear ${trackName(locked)}, preset only`,
      scope: "preset",
      shuffle: clear(locked),
      inspect: [locked],
      note:
        `The other half of the row above, and the fourth corner of the scope grid. All ` +
        `${lockedTrigs} trigs and ${lockCount} locks stay; the sound under them is the ` +
        `initialised preset. The locks now address an initialised machine, so what they do ` +
        `may well be nonsense — that they are still *there* is the claim.`,
      destructive: true,
    },
    {
      operation: `Batch move ${trackName(locked)}, ${trackName(other)} to ${trackName(spare[0])}`,
      scope: "both",
      shuffle: moveMany([locked, other], spare[0]),
      inspect: [locked, other, spare[0], spare[1]],
      note:
        `A batch lands in source order, so the names test the order as well as the move: ` +
        `${trackName(spare[0])} should be "${lockedName}" and ${trackName(spare[1])} ` +
        `"${otherName}". Both sources end up empty.`,
      destructive: true,
    },
  );

  return steps.map((step, i) => ({ ...step, n: i + 1, pattern: FIRST_STEP + i }));
}

/** Every pattern the built file writes to, so the caller can seed exactly those. */
export function stepPatterns(steps: readonly TrackTestStep[]): number[] {
  return steps.map((s) => s.pattern);
}

/**
 * Things that fail quietly at track level, and so have to be looked for deliberately.
 *
 * The four the table already checks — preset name, trig count, lock count, MIDI — are the
 * mechanism the sheet is read by rather than afterthoughts, so they are not repeated here.
 */
export const QUIET_FAILURES: readonly string[] = [
  "WHAT THE LOCKS DO, not just how many. The table counts them; only you can tell whether the lock that moved CUTOFF still moves CUTOFF. This is the regression the session is for — check it on at least one moved track and one cleared one.",
  "TRIG CONDITIONS, microtiming and retrigs, which live in the trig record beside the note and would travel or not travel with it silently.",
  "PER-TRACK LENGTH, if the source pattern uses it. A track in the wrong length still plays, just gradually out of phase with the rest.",
  "THE ARPEGGIATOR and PRESET SETUP menus, which the manual puts inside the preset — so a preset move should carry them and a sequence move should not.",
  "TRACK LEVEL on the MIX page. Only `both` carries it; `sequence` and `preset` must leave it where it was, because LEVEL is in the kit and not in the preset.",
  "SEND FX and track LAYERING, which the manual puts in the kit but *outside* the preset — so no scope should move them at all.",
  "SOUND LOCKS, if the source pattern has any. They index a pool that is per project, and these operations stay inside one pattern, so they should be untouched — but untouched is a claim too.",
];
