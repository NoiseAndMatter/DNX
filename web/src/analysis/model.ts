/**
 * What analysis reads, and everything derived from it.
 *
 * ## The input is deliberately not a project
 *
 * Every function here takes an `AnalysisSubject` — a flat description of some tracks and the trigs
 * on them — and nothing here knows what a `.dn2prj` is, what a +Drive slot is, or which page is
 * asking. That is the whole point of the shape.
 *
 * The alternative was to take a decoded project image and reach into it. It would have been less
 * code today and it would have fixed the analysis to exactly one subject: the pattern currently
 * open in the manager. A kit, a preset bank, a song's worth of patterns end to end, or two projects
 * side by side would each have needed the charts to learn a new container. Taking a neutral subject
 * means a new source is a new *producer* — the charts and these derivations do not change at all.
 *
 * So the rule for anything added here: **it takes a subject, or a list of them. It never takes a
 * project.**
 *
 * ## Notes are MIDI numbers, not pitch classes
 *
 * A stack of notes has to be ordered low to high, and a pitch class cannot say which of two notes
 * is the lower one. Pitch class is a *view* of a note (`pitchClass`), never how one is stored.
 *
 * ## Nothing here touches the DOM
 *
 * Not a convention — `test/web.test.ts` walks the import graph and fails if it does. A pure thing
 * inside a DOM module is a pure thing nobody can test, which is the same reason `selection.ts` is
 * not part of `grid.ts`.
 */

import { MACHINE, machineName } from "../../../src/project/machine.js";

/** One trig, with everything analysis can currently read off it. */
export interface AnalysisTrig {
  /** Step index within the track's own length. */
  step: number;
  /**
   * Every note this trig sounds, as MIDI note numbers, root first.
   *
   * A chord is more than one. **This is where the voice budget is actually spent** — counting a
   * trig once instead of counting its notes under-reports every chord in the pattern.
   *
   * A note p-lock needs no separate field: `plockparams.ts` lists `TRIG 1 NOTE` under
   * `NOT_LOCKABLE` because the trig slot itself carries the note, so the note read here already
   * *is* the locked one.
   */
  notes: number[];
  velocity: number;
  /**
   * Gate length in steps.
   *
   * **Only meaningful when the subject says `gateLengthKnown`.** A Digitone II stores note length
   * as a raw byte whose mapping to a duration has never been captured — `dn2-pattern-format.md`
   * marks even the name of the field as inferred — so a producer reading a real project cannot
   * fill this in and sets 1. Anything that reads it must ask the subject first.
   */
  length: number;
  /** Signed microtiming; 0 is on the grid. */
  microTiming: number;
  /**
   * Whether this trig only plays on some passes.
   *
   * **A boolean, because the condition itself is not decoded.** A Digitone II trig can carry a
   * condition like 2:3 — play on the second of every three passes — and `dn2-pattern-format.md`
   * lists the code tables at `+0x100` and `+0x180` as unread: the numbering is non-linear between
   * the two families and no capture has exercised it.
   *
   * It matters here because a conditional trig **lengthens the musical cycle**: a pattern whose
   * tracks realign after 64 steps does not sound the same on every one of them if a trig plays on
   * one pass in three. 1,388 of the 15,258 note trigs in the corpus are conditional, across 220 of
   * the 352 playing patterns — so this is the common case, not an edge one, and the honest thing is
   * to say the cycle shown is a floor rather than to pretend the conditions are not there.
   */
  conditional?: boolean;
  /**
   * The preset a sound lock puts on this trig, or `undefined` when the track's own preset sounds.
   *
   * A name rather than a pool slot, because every reader here wants to print it and none of them
   * can resolve a slot on their own.
   */
  lockPreset?: string;
}

/** One track of a subject. */
export interface AnalysisTrack {
  /** 1-based, as the instrument numbers them. */
  number: number;
  /** Track length in steps. */
  length: number;
  /**
   * Speed multiplier, 1 being the master's, or `undefined` for an enum value nothing has named.
   *
   * Three of the 1,788 playing tracks in the corpus carry a speed byte outside the seven values
   * `TRACK_SPEED` documents. Showing those as `1x` would be a quiet lie about a track that is not
   * running at 1x, so they say so instead.
   */
  speed?: number;
  /**
   * A `MACHINE` value, or `undefined` for one this project cannot name.
   *
   * Undefined means unknown, never "probably FM TONE" — `machine.ts` is explicit that the DN2's
   * machine list is longer than the capture that produced the table.
   */
  machine?: number;
  preset: string;
  trigs: AnalysisTrig[];
}

