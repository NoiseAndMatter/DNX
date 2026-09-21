/**
 * Everything the Insights page shows, derived once, with no HTML in it.
 *
 * ## Why this is not in the page
 *
 * `renderInsights` computed about a hundred lines of numbers and then wrote them into cards, in
 * one function. Every number here is a fact about the pattern rather than about a browser: how
 * long it really repeats, what the reset cuts, how many voices are wanted at the busiest step. A
 * phone showing the same pattern needs all of them and none of the markup.
 *
 * The split also makes the numbers testable without a DOM. The page's own tests could only ever
 * assert on strings, so the arithmetic was checked by reading it.
 *
 * ## One derivation, one number
 *
 * The rule this exists to hold: **anything the page prints twice is computed once here.** The
 * table of tracks used to divide the polymeter by each track's length while the chart beside it
 * asked the model for the same figure against the master period, so the two disagreed for any
 * track not at 1x. The page could not notice; it had two sources.
 */

import {
  type AnalysisSubject,
  type AnalysisTrack,
  cycleSteps,
  drawableWindow,
  harmonic,
  playing,
  polymeterIsBounded,
  reachableSteps,
  repeatSteps,
  repetitions,
  resetCuts,
  resetOptions,
  stepsToSeconds,
  overlappingNotes,
  periodGroups,
  voicesPerStep,
} from "./model.js";

/** One track, with the figures the page prints beside its name. */
export interface TrackFigures {
  track: AnalysisTrack;
  /**
   * Passes this track completes in one cycle.
   *
   * **Against the master period, not the track's own length.** A track at 3/2x covers its length
   * in fewer master steps than it has steps, and dividing by the length alone counted the wrong
   * thing. The chart has always asked the model for this; now the table asks the same question.
   */
  repeats: number;
}

/** The pattern, measured. Everything the page needs and nothing it renders. */
export interface InsightsData {
  /** Tracks with something that sounds. Everything below is measured over these. */
  live: readonly AnalysisTrack[];
  /** True when nothing plays, in which case the rest is not worth reading. */
  silent: boolean;

  /** When the tracks would come round if nothing interrupted them. */
  polymeter: number;
  /** What the sequencer actually repeats, which is the polymeter bounded by PATTERN RESET. */
  cycle: number;
  /** True when the reset cuts the polymeter short. */
  cut: boolean;
  cycleSeconds: number;
  /** False when the track lengths are coprime enough that the polymeter saturates. */
  bounded: boolean;

  trigs: number;
  accents: number;
  lockedPresets: number;
  /** Trigs carrying a condition, which make several figures a floor rather than an answer. */
  conditional: number;

  tracks: readonly TrackFigures[];

  /** Tracks the reset interrupts, and what it takes off them. */
  cuts: ReturnType<typeof resetCuts>;
  /** Track periods grouped, which is what the alignment grid is keyed on. */
  groups: ReturnType<typeof periodGroups>;
  /** Reset lengths worth offering, ascending. */
  options: ReturnType<typeof resetOptions>;
  /** The shortest reset that leaves every track whole, if there is one. */
  completes: ReturnType<typeof resetOptions>[number] | undefined;
  /** True when the current reset costs nothing. */
  alreadyWhole: boolean;

  /** Steps that exist but can never be reached, and the total they are out of. */
  reach: ReturnType<typeof reachableSteps>;
  unreachable: number;

  /** The window one loop of what plays occupies, which is what the strips draw. */
  windowSteps: number;
  /** A window clamped to what can be drawn without freezing the page. */
  drawn: ReturnType<typeof drawableWindow>;

  voices: readonly number[];
  peakVoices: number;
  /** Steps wanting more voices than the instrument has. */
  overBudget: number;
  overlaps: number;
  longestGate: number;

  /** Tracks whose notes carry pitch, which is what the key fit reads. */
  tonal: readonly AnalysisTrack[];
  /** Tracks whose arp sounds something other than the written note. */
  arped: readonly AnalysisTrack[];
}

