import assert from "node:assert/strict";
import { test } from "node:test";
import { clear, moveMany, swap } from "../src/librarian/shuffle.js";
import { type TrackSummary } from "../src/librarian/tracksummary.js";
import { MACHINE } from "../src/project/machine.js";
import {
  FIRST_STEP,
  REFERENCE,
  chooseSeeds,
  expectedAfter,
  expectationsFor,
  stepsFor,
} from "../src/hardwaretest/track.js";

/** A track summary with everything defaulted, so each test states only what it is about. */
function track(index: number, over: Partial<TrackSummary> = {}): TrackSummary {
  return {
    index,
    label: `T${index + 1}`,
    presetName: "",
    machine: "FM TONE",
    machineValue: MACHINE.fmTone,
    midi: false,
    trigCount: 0,
    lockCount: 0,
    level: 100,
    empty: true,
    ...over,
  };
}

/** The captured blank: named per track, exactly as the device writes it. */
const BLANK: TrackSummary[] = Array.from({ length: 16 }, (_, i) =>
  track(i, { presetName: `PRESET ${i + 1}` }),
);

/** A pattern good enough to seed the test: two named synth tracks, locks, a MIDI track, spares. */
function usablePattern(): TrackSummary[] {
  const tracks = BLANK.map((t) => ({ ...t }));
  tracks[0] = track(0, { presetName: "KICK", trigCount: 36, lockCount: 0, empty: false });
  tracks[1] = track(1, { presetName: "SHAKER", trigCount: 12, lockCount: 4, empty: false, level: 79 });
  tracks[4] = track(4, { presetName: "", midi: true, machine: undefined, trigCount: 4, empty: false });
  return tracks;
}

function seedsOf(tracks: TrackSummary[]) {
  const choice = chooseSeeds(tracks);
  assert.ok("seeds" in choice, `expected usable seeds, got: ${"problem" in choice ? choice.problem : ""}`);
  return choice.seeds;
}

// --- choosing seeds ------------------------------------------------------------------------

test("the locked track is the one with the most locks", () => {
  // A single lock proves a record survived; several prove the table was rebuilt in order. The
  // lock-table regression is the main reason the session exists, so this choice is not arbitrary.
  const tracks = usablePattern();
  tracks[0] = track(0, { presetName: "KICK", trigCount: 36, lockCount: 1, empty: false });
  assert.equal(seedsOf(tracks).locked, 1, "T2 has four locks to T1's one");
});

test("a pattern with no locks anywhere is refused", () => {
  const tracks = usablePattern();
  tracks[1] = track(1, { presetName: "SHAKER", trigCount: 12, lockCount: 0, empty: false });
  const choice = chooseSeeds(tracks);
  assert.ok("problem" in choice);
  assert.match(choice.problem, /parameter locks/);
});

test("a pattern whose named tracks all share a name is refused", () => {
  // A swap between two tracks called the same thing looks identical either way, so the sheet
  // would read as precise and check nothing — the same trap `seedNameProblem` guards one level up.
  const tracks = usablePattern();
  tracks[0] = track(0, { presetName: "SHAKER", trigCount: 36, empty: false });
  const choice = chooseSeeds(tracks);
  assert.ok("problem" in choice);
  assert.match(choice.problem, /named "SHAKER"/);
});

/** A usable pattern with every track occupied except the holes named, so spares are forced. */
function withHolesAt(...holes: number[]): TrackSummary[] {
  const tracks = usablePattern();
  for (let i = 2; i < 16; i++) {
    if (i === 4) continue; // the MIDI track, which is already occupied
    tracks[i] = holes.includes(i)
      ? track(i, { presetName: `PRESET ${i + 1}` })
      : track(i, { presetName: `PRESET ${i + 1}`, trigCount: 1, empty: false });
  }
  return tracks;
}

test("the spare tracks are adjacent, because that is where a batch lands", () => {
  // moveMany([a, b], to) puts the second source at `to + 1`. Spares chosen independently would
  // have the sheet claim the second source arrives somewhere the batch never writes.
  assert.deepEqual(seedsOf(withHolesAt(9, 10)).spare, [9, 10]);
});

test("scattered single empty tracks are refused rather than paired up", () => {
  const choice = chooseSeeds(withHolesAt(9, 12));
  assert.ok("problem" in choice);
  assert.match(choice.problem, /adjacent/);
});