/** Whatever is being analysed: today a pattern, tomorrow whatever produces the same shape. */
export interface AnalysisSubject {
  /** How the subject names itself on screen — "A1 · TECNO_EXP", say. */
  label: string;
  tempo: number;
  /** The master length, in steps: the window a chart draws by default. */
  masterLength: number;
  /**
   * How many steps before the sequencer restarts every track together, or `undefined` for never.
   *
   * **This is what actually decides when a pattern repeats, and the least common multiple of the
   * track lengths does not.** With per-track lengths the Digitone II offers a PATTERN **RESET**
   * setting — Elektron's manual: *"controls the number of steps the pattern plays before all
   * tracks resets and restarts from the first step on the first page. An INF setting makes the
   * tracks of the pattern loop infinitely, without ever being restarted."*
   *
   * So a pattern with tracks of 12, 16 and 64 steps has a polymeter that would take 192 steps to
   * come round — and if RESET is 64 it never gets there, because everything is pulled back to step
   * one three times on the way. `repeatSteps` is the number a musician hears; `cycleSteps` is the
   * arithmetic of the lengths alone.
   */
  resetSteps?: number;
  /**
   * How many steps before the pattern hands over to a cued or chained one, or `undefined` for
   * never.
   *
   * **Not a second repeat length, and it must never be presented as one.** Elektron's manual:
   * CHANGE *"controls for how long the active pattern plays before it changes to a cued or chained
   * pattern"* — it ends the pattern rather than bringing it round. What it answers is how much of a
   * long polymeter anybody ever hears in a chain, which is a different and equally real question.
   *
   * The trap it carries is the manual's own: with no CHANGE setting and RESET at INF, *"the pattern
   * plays infinitely and the next cued pattern will never play."*
   */
  changeSteps?: number;
  /** 16 on a Digitone II, 8 on a Digitone 1. A device property, not a file field. */
  voiceBudget: number;
  /** Above this a trig reads as an accent. */
  defaultVelocity: number;
  /**
   * Whether a trig's `length` is a real gate length.
   *
   * **False for every Digitone II project read today.** The note-length byte is stored on the trig
   * and its mapping to a duration has never been captured, so voice pressure, the note-length marks
   * and overlap detection have no honest input — and a caller must not draw them. Inventing a
   * mapping would put a fabricated number under a chart that looks exactly like a measured one,
   * which is the one failure this whole surface is arranged to avoid.
   *
   * True for synthetic data, which knows its own gates because it made them up on purpose.
   */
  gateLengthKnown: boolean;
  tracks: AnalysisTrack[];
}

export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/** The pitch class of a MIDI note. */
export function pitchClass(note: number): number {
  return ((note % 12) + 12) % 12;
}

/** The note letter of a MIDI note, for a label or a tooltip. */
export function noteName(note: number): string {
  return NOTE_NAMES[pitchClass(note)]!;
}

/**
 * The machines a chart stacks in, in a fixed order.
 *
 * Fixed because a stacking order that follows the data reorders itself between two patterns, and
 * then the same colour sits at a different height in each — which is the one thing a stacked bar
 * must not do.
 */
export const MACHINE_ORDER: readonly number[] = [
  MACHINE.fmTone, MACHINE.wavetone, MACHINE.fmDrum, MACHINE.swarmer, MACHINE.midi,
];

/**
 * A machine's name for display, never a guess.
 *
 * An unrecognised value prints as its number rather than as a plausible name, because
 * `machine.ts` only knows the five its capture covered and a wrong name here would be indis-
 * tinguishable from a right one.
 */
export function machineLabel(machine: number | undefined): string {
  if (machine === undefined) return "unknown machine";
  return machineName(machine) ?? `machine ${machine}`;
}

/** The preset actually sounding on a trig: its lock if it has one, else the track's. */
export function presetOf(track: AnalysisTrack, trig: AnalysisTrig): string {
  return trig.lockPreset ?? track.preset;
}

/** Tracks with something on them. An empty track is not a row on any chart. */
export function playing(subject: AnalysisSubject): AnalysisTrack[] {
  return subject.tracks.filter((t) => t.trigs.length > 0);
}

/**
 * How many **master steps** one pass of a track takes.
 *
 * **A track's length is not its period.** SPEED is a multiple of the pattern's tempo — Elektron's
 * manual: *"a setting of 1/8X plays back the track at one-eighth of the set tempo"* — so a 12-step
 * track at 3/2x covers its twelve steps in eight master steps, and a 16-step track at 1/2x takes
 * thirty-two. Everything about when tracks realign, when a reset interrupts one, and where a trig
 * falls, happens on the master clock.
 *
 * Ignoring this got 60 of the 352 playing patterns in the corpus wrong. `GLITCH_EXPLORE` B5 was
 * reported as a 192-step polymeter with two tracks cut; on the master clock it is **64 steps, which
 * is exactly its reset, and nothing is cut at all**. The error was not small and it was not rare.
 */
export function masterPeriod(track: AnalysisTrack): number {
  const speed = track.speed ?? 1;
  return speed > 0 ? track.length / speed : track.length;
}

/** Where a step of a track falls on the master clock, relative to the start of its pass. */
export function masterOffset(track: AnalysisTrack, step: number): number {
  const speed = track.speed ?? 1;
  return speed > 0 ? step / speed : step;
}