/**
 * Measure one pattern.
 *
 * Reads the subject and nothing else, so two callers handed the same subject get the same
 * numbers, which is the property the page could not offer while it derived them inline.
 */
export function insightsData(subject: AnalysisSubject): InsightsData {
  const live = playing(subject);
  if (live.length === 0) {
    return {
      live, silent: true,
      polymeter: 0, cycle: 0, cut: false, cycleSeconds: 0, bounded: true,
      trigs: 0, accents: 0, lockedPresets: 0, conditional: 0,
      tracks: [], cuts: [], groups: [], options: [], completes: undefined, alreadyWhole: true,
      reach: reachableSteps(live, subject.resetSteps), unreachable: 0,
      windowSteps: subject.masterLength, drawn: drawableWindow(subject.masterLength),
      voices: [], peakVoices: 0, overBudget: 0, overlaps: 0, longestGate: 0,
      tonal: [], arped: [],
    };
  }

  /*
   * **Two different numbers, and the one a musician hears is the second.** The polymeter is when
   * the tracks would come round; the cycle is that bounded by PATTERN RESET, which pulls every
   * track back to step one whether or not it has finished. Reporting the first as the true cycle
   * was arithmetically right and musically false: a pattern announced as 1,984 steps and 12:24
   * long is restarted by the device every 128 steps, which is 48 seconds.
   */
  const polymeter = cycleSteps(live);
  const cycle = repeatSteps(live, subject.resetSteps);

  const tonal = harmonic(live);
  /*
   * An arp switched on with every offset at zero strikes the written note and changes nothing, so
   * it does not count as arped.
   */
  const arped = live.filter((t) => (t.arpIntervals ?? []).some((n) => n !== 0));

  const longest = Math.max(...live.map((track) => track.length));
  /*
   * **One loop of what actually plays.** With a reset, that is the reset: everything past it
   * repeats what came before. Without one, the longest track is the least that shows every track
   * completing a pass, and the master length wins when it is longer still.
   */
  const windowSteps = subject.resetSteps ?? Math.max(subject.masterLength, longest);
  const voices = voicesPerStep(live, windowSteps);
  const options = resetOptions(live);
  const cuts = resetCuts(live, subject.resetSteps);
  const reach = reachableSteps(live, subject.resetSteps);

  return {
    live,
    silent: false,
    polymeter,
    cycle,
    cut: polymeter > cycle,
    cycleSeconds: stepsToSeconds(cycle, subject.tempo),
    bounded: polymeterIsBounded(live),
    trigs: live.reduce((a, t) => a + t.trigs.length, 0),
    accents: live.reduce(
      (a, t) => a + t.trigs.filter((g) => g.velocity > subject.defaultVelocity).length, 0),
    lockedPresets: live.reduce(
      (a, t) => a + t.trigs.filter((g) => g.lockPreset !== undefined).length, 0),
    conditional: live.reduce((n, t) => n + t.trigs.filter((g) => g.conditional).length, 0),
    tracks: live.map((track) => ({ track, repeats: repetitions(track, cycle) })),
    cuts,
    groups: periodGroups(live),
    options,
    /*
     * The shortest reset that leaves every track whole. Always the last option: the list is
     * ascending and Pareto-optimal, so the most complete answer is the longest one offered.
     */
    completes: options.at(-1),
    alreadyWhole: subject.resetSteps === undefined || cuts.length === 0,
    reach,
    unreachable: reach.total - reach.reachable,
    windowSteps,
    drawn: drawableWindow(cycle),
    voices,
    peakVoices: Math.max(...voices, 0),
    overBudget: voices.filter((v) => v > subject.voiceBudget).length,
    overlaps: live.reduce((n, t) => n + overlappingNotes(t).length, 0),
    longestGate: Math.max(...live.flatMap((t) => t.trigs.map((g) => g.length)), 0),
    tonal,
    arped,
  };
}
