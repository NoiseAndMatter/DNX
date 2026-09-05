/**
 * Several subjects at once: one row of structural figures per subject.
 *
 * ## Why this is its own module rather than more of `model.ts`
 *
 * `model.ts` answers questions *within* one subject — where a track is at step 40, what the reset
 * cuts, which pitch classes sound. Every function here answers a question *across* subjects, and
 * the two have different inputs and different reasons to change. Keeping them apart is the same
 * split as `selection.ts` out of `grid.ts`.
 *
 * **Nothing here derives anything.** Every number below is a call into `model.ts`; this file
 * arranges them into a row. That is deliberate and is the point of the module: if the comparison
 * ever disagreed with the single-pattern card about the same pattern, one of them would be wrong,
 * and the only way to guarantee they cannot is for both to ask the same function.
 *
 * ## The architecture claim this tests
 *
 * `analysis/` was built to take a neutral `AnalysisSubject` so that a second kind of subject would
 * be a new *producer* rather than a change to every chart. A second subject at the same time is
 * the cheapest possible test of that, and it passed: this module needed no change to `model.ts`
 * and no change to any existing chart.
 *
 * ## What is deliberately not here
 *
 * **A key.** It is the one figure on the surface that is an inference rather than a reading, it
 * needs the correlation run over the whole cycle, and a cycle can saturate at a million steps —
 * so across eight selected patterns it is both the most expensive column and the least comparable
 * one. It stays in the per-pattern card, where there is room to say how it was arrived at.
 */

import {
  cycleSteps, playing, polymeterIsBounded, repeatSteps, resetCuts, stepsToSeconds,
  type AnalysisSubject,
} from "./model.js";

/** One subject's structural figures, as a comparison prints them. */
export interface ComparisonRow {
  label: string;
  tempo: number;
  masterLength: number;
  /** `undefined` is INF — the tracks are never pulled back. */
  resetSteps?: number;
  /** `undefined` is CHANGE off. */
  changeSteps?: number;
  /** Tracks carrying at least one trig. */
  playing: number;
  /** Tracks in the pattern, played or not. */
  tracks: number;
  trigs: number;
  /** Trigs carrying a stored condition, which make every figure here a floor. See `AnalysisTrig`. */
  conditional: number;
  /** Master steps before the whole thing repeats — the polymeter bounded by RESET. */
  cycle: number;
  /** What the track lengths alone would give, ignoring RESET. */
  polymeter: number;
  /** False when the lengths do not come round inside `POLYMETER_LIMIT` and counting stopped. */
  bounded: boolean;
  /** Tracks the reset interrupts mid-pass. */
  cutTracks: number;
  /** Notes those cuts silence, every time round. */
  lostTrigs: number;
  /** How long one cycle lasts at this subject's own tempo. */
  seconds: number;
  /** True when no track carries a trig, so every figure above is zero and means nothing. */
  silent: boolean;
}

/** Read each subject into a row. Order is preserved: it is the order they were selected in. */
export function compareSubjects(subjects: readonly AnalysisSubject[]): ComparisonRow[] {
  return subjects.map((subject) => {
    const live = playing(subject);
    const cycle = repeatSteps(live, subject.resetSteps);
    const cuts = resetCuts(live, subject.resetSteps);
    return {
      label: subject.label,
      tempo: subject.tempo,
      masterLength: subject.masterLength,
      ...(subject.resetSteps === undefined ? {} : { resetSteps: subject.resetSteps }),
      ...(subject.changeSteps === undefined ? {} : { changeSteps: subject.changeSteps }),
      playing: live.length,
      tracks: subject.tracks.length,
      trigs: live.reduce((n, t) => n + t.trigs.length, 0),
      conditional: live.reduce((n, t) => n + t.trigs.filter((g) => g.conditional).length, 0),
      cycle,
      polymeter: cycleSteps(live),
      bounded: polymeterIsBounded(live),
      cutTracks: cuts.length,
      lostTrigs: cuts.reduce((n, c) => n + c.lost, 0),
      seconds: stepsToSeconds(cycle, subject.tempo),
      silent: live.length === 0,
    };
  });
}

/**
 * What a set of rows has in common and where it splits.
 *
 * Separate from the rows because it is what turns a table into a finding. A reader scanning eight
 * rows for "do these share a tempo" is doing work the arithmetic can do once, and the answer is
 * the sentence worth putting above the table rather than a ninth column inside it.
 */
export interface ComparisonSummary {
  /** Distinct tempos, ascending. One entry means they all agree. */
  tempos: number[];
  /** Distinct RESET values, ascending, with INF last. `undefined` in the list is INF. */
  resets: (number | undefined)[];
  /** The row that repeats soonest, and the one that takes longest. Undefined if none play. */
  shortest?: ComparisonRow;
  longest?: ComparisonRow;
  /** Rows whose polymeter RESET never lets finish. */
  reset: ComparisonRow[];
  /** Rows losing notes to a cut, which is the one thing here that is usually unintended. */
  losing: ComparisonRow[];
  /** Rows carrying at least one conditional trig, so their cycle figure is a floor. */
  conditional: ComparisonRow[];
  /** Rows with nothing sequenced. Counted, never charted — a silent pattern has no length. */
  silent: ComparisonRow[];
}

export function summariseComparison(rows: readonly ComparisonRow[]): ComparisonSummary {
  const live = rows.filter((r) => !r.silent);
  const ascending = (a: number, b: number) => a - b;
  return {
    tempos: [...new Set(rows.map((r) => r.tempo))].sort(ascending),
    /*
     * INF sorts last rather than first. It is not a small reset, it is the absence of one, and a
     * list reading "INF, 16, 64" invites the eye to read it as the shortest.
     */
    resets: [
      ...[...new Set(rows.flatMap((r) => (r.resetSteps === undefined ? [] : [r.resetSteps])))]
        .sort(ascending),
      ...(rows.some((r) => r.resetSteps === undefined) ? [undefined] : []),
    ],
    ...(live.length
      ? {
        shortest: live.reduce((m, r) => (r.cycle < m.cycle ? r : m)),
        longest: live.reduce((m, r) => (r.cycle > m.cycle ? r : m)),
      }
      : {}),
    reset: live.filter((r) => r.polymeter > r.cycle),
    losing: live.filter((r) => r.lostTrigs > 0),
    conditional: live.filter((r) => r.conditional > 0),
    silent: rows.filter((r) => r.silent),
  };
}