/**
 * The denominator every speed divides into.
 *
 * The seven speeds are 2, 3/2, 1, 3/4, 1/2, 1/4 and 1/8, so a period of `length / speed` is always
 * a whole number of twenty-fourths. Scaling by this keeps the least common multiple in integers
 * instead of asking a float for `lcm(10.666…, 16)`.
 */
const SPEED_SCALE = 24;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The longest polymeter this module will report, and the point past which it stops counting.
 *
 * **Track lengths are not ours to choose.** A Digitone II allows 1..128 per track over sixteen
 * tracks, and sixteen pairwise-coprime lengths in that range have a least common multiple of the
 * order of 10^30 — past what a double can hold exactly, so the arithmetic stops being arithmetic
 * and starts being noise. It is also nonsense musically: a million steps is about a day at any
 * tempo anyone uses.
 *
 * So the count saturates here rather than overflowing, and `polymeterIsBounded` says when it did.
 * The alternative found earlier in this file's history is worse: an unbounded value flows into
 * every windowing loop as a bound and the page stops responding.
 */
export const POLYMETER_LIMIT = 1_000_000;

/** Least common multiple, saturating at `POLYMETER_LIMIT` rather than losing precision. */
const lcm = (a: number, b: number): number => {
  if (a >= POLYMETER_LIMIT || b >= POLYMETER_LIMIT) return POLYMETER_LIMIT;
  const value = (a / gcd(a, b)) * b;
  return Number.isSafeInteger(value) && value < POLYMETER_LIMIT ? value : POLYMETER_LIMIT;
};

/**
 * How many steps pass before every track has wrapped together.
 *
 * The least common multiple of the track lengths — the number behind "this pattern does not
 * actually repeat for eleven minutes".
 */
export function cycleSteps(tracks: readonly AnalysisTrack[]): number {
  /*
   * **Lengths below 1 are ignored rather than multiplied in.** `lcm(a, 0)` is 0 and `lcm(0, 0)` is
   * `NaN`, and both propagate into every chart that divides by the cycle — a cycle of 0 makes a
   * repetition count of `Infinity` and a cycle of `NaN` makes every bar vanish. A track that
   * cannot be sequenced contributes nothing to when the pattern realigns.
   */
  const scaled = tracks
    .filter((t) => t.length >= 1)
    .map((t) => Math.round(masterPeriod(t) * SPEED_SCALE))
    .filter((n) => Number.isInteger(n) && n >= 1);
  if (!scaled.length) return 1;
  const together = scaled.reduce(lcm, SPEED_SCALE);
  return together >= POLYMETER_LIMIT ? POLYMETER_LIMIT : together / SPEED_SCALE;
}

/**
 * False when the polymeter is longer than this module counts, so a caller can say so rather than
 * print `POLYMETER_LIMIT` as though it were measured.
 */
export function polymeterIsBounded(tracks: readonly AnalysisTrack[]): boolean {
  return cycleSteps(tracks) < POLYMETER_LIMIT;
}

/**
 * How many steps before the pattern actually repeats.
 *
 * The polymeter arithmetic, **bounded by the sequencer's own RESET**. Without the bound this
 * reported 1,984 steps — twelve and a half minutes — for a pattern the device restarts every 128,
 * which is 48 seconds. The number was arithmetically correct and musically false.
 */
export function repeatSteps(tracks: readonly AnalysisTrack[], resetSteps?: number): number {
  const cycle = cycleSteps(tracks);
  return resetSteps === undefined ? cycle : Math.min(cycle, resetSteps);
}

/** A track the reset interrupts, and where. */
export interface ResetCut {
  track: AnalysisTrack;
  /** Complete passes before the reset lands. */
  passes: number;
  /** Steps into the next pass at which it is cut off. Always 1..length-1. */
  cutAfter: number;
  /**
   * Trigs in the interrupted part of the pass — the notes that never sound.
   *
   * **A cut only matters if something was going to play in it.** 19 of the 63 interrupted tracks in
   * the corpus lose nothing: every trig sits before the cut, so the geometry is untidy and the
   * music is unaffected. Reporting those in the same breath as the 44 that drop 511 notes between
   * them is crying wolf, and the first version of this chart did exactly that.
   */
  lost: number;
}

/**
 * Tracks whose length does not divide the reset, so the sequencer interrupts them mid-figure.
 *
 * **The one thing on this surface a musician can act on directly.** A 12-step track under a
 * 64-step reset plays five complete passes and then four steps of a sixth before being pulled back
 * to the start — every time round, in the same place. It is audible as a part that goes wrong at
 * the same moment on every repeat, and invisible on the instrument, which shows lengths and resets
 * on different screens and never their remainder.
 *
 * 41 of the 352 playing patterns in the corpus have at least one, across 63 tracks.
 *
 * A track whose length divides the reset is clean and is not returned: it finishes its last pass
 * exactly as everything restarts, which is what a reset is for.
 */