test("a missing MIDI track is not a refusal", () => {
  // MIDI tracks are rare in a sketch, and eleven of thirteen rows are still worth a session.
  const tracks = usablePattern();
  tracks[4] = track(4, { presetName: "PRESET 5" });
  assert.equal(seedsOf(tracks).midi, undefined);
});

test("every refusal names what is missing, not what to do about it", () => {
  // The reason is printed whole in two places, one of which is a one-line survey row. A message
  // carrying advice has to be truncated to fit, and truncation lands mid-sentence.
  const noLocks = usablePattern();
  noLocks[1] = track(1, { presetName: "SHAKER", trigCount: 12, empty: false });
  const choice = chooseSeeds(noLocks);
  assert.ok("problem" in choice);
  assert.ok(choice.problem.length < 100, `"${choice.problem}" is too long for a survey row`);
  assert.doesNotMatch(choice.problem, /--pattern|Re-run|pick a/i, "advice belongs to the caller");
});

// --- what each scope should leave behind ----------------------------------------------------

test("a composite move takes both halves and the level", () => {
  const before = usablePattern();
  const after = expectedAfter(before, BLANK, moveMany([1], 0), 0, "both");
  assert.equal(after.presetName, "SHAKER");
  assert.equal(after.trigCount, 12);
  assert.equal(after.lockCount, 4);
  assert.equal(after.level, 79, "only the composite carries the level");
});

test("a sequence move leaves the destination's preset alone", () => {
  // The device's own TRACK SEQUENCE paste. If this returned the source's preset name, the sheet
  // would describe an operation the tool does not perform — and read plausibly while doing it.
  const before = usablePattern();
  const after = expectedAfter(before, BLANK, moveMany([1], 0), 0, "sequence");
  assert.equal(after.presetName, "KICK", "the destination keeps its own sound");
  assert.equal(after.trigCount, 12, "and plays the source's notes");
  assert.equal(after.lockCount, 4, "locks are sequence-side, so they travel");
  assert.equal(after.level, 100, "LEVEL is in the kit, not the preset");
});

test("a preset move leaves the destination's trigs alone", () => {
  const before = usablePattern();
  const after = expectedAfter(before, BLANK, moveMany([1], 0), 0, "preset");
  assert.equal(after.presetName, "SHAKER");
  assert.equal(after.trigCount, 36, "the destination keeps its own notes");
  assert.equal(after.lockCount, 0);
  assert.equal(after.level, 100);
});

test("an emptied track takes the blank's name for its own number", () => {
  // Not the empty string: the captured blank names each track PRESET 1..PRESET 16, and a
  // cleared T2 gets PRESET 2 rather than PRESET 1. Assuming an emptied track came back
  // nameless is what the generator's guard caught before any sheet was printed.
  const before = usablePattern();
  const after = expectedAfter(before, BLANK, clear(1), 1, "both");
  assert.equal(after.presetName, "PRESET 2");
  assert.equal(after.initialised, true);
  assert.equal(after.trigCount, 0);
  assert.equal(after.lockCount, 0);
});

test("a sequence-only clear keeps the sound", () => {
  const before = usablePattern();
  const after = expectedAfter(before, BLANK, clear(1), 1, "sequence");
  assert.equal(after.presetName, "SHAKER");
  assert.equal(after.initialised, false);
  assert.equal(after.trigCount, 0);
});

test("a preset-only clear keeps the trigs and the locks", () => {
  const before = usablePattern();
  const after = expectedAfter(before, BLANK, clear(1), 1, "preset");
  assert.equal(after.presetName, "PRESET 2");
  assert.equal(after.initialised, true);
  assert.equal(after.trigCount, 12, "the notes stay even though the sound under them went");
  assert.equal(after.lockCount, 4);
});

test("the MIDI flag follows the preset, not the sequence", () => {
  // The regression PR #33 fixed: the mask at kit +10,260 was in no region, so a moved MIDI
  // track arrived as a synth track. It is preset-side, so a sequence move must not carry it.
  const before = usablePattern();
  assert.equal(expectedAfter(before, BLANK, moveMany([4], 9), 9, "both").midi, true);
  assert.equal(expectedAfter(before, BLANK, moveMany([4], 9), 9, "preset").midi, true);
  assert.equal(expectedAfter(before, BLANK, moveMany([4], 9), 9, "sequence").midi, false);
});