export function resetCuts(
  tracks: readonly AnalysisTrack[], resetSteps: number | undefined,
): ResetCut[] {
  if (resetSteps === undefined) return [];
  const out: ResetCut[] = [];
  for (const track of tracks) {
    if (track.length < 1) continue;
    /*
     * On the master clock, because that is the clock the reset counts. A 12-step track at 3/2x
     * takes eight master steps per pass, so a reset of 64 gives it eight whole passes and cuts
     * nothing — where the same track read at its raw length looked cut after four.
     */
    const period = masterPeriod(track);
    const passes = Math.floor(resetSteps / period);
    const cutAfter = Number((resetSteps - passes * period).toFixed(6));
    if (cutAfter <= 0) continue;
    out.push({
      track,
      passes,
      cutAfter,
      // A trig is lost when its own position within the pass falls past the cut.
      lost: track.trigs.filter((trig) => masterOffset(track, trig.step) >= cutAfter).length,
    });
  }
  return out;
}

/**
 * How much of the polymeter is ever heard.
 *
 * **A reset does not shorten the polymeter — it makes most of it unreachable.** Every track returns
 * to step one together at the reset, so the pattern is exactly periodic from there and the phasing
 * beyond it never happens. Not "you hear less of it": you hear the *same* first stretch, forever.
 *
 * `reachable` and `total` are equal when there is no reset, which is the honest way to say that
 * nothing is being lost.
 */
export function reachableSteps(
  tracks: readonly AnalysisTrack[], resetSteps?: number,
): { reachable: number; total: number } {
  const total = cycleSteps(tracks);
  return { reachable: repeatSteps(tracks, resetSteps), total };
}

/**
 * The largest value the RESET field can hold.
 *
 * `dn2-pattern-format.md` records the field at `+0x14` as a `u16be` with a documented range of
 * 1..1024. **What the instrument's own control offers is not confirmed** — the largest RESET
 * anywhere in the corpus is 128 — so a suggestion above this is reported as "INF only" rather than
 * as a number to dial in. `Tests_To_Run.html` T41 asks for the maximum while it is settling INF.
 */
export const RESET_FIELD_MAX = 1024;

/** A group of tracks that share a period, and therefore stay in phase with each other forever. */
export interface PeriodGroup {
  /** Master steps per pass — what actually decides alignment. */
  period: number;
  /** The track lengths in this group, for a label. Usually one; two only when speeds differ. */
  lengths: number[];
  tracks: number[];
}

/**
 * Distinct **periods**, ascending, with the tracks that share each.
 *
 * **Alignment is a property of periods, not of lengths and not of tracks.** Two tracks of sixteen
 * steps are in phase only if they also run at the same speed: one at 1x and one at 2x drift apart
 * exactly as a 16 and an 8 would. Grouping on length was wrong for the 77 corpus patterns whose
 * tracks do not share a speed.
 *
 * Sixteen tracks bounds this at sixteen groups — that, not anything about the projects to hand, is
 * what a reader can rely on.
 */
export function periodGroups(tracks: readonly AnalysisTrack[]): PeriodGroup[] {
  const by = new Map<number, PeriodGroup>();
  for (const t of tracks) {
    if (t.length < 1) continue;
    const period = masterPeriod(t);
    const group = by.get(period) ?? { period, lengths: [], tracks: [] };
    if (!group.lengths.includes(t.length)) group.lengths.push(t.length);
    group.tracks.push(t.number);
    by.set(period, group);
  }
  return [...by.values()].sort((a, b) => a.period - b.period);
}

/**
 * The lengths in a group, each with the speed that turns it into the group's period.
 *
 * **A period is not a control anybody can set.** The instrument has LEN and SPEED; a period of 8 is
 * what a 12-step track at 3/2x produces. Every place a period is shown has to be able to say which
 * pair of settings it came from, or the reader cannot match the chart to the screen in front of
 * them — a track they set to 12 appearing as an 8 with no explanation is worse than not showing it.
 *
 * The speed is derived rather than stored: it is exactly `length / period` by construction.
 */
export function periodSources(group: PeriodGroup): { length: number; speed: number }[] {
  return group.lengths
    .map((length) => ({ length, speed: Number((length / group.period).toFixed(4)) }))
    .sort((x, y) => x.length - y.length);
}

/** Renders a speed the way the instrument writes it: `3/2x`, `1/2x`, `2x`. */
export function speedLabel(speed: number): string {
  const known: Record<string, string> = {
    "2": "2x", "1.5": "3/2x", "1": "1x", "0.75": "3/4x",
    "0.5": "1/2x", "0.25": "1/4x", "0.125": "1/8x",
  };
  return known[String(Number(speed.toFixed(4)))] ?? `${Number(speed.toFixed(3))}x`;
}

/**
 * When two periods come back into phase, in master steps.
 *
 * Takes **periods**, not lengths — a period may be fractional (a 16-step track at 3/4x runs
 * 21⅓ master steps), so the arithmetic is done in twenty-fourths and scaled back.
 */
export function alignmentOf(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0;
  const scaled = lcm(Math.round(a * SPEED_SCALE), Math.round(b * SPEED_SCALE));
  return scaled >= POLYMETER_LIMIT ? POLYMETER_LIMIT : scaled / SPEED_SCALE;
}

/** A reset worth considering, and what it would leave whole. */
export interface ResetOption {
  steps: number;
  /** Tracks that complete every pass at this reset. */
  complete: number[];
  /** Tracks this reset would interrupt mid-figure. */
  cut: number[];
  /** True when this is the full polymeter — every track completes and they all realign. */
  full: boolean;
  /** True when the value is past what the field holds, so only INF achieves it. */
  beyondField: boolean;
}

/**
 * The resets worth offering, shortest first.
 *
 * **The question is "what do I set so the polyrhythm runs its full length", and the answer is a
 * short list rather than one number.** The full polymeter always works, and is sometimes far longer
 * than anyone wants a pattern to be; the useful middle ground is the values that keep *most* tracks
 * whole. Those are exactly the least common multiples of subsets of the distinct lengths — a
 * candidate that is not one of those leaves the same tracks whole as the next one down and is
 * strictly worse.
 *
 * Only **Pareto-optimal** options are returned: an option is dropped when some other is no longer
 * and leaves at least as many tracks whole. That is what keeps the list to two or three rows
 * instead of sixteen.
 *
 * Enumerating subsets is exponential, so it is capped. No corpus pattern has more than four
 * distinct lengths; the cap exists so a future producer with sixteen cannot hang the page, and it
 * degrades by considering the shortest lengths, which are the ones that get cut.
 */
export function resetOptions(tracks: readonly AnalysisTrack[]): ResetOption[] {
  const groups = periodGroups(tracks);
  if (groups.length === 0) return [];
  /*
   * **Sixteen tracks is the ceiling, so sixteen distinct lengths is, and 2^16 subsets is nothing.**
   * The cap is not a guess about what patterns look like — it is the number of tracks the machine
   * has. A producer handing over more than that is not describing a Digitone pattern, and taking
   * the shortest sixteen is the safe reading because short lengths are the ones a reset cuts.
   */
  const MAX_GROUPS = 16;
  // Scaled to twenty-fourths so a fractional period does not turn the subset arithmetic into floats.
  const periods = groups.slice(0, MAX_GROUPS).map((g) => Math.round(g.period * SPEED_SCALE));

  const candidates = new Set<number>();
  for (let mask = 1; mask < 1 << periods.length; mask++) {
    let value = SPEED_SCALE;
    for (let i = 0; i < periods.length; i++) if (mask & (1 << i)) value = lcm(value, periods[i]!);
    // `lcm` saturates, so a subset that runs past the limit lands on it. Offering that as a reset
    // would be offering a number the field cannot hold and the arithmetic did not really produce.
    const steps = value / SPEED_SCALE;
    // A reset is set in whole steps on the instrument, so a fractional candidate is not settable.
    if (steps > 0 && steps < POLYMETER_LIMIT && Number.isInteger(steps)) candidates.add(steps);
  }

  const whole = cycleSteps(tracks);
  const options: ResetOption[] = [...candidates].sort((a, b) => a - b).map((steps) => {
    const complete: number[] = [], cut: number[] = [];
    for (const t of tracks) {
      const passes = steps / masterPeriod(t);
      (Number.isInteger(Number(passes.toFixed(6))) ? complete : cut).push(t.number);
    }
    return { steps, complete, cut, full: steps === whole, beyondField: steps > RESET_FIELD_MAX };
  });

  // Pareto front: drop anything a shorter option already matches or beats.
  const kept: ResetOption[] = [];
  let best = -1;
  for (const option of options) {
    if (option.complete.length > best) { kept.push(option); best = option.complete.length; }
  }
  return kept;
}

/** Steps to seconds at a tempo, in sixteenths. */
export function stepsToSeconds(steps: number, tempo: number, speed = 1): number {
  return (steps / speed) * (60 / tempo / 4);
}