test("a swap crosses both ways in one shuffle", () => {
  const before = usablePattern();
  const shuffle = swap(1, 4);
  assert.equal(expectedAfter(before, BLANK, shuffle, 1, "both").midi, true, "T2 becomes MIDI");
  assert.equal(expectedAfter(before, BLANK, shuffle, 4, "both").midi, false, "T5 stops being MIDI");
  assert.equal(expectedAfter(before, BLANK, shuffle, 4, "both").presetName, "SHAKER");
});

// --- the steps themselves --------------------------------------------------------------------

test("every step gets its own pattern, from A2 upward", () => {
  // One operation per pattern is the whole layout: a bug in one cannot corrupt the evidence for
  // another, and A1 stays readable as the before.
  const before = usablePattern();
  const steps = stepsFor(seedsOf(before), before);
  const patterns = steps.map((s) => s.pattern);
  assert.equal(new Set(patterns).size, patterns.length, "two steps share a pattern");
  assert.equal(Math.min(...patterns), FIRST_STEP);
  assert.ok(!patterns.includes(REFERENCE), "the reference must never be written to");
});

test("the two regressions and the three scopes come first", () => {
  // A session that runs out of time should already have answered the questions it was called
  // for. Ordering by kind instead would bury the MIDI mask behind four routine copies.
  const before = usablePattern();
  const steps = stepsFor(seedsOf(before), before);
  const firstFive = steps.slice(0, 5);
  assert.deepEqual(
    firstFive.map((s) => s.scope),
    ["both", "sequence", "preset", "both", "both"],
  );
  assert.ok(firstFive.slice(3).every((s) => /MIDI/.test(s.operation)), "rows 4 and 5 are the mask");
});

test("all four scope corners of a clear are covered", () => {
  const before = usablePattern();
  const steps = stepsFor(seedsOf(before), before);
  const clears = steps.filter((s) => s.operation.startsWith("Clear"));
  assert.deepEqual(clears.map((s) => s.scope).sort(), ["both", "preset", "sequence"]);
});

test("the MIDI rows are dropped, not faked, when there is no MIDI track", () => {
  const before = usablePattern();
  before[4] = track(4, { presetName: "PRESET 5" });
  const steps = stepsFor(seedsOf(before), before);
  assert.ok(steps.every((s) => !/MIDI/.test(s.operation)));
  assert.deepEqual(
    steps.map((s) => s.n),
    steps.map((_, i) => i + 1),
    "the remaining steps renumber, so the sheet has no gaps",
  );
});

test("a step only claims things about the tracks it says to inspect", () => {
  // The tester's time is the scarce resource. A step that listed untouched tracks would spend it
  // confirming that nothing happened somewhere nothing was asked to happen.
  const before = usablePattern();
  const seeds = seedsOf(before);
  for (const step of stepsFor(seeds, before)) {
    const expected = expectationsFor(step, before, BLANK);
    assert.deepEqual(
      expected.map((e) => e.track),
      step.inspect,
      `step ${step.n} inspects tracks it makes no claim about`,
    );
    assert.ok(expected.length > 0, `step ${step.n} claims nothing`);
  }
});

test("every step actually changes something on every track it inspects", () => {
  // A row where the expectation equals the reference is a row the tester cannot fail. There is
  // one deliberate exception — a copy leaves its source alone, and saying so is the point.
  const before = usablePattern();
  const steps = stepsFor(seedsOf(before), before);
  const unchanged: string[] = [];
  for (const step of steps) {
    for (const e of expectationsFor(step, before, BLANK)) {
      const was = before[e.track]!;
      const same =
        e.presetName === was.presetName && e.trigCount === was.trigCount && e.midi === was.midi;
      if (same) unchanged.push(`${step.n}/${e.track}`);
    }
  }
  const copies = steps.filter((s) => s.operation.startsWith("Copy")).length;
  assert.equal(
    unchanged.length,
    copies,
    `only the copy sources should be unchanged, but ${unchanged.join(", ")} are`,
  );
});

test("destructive is declared wherever something is overwritten", () => {
  // The librarian refuses to apply a destructive shuffle without acknowledgement, so a step that
  // under-declares would stop the generator rather than ship a wrong sheet — but only when it
  // was run. Checking it here means the claim is true before anything is built.
  const before = usablePattern();
  const steps = stepsFor(seedsOf(before), before);
  for (const step of steps) {
    const overwrites = expectationsFor(step, before, BLANK).some((e) => {
      const was = before[e.track]!;
      return !was.empty && (e.presetName !== was.presetName || e.trigCount !== was.trigCount);
    });
    assert.equal(step.destructive, overwrites, `step ${step.n} declares destructive wrongly`);
  }
});