/** `m:ss.s`, for a duration that is usually under an hour and sometimes under a second. */
export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, "0")}`;
}

/**
 * Voices held by a gate at each step of a window.
 *
 * A chord trig spends one voice **per note**. Tracks repeat into the window at their own length,
 * which is what makes a short track able to push the total over the budget on its own.
 */
export function voicesPerStep(tracks: readonly AnalysisTrack[], windowSteps: number): number[] {
  const held = new Array<number>(windowSteps).fill(0);
  for (const t of tracks) {
    // On the master clock: a track at 3/2x fits its pass into two thirds of the steps. A length
    // below 1 would never advance `rep * stride` to the window; see `cycleSteps`.
    const stride = t.length >= 1 ? masterPeriod(t) : windowSteps;
    for (let rep = 0; rep * stride < windowSteps; rep++) {
      for (const g of t.trigs) {
        const at = Math.round(rep * stride + masterOffset(t, g.step));
        if (at >= windowSteps) continue;
        for (let k = 0; k < g.length && at + k < windowSteps; k++) held[at + k]! += g.notes.length;
      }
    }
  }
  return held;
}

/** One pitch class, with who sounds it. */
export interface PitchCell {
  name: string;
  total: number;
  /** Keyed by `MACHINE` value; `-1` collects tracks whose machine is unknown. */
  byMachine: Record<number, number>;
  byPreset: Record<string, number>;
  byTrack: Record<number, number>;
}

/** Pitch class → total, and the presets and machines that sound it. */
export function pitchByPreset(tracks: readonly AnalysisTrack[]): PitchCell[] {
  const out: PitchCell[] = NOTE_NAMES.map((name) => ({
    name, total: 0, byMachine: {}, byPreset: {}, byTrack: {},
  }));
  for (const t of tracks) {
    for (const g of t.trigs) {
      const preset = presetOf(t, g);
      const machine = t.machine ?? -1;
      for (const note of g.notes) {
        const cell = out[pitchClass(note)]!;
        cell.total++;
        cell.byMachine[machine] = (cell.byMachine[machine] ?? 0) + 1;
        cell.byPreset[preset] = (cell.byPreset[preset] ?? 0) + 1;
        cell.byTrack[t.number] = (cell.byTrack[t.number] ?? 0) + 1;
      }
    }
  }
  return out;
}

export interface MicroBuckets {
  /** Trigs sitting exactly on the grid. Excluded from the buckets on purpose. */
  onGrid: number;
  buckets: { at: number; n: number }[];
}

/** Microtiming gathered into six-tick buckets, with the on-grid trigs counted separately. */
export function microBuckets(tracks: readonly AnalysisTrack[]): MicroBuckets {
  const map = new Map<number, number>();
  let onGrid = 0;
  for (const t of tracks) {
    for (const g of t.trigs) {
      if (g.microTiming === 0) { onGrid++; continue; }
      const b = Math.round(g.microTiming / 6) * 6;
      map.set(b, (map.get(b) ?? 0) + 1);
    }
  }
  return {
    onGrid,
    buckets: [...map].map(([at, n]) => ({ at, n })).sort((a, b) => a.at - b.at),
  };
}

/** Two notes on one track whose gates overlap. `wrap` means it happens across the track's end. */
export interface OverlapPair {
  a: AnalysisTrig;
  b: AnalysisTrig;
  wrap?: boolean;
}

/**
 * Notes that overlap in time on the same track.
 *
 * **This is the geometric half of a glide, and only the geometric half.** A glide is two notes
 * overlapping on a *monophonic* track with *portamento* on. Per-trig portamento is readable —
 * `PORT` is lock id 99 and `PTIM` is 100 — but the track-level default and mono/poly both live on
 * the preset's SETUP page, which no capture has covered.
 *
 * So this reports an overlap and says so. Calling these glides would assert two settings nothing
 * here can read.
 */
export function overlappingNotes(track: AnalysisTrack): OverlapPair[] {
  const sorted = [...track.trigs].sort((x, y) => x.step - y.step);
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    if (a.step + a.length > b.step) pairs.push({ a, b });
  }
  const last = sorted.at(-1), first = sorted[0];
  if (last && first && last !== first && last.step + last.length > track.length + first.step) {
    pairs.push({ a: last, b: first, wrap: true });
  }
  return pairs;
}

/** Tracks sounding at a given step, so a peak can be attributed rather than only reported. */
export function holdersAt(
  tracks: readonly AnalysisTrack[], windowSteps: number, step: number,
): { track: AnalysisTrack; note: string; velocity: number }[] {
  const out: { track: AnalysisTrack; note: string; velocity: number }[] = [];
  for (const t of tracks) {
    // On the master clock: a track at 3/2x fits its pass into two thirds of the steps. A length
    // below 1 would never advance `rep * stride` to the window; see `cycleSteps`.
    const stride = t.length >= 1 ? masterPeriod(t) : windowSteps;
    for (let rep = 0; rep * stride < windowSteps; rep++) {
      for (const g of t.trigs) {
        const at = Math.round(rep * stride + masterOffset(t, g.step));
        if (at <= step && step < at + g.length && at < windowSteps) {
          out.push({ track: t, note: noteName(g.notes[0] ?? 0), velocity: g.velocity });
        }
      }
    }
  }
  return out;
}

/* =========================================================================================
 * Key, and the fact that it belongs to a moment rather than to a pattern
 * ======================================================================================= */

/** Krumhansl–Schmuckler key profiles. Named because the method should be attributable. */
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(counts: readonly number[], profile: readonly number[], rot: number): number {
  const n = 12;
  const a = counts;
  const b = profile.map((_, i) => profile[(i - rot + 12 * 2) % n]!);
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export interface KeyFit {
  name: string;
  root: number;
  minor: boolean;
  /** The winning correlation. Read `margin` instead when asking how sure this is. */
  r: number;
  /** How far ahead of the runner-up. **This is the confidence, not `r`.** */
  margin: number;
  runnerUp: string;
  /** How many notes the fit was made from. A fit over four notes is not a fit. */
  notes: number;
}

/**
 * The best-fitting key for one window, and how much better it is than the runner-up.
 *
 * `margin` is the honest confidence. A window whose top two candidates score 0.71 and 0.70 has
 * found nothing, however high 0.71 looks — a relative minor shares six of its seven notes with its
 * major, so a strong correlation with a tiny margin is the normal case rather than the exception.
 */
export function fitKey(counts: readonly number[]): KeyFit {
  const cands: Omit<KeyFit, "margin" | "runnerUp" | "notes">[] = [];
  for (let rot = 0; rot < 12; rot++) {
    cands.push({ name: `${NOTE_NAMES[rot]} major`, root: rot, minor: false,
                 r: correlate(counts, KS_MAJOR, rot) });
    cands.push({ name: `${NOTE_NAMES[rot]} minor`, root: rot, minor: true,
                 r: correlate(counts, KS_MINOR, rot) });
  }
  cands.sort((a, b) => b.r - a.r);
  const best = cands[0]!, second = cands[1]!;
  return {
    ...best,
    margin: best.r - second.r,
    runnerUp: second.name,
    notes: counts.reduce((s, v) => s + v, 0),
  };
}

/**
 * Tracks that can say anything about key: the ones playing more than one pitch class.
 *
 * **Found by looking at a flat timeline.** With every track included, a 16-step window held about
 * eighty notes and the fit never moved once across 84 bars. The densest tracks are drums — a hat on
 * one pitch every step — and a single pitch class repeated eighty times is an immovable spike no
 * melodic line can outvote. The key analysis was measuring the drum kit.
 *
 * The test is **measured, not assumed**: a track with one distinct pitch class carries no harmonic
 * information whatever machine it runs, which catches drones and one-note bass ostinatos too.
 *
 * It looks at each trig's **root**, which is what the mockup measured and therefore what this
 * preserves. Whether a track that only ever plays one root but voices real chords over it should
 * count as harmonic is a live question, and changing it is a behaviour change, not an extraction.
 */
export function harmonic(tracks: readonly AnalysisTrack[]): AnalysisTrack[] {
  return tracks.filter(
    (t) => new Set(t.trigs.map((g) => pitchClass(g.notes[0] ?? 0))).size > 1,
  );
}

export interface PitchWindow {
  /** First step of the window. */
  at: number;
  counts: number[];
  fit: KeyFit;
}

/** Slide a window over the whole cycle, counting pitch classes in each. */
export function pitchWindows(
  tracks: readonly AnalysisTrack[], total: number, win: number, hop: number,
): PitchWindow[] {
  const out: PitchWindow[] = [];
  for (let at = 0; at + win <= total; at += hop) {
    const counts = new Array<number>(12).fill(0);
    for (const t of tracks) {
      const stride = t.length >= 1 ? masterPeriod(t) : total;
      for (let rep = 0; rep * stride < total; rep++) {
        for (const g of t.trigs) {
          const s = Math.round(rep * stride + masterOffset(t, g.step));
          if (s >= at && s < at + win) for (const note of g.notes) counts[pitchClass(note)]!++;
        }
      }
    }
    out.push({ at, counts, fit: fitKey(counts) });
  }
  return out;
}

/* =========================================================================================
 * Naming a chord, which is an inference on top of an inference
 * ======================================================================================= */

const CHORD_SHAPES: readonly (readonly [readonly number[], string])[] = [
  [[0, 4, 7], ""], [[0, 3, 7], "m"], [[0, 3, 6], "dim"], [[0, 4, 8], "aug"],
  [[0, 5, 7], "sus4"], [[0, 2, 7], "sus2"],
  [[0, 4, 7, 11], "maj7"], [[0, 3, 7, 10], "m7"], [[0, 4, 7, 10], "7"],
  [[0, 3, 6, 10], "m7b5"], [[0, 3, 6, 9], "dim7"], [[0, 4, 7, 9], "6"], [[0, 3, 7, 9], "m6"],
  [[0, 2, 4, 7], "add9"], [[0, 2, 5, 7], "sus4add9"],
];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const DEGREE = ["I", "II", "III", "IV", "V", "VI", "VII"];
const INTERVALS: Record<number, string> = {
  1: "minor 2nd", 2: "major 2nd", 3: "minor 3rd", 4: "major 3rd", 5: "4th", 6: "tritone",
  7: "5th", 8: "minor 6th", 9: "major 6th", 10: "minor 7th", 11: "major 7th",
};

export interface ChordName {
  name: string;
  /** The reading — "iv in D minor", "approximate", "single note". Empty when there is nothing to add. */
  kind: string;
}

/**
 * A **possible** name for a set of pitch classes, read against a key.
 *
 * Every template is tried against every root and the best match wins, with ties broken toward the
 * root diatonic to the supplied key — the same D F A is *i in D minor* in one bar and *vi in F
 * major* in another, and only the surrounding key has an opinion about which.
 *
 * **Two inferences stacked.** The key underneath is a fit, and a vertical set of notes is not the
 * same thing as a chord somebody played. Callers say so where they show it.
 */
export function chordName(pcs: readonly number[], key?: KeyFit): ChordName | null {
  const set = [...new Set(pcs)].sort((a, b) => a - b);
  if (set.length === 0) return null;
  if (set.length === 1) return { name: NOTE_NAMES[set[0]!]!, kind: "single note" };
  if (set.length === 2) {
    const iv = (set[1]! - set[0]! + 12) % 12;
    return {
      name: `${NOTE_NAMES[set[0]!]}+${NOTE_NAMES[set[1]!]}`,
      kind: INTERVALS[iv] ?? "dyad",
    };
  }

  const scale = key?.minor ? MINOR_SCALE : MAJOR_SCALE;
  const inKey = (pc: number) => (key ? scale.includes((pc - key.root + 12) % 12) : false);

  let best: { score: number; root: number; suffix: string; exact: boolean } | null = null;
  for (let root = 0; root < 12; root++) {
    const rel = set.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b);
    for (const [shape, suffix] of CHORD_SHAPES) {
      const covered = shape.filter((iv) => rel.includes(iv)).length;
      const extra = rel.filter((iv) => !shape.includes(iv)).length;
      // Exact matches first; then the shape that explains the most notes with the fewest strays.
      const score = covered * 3 - extra * 2 - Math.abs(shape.length - rel.length)
        + (inKey(root) ? 1 : 0);
      if (covered < 3) continue;
      if (!best || score > best.score) {
        best = { score, root, suffix, exact: extra === 0 && covered === shape.length };
      }
    }
  }
  if (!best) {
    return { name: set.map((pc) => NOTE_NAMES[pc]).join(" "), kind: "no common shape" };
  }

  let kind = best.exact ? "" : "approximate";
  if (key) {
    const scaleDeg = (key.minor ? MINOR_SCALE : MAJOR_SCALE)
      .indexOf((best.root - key.root + 12) % 12);
    if (scaleDeg >= 0) {
      const numeral = best.suffix.startsWith("m") || best.suffix === "dim"
        ? DEGREE[scaleDeg]!.toLowerCase() : DEGREE[scaleDeg]!;
      kind = `${numeral}${best.suffix === "dim" ? "°" : ""} in ${key.name}`
        + (best.exact ? "" : ", approximate");
    }
  }
  return { name: `${NOTE_NAMES[best.root]}${best.suffix}`, kind };
}

/** One window of one track: the distinct notes sounding, low to high, and a name for them. */
export interface TrackCell {
  at: number;
  /** Distinct MIDI notes sounding in this window, ascending. */
  stack: number[];
  /** How often each of those notes sounds. */
  counts: Map<number, number>;
  /** Total note events in the window — the density the stack deliberately does not show. */
  n: number;
  chord: ChordName | null;
}

export interface TrackRow {
  track: AnalysisTrack;
  cells: TrackCell[];
}

/**
 * What each track has sounding in each window, as a set of real note numbers.
 *
 * `keyAt(i)` supplies the key a cell's chord is read against. **A function rather than an array**
 * so the caller decides the scale of the context: a per-bar view uses that bar's own fit, a
 * four-bar view uses the fit over all four, because a key fitted to one beat would be noise.
 *
 * **One entry per distinct note, not per trig.** A bass repeating one note eight times in a bar is
 * one line — the stack answers *what is sounding here*, and density already has its own chart.
 */
export function trackWindows(
  tracks: readonly AnalysisTrack[],
  total: number,
  win: number,
  hop: number,
  keyAt?: (index: number) => KeyFit | undefined,
): TrackRow[] {
  const rows: TrackRow[] = tracks.map((track) => ({ track, cells: [] }));
  let w = 0;
  for (let at = 0; at + win <= total; at += hop, w++) {
    for (const row of rows) {
      const counts = new Map<number, number>();
      const stride = row.track.length >= 1 ? masterPeriod(row.track) : total;
      for (let rep = 0; rep * stride < total; rep++) {
        for (const g of row.track.trigs) {
          const st = Math.round(rep * stride + masterOffset(row.track, g.step));
          if (st < at || st >= at + win) continue;
          for (const n of g.notes) counts.set(n, (counts.get(n) ?? 0) + 1);
        }
      }
      const stack = [...counts.keys()].sort((a, b) => a - b);
      row.cells.push({
        at,
        stack,
        counts,
        n: [...counts.values()].reduce((acc, v) => acc + v, 0),
        chord: chordName(stack.map((n) => pitchClass(n)), keyAt?.(w)),
      });
    }
  }
  return rows;
}
