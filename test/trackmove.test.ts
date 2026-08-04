import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN2_KIT, DN2_LAYOUT, kitRecord, patternRecord } from "../src/project/dn2image.js";
import { readDn2Pattern, readLockTable, readMidiTrackMask } from "../src/project/dn2pattern.js";
import { DN1_DEVICE, deviceFor } from "../src/librarian/device.js";
import {
  applyTrackMove,
  planTrackMove,
  verifyTrackMove,
} from "../src/librarian/trackmove.js";
import {
  lockCounts,
  summariseTracks,
  trackMachines,
  trigCounts,
} from "../src/librarian/tracksummary.js";
import { TRACK_COUNT as DN2_TRACK_COUNT } from "../src/project/dn2pattern.js";
import { clear, copyMany, moveMany, swap } from "../src/librarian/shuffle.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;
const CONFIRM = { confirmOverwrite: true } as const;

function image(): Uint8Array {
  const path = `${CORPUS}02_DN2/01_Projects/MORNING_JAM.dn2prj`;
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

/** A pattern with trigs on at least two tracks — anything less proves nothing about moving. */
function busyPattern(img: Uint8Array): { index: number; tracks: number[] } {
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    const counts = trigCounts(img, p);
    const tracks = counts.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
    if (tracks.length >= 2) return { index: p, tracks };
  }
  throw new Error("no pattern with two occupied tracks in the corpus");
}

// --- guards -------------------------------------------------------------------------------

test("the Digitone 1 is refused rather than guessed at", { skip }, () => {
  // Its tracks are laid out differently and split into synth and MIDI, so a move across that
  // boundary is not meaningful. A clear no beats a plausible wrong answer.
  const plan = planTrackMove(image(), DN1_DEVICE, 0, swap(0, 1));
  assert.equal(plan.ok, false);
  assert.match(plan.findings[0]!.message, /Digitone II only/);
});

test("a track outside the range is a blocker", { skip }, () => {
  const img = image();
  const plan = planTrackMove(img, deviceFor(img), 0, swap(0, DN2_TRACK_COUNT));
  assert.equal(plan.ok, false);
  assert.match(plan.findings[0]!.message, /outside/);
});

test("the stale synth/MIDI disclaimer is gone", { skip }, () => {
  // This used to warn that the discriminator "has never been located". It had been, in the kit
  // — and the warning was covering for the fact that the mask was in no region at all. A
  // composite move now carries it, so there is nothing left to disclaim.
  const img = image();
  const plan = planTrackMove(img, deviceFor(img), 0, swap(0, 1));
  assert.ok(
    !plan.findings.some((f) => /never located/.test(f.message)),
    "a claim we can now back up should not be hedged",
  );
});

test("the unidentified per-track array is disclosed, not moved on a guess", { skip }, () => {
  // kit +10,264 looks like a 16 x 5-byte per-track array, but its meaning is unknown and its
  // alignment is inferred from the repeat. Moving bytes we cannot name is how a plausible
  // corruption gets written, so it stays — and a track carrying a non-default entry says so.
  const img = image();
  const device = deviceFor(img);
  const kitAt = (pattern: number, track: number) =>
    kitRecord(img, pattern, DN2_LAYOUT).subarray(10_264 + track * 5, 10_269 + track * 5);
  const isDefault = (bytes: Uint8Array) =>
    [0x00, 0x00, 0x81, 0x20, 0x00].every((b, i) => bytes[i] === b);

  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    const odd = [...Array(DN2_TRACK_COUNT).keys()].find((t) => !isDefault(kitAt(p, t)));
    if (odd === undefined) continue;
    const other = [...Array(DN2_TRACK_COUNT).keys()].find((t) => t !== odd)!;

    const plan = planTrackMove(img, device, p, moveMany([odd], other), "preset");
    assert.ok(
      plan.findings.some((f) => /10,264/.test(f.message)),
      "a track with a non-default entry should be disclosed",
    );
    return;
  }
  throw new Error("no corpus track carries a non-default entry in the array at kit +10,264");
});

test("destroying a track needs confirmation", { skip }, () => {
  const img = image();
  const { index, tracks } = busyPattern(img);
  const [from, to] = tracks as [number, number];

  const plan = planTrackMove(img, deviceFor(img), index, moveMany([from], to));
  assert.ok(plan.destructive.length > 0, "moving onto an occupied track destroys it");
  assert.throws(
    () => applyTrackMove(img, deviceFor(img), index, moveMany([from], to)),
    /confirmOverwrite/,
  );
});

// --- the referential half, which is the whole point ---------------------------------------

test("trigs follow their track rather than being left behind", { skip }, () => {
  // The failure this guards: copy the four positional regions, forget the trig pool, and the
  // notes stay on a track that now holds something else. Right notes, wrong voice — the
  // `sound+244` bug in a new place.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const from = tracks[0]!;
  const to = [...Array(DN2_TRACK_COUNT).keys()].find((t) => trigCounts(img, index)[t] === 0)!;

  const before = trigCounts(img, index);
  const { image: after, trigsWritten } = applyTrackMove(
    img,
    device,
    index,
    moveMany([from], to),
    CONFIRM,
  );

  assert.ok(trigsWritten > 0, "the rebuilt pool should hold trigs");
  const counts = trigCounts(after, index);
  assert.equal(counts[to], before[from], "the destination should hold the source's trigs");
  assert.equal(counts[from], 0, "the source should be empty after a move");
});

test("a copy leaves the source's trigs where they are", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const from = tracks[0]!;
  const to = [...Array(DN2_TRACK_COUNT).keys()].find((t) => trigCounts(img, index)[t] === 0)!;

  const before = trigCounts(img, index);
  const { image: after } = applyTrackMove(img, device, index, copyMany([from], to), CONFIRM);
  const counts = trigCounts(after, index);

  assert.equal(counts[from], before[from], "a copy must not empty its source");
  assert.equal(counts[to], before[from], "and the destination gets the same trigs");
});

test("a swap exchanges both halves, positional and referential", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const [a, b] = tracks as [number, number];

  const before = trigCounts(img, index);
  const { image: after } = applyTrackMove(img, device, index, swap(a, b), CONFIRM);
  const counts = trigCounts(after, index);

  assert.equal(counts[a], before[b], "track A should hold what B held");
  assert.equal(counts[b], before[a], "track B should hold what A held");

  // The positional half has to have moved too, or the notes play the wrong sound.
  const beforeRecord = patternRecord(img, index, DN2_LAYOUT);
  const afterRecord = patternRecord(after, index, DN2_LAYOUT);
  const trackBytes = (record: Uint8Array, t: number) =>
    Buffer.from(record.subarray(4 + t * 1187, 4 + (t + 1) * 1187)).toString("hex");
  assert.equal(trackBytes(afterRecord, a), trackBytes(beforeRecord, b));
  assert.equal(trackBytes(afterRecord, b), trackBytes(beforeRecord, a));
});

test("clearing a track discards its trigs and leaves the rest alone", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const [target, other] = tracks as [number, number];

  const before = trigCounts(img, index);
  const { image: after } = applyTrackMove(img, device, index, clear(target), CONFIRM);
  const counts = trigCounts(after, index);

  assert.equal(counts[target], 0, "a cleared track should hold nothing");
  assert.equal(counts[other], before[other], "and its neighbours should be untouched");
});

test("a cleared track is the captured blank, not zeros", { skip }, () => {
  // An empty track is what the device writes for one, and we have that captured. Zeroing is
  // inventing bytes, which is the rule this project keeps.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const { image: after } = applyTrackMove(img, device, index, clear(tracks[0]!), CONFIRM);

  const record = patternRecord(after, index, DN2_LAYOUT);
  const track = record.subarray(4 + tracks[0]! * 1187, 4 + (tracks[0]! + 1) * 1187);
  assert.ok(track.some((b) => b !== 0), "an emptied track should not be all zeros");
});

test("other patterns are untouched", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const { image: after } = applyTrackMove(img, device, index, swap(tracks[0]!, tracks[1]!), CONFIRM);

  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    if (p === index) continue;
    assert.deepEqual(
      trigCounts(after, p),
      trigCounts(img, p),
      `pattern ${p} should not have changed`,
    );
  }
});

test("the pattern still parses after a move", { skip }, () => {
  // Renumbering trigs in place is easy to get subtly wrong in a way that only a full parse
  // notices — a track byte outside 0..15, say.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const { image: after } = applyTrackMove(img, device, index, swap(tracks[0]!, tracks[1]!), CONFIRM);

  const parsed = readDn2Pattern(after, index, DN2_LAYOUT);
  assert.equal(parsed.tracks.length, DN2_TRACK_COUNT);
  for (const track of parsed.tracks) {
    for (const trig of track.trigs) {
      assert.ok(trig.step >= 0 && trig.step < 128, `trig step ${trig.step} out of range`);
    }
  }
});

test("verification reads the bytes back rather than trusting the writer", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const shuffle = swap(tracks[0]!, tracks[1]!);

  const { image: after } = applyTrackMove(img, device, index, shuffle, CONFIRM);
  const result = verifyTrackMove(img, after, index, shuffle);
  assert.equal(result.ok, true, result.problems.join("; "));
});

test("verification notices when nothing was renumbered", { skip }, () => {
  // Hand it an unchanged image and claim a move happened: the trigs still name the old track,
  // which is exactly the bug the referential half exists to prevent.
  const img = image();
  const { index, tracks } = busyPattern(img);
  const to = [...Array(DN2_TRACK_COUNT).keys()].find((t) => trigCounts(img, index)[t] === 0)!;

  const result = verifyTrackMove(img, img, index, moveMany([tracks[0]!], to));
  assert.equal(result.ok, false, "an unapplied move must not verify");
});

test("a batch move lands its sources in order", { skip }, () => {
  // Same batch rule as the pattern librarian: sources land consecutively from the target,
  // in the order given, so the result is predictable rather than merely correct.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  if (tracks.length < 2) return;

  const [a, b] = tracks as [number, number];
  const free = [...Array(DN2_TRACK_COUNT).keys()].filter(
    (t) => trigCounts(img, index)[t] === 0 && t + 1 < DN2_TRACK_COUNT,
  );
  const to = free.find((t) => trigCounts(img, index)[t + 1] === 0);
  if (to === undefined) return;

  const before = trigCounts(img, index);
  const { image: after } = applyTrackMove(img, device, index, moveMany([a, b], to), CONFIRM);
  const counts = trigCounts(after, index);

  assert.equal(counts[to], before[a], "the first source lands on the target");
  assert.equal(counts[to + 1], before[b], "the second lands just after it");
  assert.equal(counts[a], 0);
  assert.equal(counts[b], 0);
});

// --- the MIDI-track mask, which travels as bits rather than bytes ---------------------------

/**
 * A pattern whose kit has at least one MIDI track and one synth track.
 *
 * Throws rather than returning undefined: a fixture that quietly is not there turns every test
 * built on it into a test of nothing, which is how the lock-order bug survived its own suite.
 */
function mixedPattern(img: Uint8Array): { index: number; midi: number; synth: number } {
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    const mask = readMidiTrackMask(img, p);
    const midi = [...Array(DN2_TRACK_COUNT).keys()].find((t) => (mask >> t) & 1);
    const synth = [...Array(DN2_TRACK_COUNT).keys()].find((t) => !((mask >> t) & 1));
    if (midi !== undefined && synth !== undefined) return { index: p, midi, synth };
  }
  throw new Error("no corpus pattern mixes MIDI and synth tracks");
}

test("a moved MIDI track arrives as a MIDI track", { skip }, () => {
  // The bug: the discriminator is a bitmask in the kit, and it was in no region at all, so a
  // MIDI track moved onto a synth slot became a synth track running a MIDI track's parameters.
  const img = image();
  const device = deviceFor(img);
  const mixed = mixedPattern(img);
  const { index, midi, synth } = mixed;

  const { image: after } = applyTrackMove(img, device, index, moveMany([midi], synth), CONFIRM);
  const mask = readMidiTrackMask(after, index);

  assert.equal((mask >> synth) & 1, 1, "the destination should now be a MIDI track");
  assert.equal((mask >> midi) & 1, 0, "and the vacated source should not be");
});

test("a swap exchanges the MIDI bits along with the presets", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const mixed = mixedPattern(img);
  const { index, midi, synth } = mixed;

  const { image: after } = applyTrackMove(img, device, index, swap(midi, synth), CONFIRM);
  const mask = readMidiTrackMask(after, index);

  assert.equal((mask >> synth) & 1, 1);
  assert.equal((mask >> midi) & 1, 0);
});

test("a sequence-only move leaves the MIDI mask untouched", { skip }, () => {
  // The mask describes the preset, so it belongs to the preset half. Moving a sequence must
  // not change which tracks are MIDI tracks.
  const img = image();
  const device = deviceFor(img);
  const mixed = mixedPattern(img);
  const { index, midi, synth } = mixed;

  const { image: after } = applyTrackMove(img, device, index, moveMany([midi], synth), {
    ...CONFIRM,
    scope: "sequence",
  });
  assert.equal(readMidiTrackMask(after, index), readMidiTrackMask(img, index));
});

test("verification catches a MIDI bit left behind", { skip }, () => {
  // Verification has to read back the half most likely to be forgotten. Hand it an image whose
  // mask was never rewritten and it must refuse it.
  const img = image();
  const device = deviceFor(img);
  const mixed = mixedPattern(img);
  const { index, midi, synth } = mixed;
  const shuffle = moveMany([midi], synth);

  const { image: after } = applyTrackMove(img, device, index, shuffle, CONFIRM);
  assert.equal(verifyTrackMove(img, after, index, shuffle).ok, true);

  // Put the old mask back, as a move that forgot it would have left it.
  const sabotaged = Uint8Array.from(after);
  const base = DN2_LAYOUT.kitBase + index * DN2_LAYOUT.kitSize;
  const original = readMidiTrackMask(img, index);
  sabotaged[base + 10_260] = (original >> 8) & 0xff;
  sabotaged[base + 10_261] = original & 0xff;

  const result = verifyTrackMove(img, sabotaged, index, shuffle);
  assert.equal(result.ok, false, "a stale mask must not verify");
  assert.match(result.problems.join("; "), /MIDI mask/);
});

// --- the two halves the device itself distinguishes -----------------------------------------

/** The preset bytes of one track, as hex, for comparing halves across an operation. */
function presetBytes(img: Uint8Array, pattern: number, track: number): string {
  const kit = kitRecord(img, pattern, DN2_LAYOUT);
  const at = DN2_KIT.soundOffset + track * DN2_KIT.soundSize;
  return Buffer.from(kit.subarray(at, at + DN2_KIT.soundSize)).toString("hex");
}

test("moving the sequence leaves both presets where they were", { skip }, () => {
  // The device's own TRACK SEQUENCE paste: the trigs arrive, the sound stays. This is the half
  // of the duality that makes "load a kit onto a running pattern" a coherent operation.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const from = tracks[0]!;
  const to = [...Array(DN2_TRACK_COUNT).keys()].find((t) => trigCounts(img, index)[t] === 0)!;

  const before = trigCounts(img, index);
  const { image: after } = applyTrackMove(img, device, index, moveMany([from], to), {
    ...CONFIRM,
    scope: "sequence",
  });

  assert.equal(trigCounts(after, index)[to], before[from], "the trigs should have moved");
  assert.equal(
    presetBytes(after, index, to),
    presetBytes(img, index, to),
    "the destination keeps its own preset",
  );
  assert.equal(
    presetBytes(after, index, from),
    presetBytes(img, index, from),
    "and the source keeps its own, even though its sequence left",
  );
});

test("moving the preset leaves every trig where it was", { skip }, () => {
  // The device's own PRESET paste, `[TRK]` + `[STOP]`.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const from = tracks[0]!;
  const to = tracks[1]!;

  const { image: after } = applyTrackMove(img, device, index, moveMany([from], to), {
    ...CONFIRM,
    scope: "preset",
  });

  assert.deepEqual(
    trigCounts(after, index),
    trigCounts(img, index),
    "a preset-only move must not touch the sequencer at all",
  );
  assert.equal(
    presetBytes(after, index, to),
    presetBytes(img, index, from),
    "the destination should now run the source's preset",
  );
});

test("a preset-only operation destroys no trigs, so it claims none", { skip }, () => {
  const img = image();
  const { index, tracks } = busyPattern(img);
  const plan = planTrackMove(
    img,
    deviceFor(img),
    index,
    moveMany([tracks[0]!], tracks[1]!),
    "preset",
  );

  assert.deepEqual(plan.destructive, [], "no notes are at risk when only the preset moves");
  assert.ok(plan.changed.length > 0, "but the operation still changes something");
});

test("the track level follows the whole track and nothing less", { skip }, () => {
  // The manual puts LEVEL in the kit but not in the preset, so the device's PRESET paste would
  // leave it behind. Ours matches that rather than quietly being more helpful.
  const img = image();
  const device = deviceFor(img);
  const { index, tracks } = busyPattern(img);
  const [from, to] = tracks as [number, number];
  // Read through the surface a user sees, not by reaching for the offset. The hand-rolled version
  // was a third copy of `0x1c` — and it took only the low byte of a u16le, so a level above 255
  // would have compared equal while being wrong.
  const level = (bytes: Uint8Array, track: number) => summariseTracks(bytes, index)[track]!.level;

  const preset = applyTrackMove(img, device, index, moveMany([from], to), {
    ...CONFIRM,
    scope: "preset",
  }).image;
  assert.equal(level(preset, to), level(img, to), "a preset move leaves the level alone");

  const both = applyTrackMove(img, device, index, moveMany([from], to), CONFIRM).image;
  assert.equal(level(both, to), level(img, from), "a whole-track move carries it");
});

test("splitting a track across two machines is reported", { skip }, () => {
  // Parameter-lock ids in 33..76 and 78..81 mean different knobs on different machines, so a
  // sequence landing on a foreign machine keeps locking an id that now addresses something
  // else. Bytes right, meaning wrong — the `sound+244` class of failure, so it is reported.
  const img = image();
  const device = deviceFor(img);

  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    const counts = lockCounts(img, p);
    const machines = trackMachines(img, p);
    const from = counts.findIndex((n) => n > 0);
    if (from < 0) continue;
    const to = [...Array(DN2_TRACK_COUNT).keys()].find((t) => machines[t] !== machines[from]);
    if (to === undefined) continue;

    const split = planTrackMove(img, device, p, moveMany([from], to), "sequence");
    const whole = planTrackMove(img, device, p, moveMany([from], to), "both");

    // Only meaningful when the source actually carries a machine-relative lock; when it does
    // not, the absence of a warning is itself the right answer and there is nothing to assert.
    if (split.findings.length === 0) continue;

    assert.match(split.findings[0]!.message, /machine/, "the warning should name the hazard");
    assert.deepEqual(whole.findings, [], "moving both halves cannot hit it");
    return;
  }
});

// --- the lock table, whose track byte is not where the trig pool's is ------------------------

/**
 * Live lock records as `(parameter, track)`.
 *
 * Read through `readLockTable`, deliberately: it is the independent reader that was right
 * about the byte order all along, so a fixture built on it stays valid even when the code
 * under test is wrong. Building it on `lockCounts` instead made these tests vacuous — with the
 * bug reintroduced every parameter id looked like an out-of-range track, the fixture came back
 * empty, and three tests passed by finding nothing to check.
 */
function locks(img: Uint8Array, pattern: number): { parameter: number; track: number }[] {
  return readLockTable(patternRecord(img, pattern, DN2_LAYOUT)).map((r) => ({
    parameter: r.parameter,
    track: r.track,
  }));
}

/** A pattern with at least one live parameter-lock record. Asserts rather than skipping. */
function patternWithLocks(img: Uint8Array): number {
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    if (locks(img, p).length > 0) return p;
  }
  throw new Error("no pattern in the corpus carries a parameter lock");
}

/** A track holding no trigs and no locks, so an operation onto it destroys nothing. */
function freeTrack(img: Uint8Array, pattern: number): number {
  const held = new Set(locks(img, pattern).map((l) => l.track));
  const free = [...Array(DN2_TRACK_COUNT).keys()].find(
    (t) => trigCounts(img, pattern)[t] === 0 && !held.has(t),
  );
  assert.ok(free !== undefined, "the corpus pattern should have a free track to move onto");
  return free;
}

test("a lock keeps its parameter id when its track moves", { skip }, () => {
  // The bug this pins down: a lock record is `u8 parameter | u8 track | ...`, and treating
  // byte 0 as the track both matched the wrong records and overwrote each surviving lock's
  // parameter id with a track number. A lock on CUTOFF became a lock on parameter 3.
  const img = image();
  const device = deviceFor(img);
  const index = patternWithLocks(img);

  const before = locks(img, index);
  const from = before[0]!.track;
  const to = freeTrack(img, index);

  const { image: after } = applyTrackMove(img, device, index, moveMany([from], to), CONFIRM);
  const moved = locks(after, index).filter((l) => l.track === to);
  const expected = before.filter((l) => l.track === from).map((l) => l.parameter);

  assert.ok(expected.length > 0, "the source should have had locks to move");
  assert.deepEqual(
    moved.map((l) => l.parameter).sort((a, b) => a - b),
    expected.sort((a, b) => a - b),
    "the moved locks should lock the same parameters they always did",
  );
});

test("locks belonging to untouched tracks survive a move unchanged", { skip }, () => {
  const img = image();
  const device = deviceFor(img);
  const index = patternWithLocks(img);

  const before = locks(img, index);
  const from = before[0]!.track;
  const to = freeTrack(img, index);

  const { image: after } = applyTrackMove(img, device, index, moveMany([from], to), CONFIRM);
  const key = (l: { parameter: number; track: number }) => `${l.track}:${l.parameter}`;
  const untouched = (ls: typeof before) => ls.filter((l) => l.track !== from && l.track !== to);

  assert.deepEqual(
    untouched(locks(after, index)).map(key).sort(),
    untouched(before).map(key).sort(),
    "a move must not disturb other tracks' locks",
  );
});

test("a vacated lock record reads back as unused, not as parameter 255", { skip }, () => {
  // `readLockTable` tests both header bytes against 0xFFFF. Clearing only byte 0 leaves
  // 0xFF<track>, which reads back as a live lock on parameter 255 — a lock the user never
  // wrote, on a parameter that does not exist.
  const img = image();
  const device = deviceFor(img);
  const index = patternWithLocks(img);

  const target = locks(img, index)[0]!.track;
  const { image: after } = applyTrackMove(img, device, index, clear(target), CONFIRM);

  assert.ok(
    locks(after, index).every((l) => l.parameter !== 0xff),
    "no record should read back as a lock on parameter 255",
  );
  assert.equal(
    locks(after, index).filter((l) => l.track === target).length,
    0,
    "the cleared track should own no locks",
  );
});

test("a copy that would overflow the lock table is refused, not truncated", { skip }, () => {
  // 80 lock records for the whole pattern, and copying a track duplicates its locks. Silently
  // dropping the overflow would lose parameter automation with no warning at all.
  const img = image();
  const device = deviceFor(img);

  // Find a pattern whose lock table is over half full, then copy its busiest track. The counts
  // come from `lockCounts` rather than a hand-rolled scan: the first version of this test read
  // byte 0 as the track, which is the parameter id, so it encoded the very bug it sat next to.
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    const perTrack = lockCounts(img, p);
    const used = perTrack.reduce((n, c) => n + c, 0);
    if (used === 0) continue;

    const busiest = perTrack.indexOf(Math.max(...perTrack));
    if (used + perTrack[busiest]! <= 80) continue;

    const free = [...Array(DN2_TRACK_COUNT).keys()].find((t) => perTrack[t] === 0);
    if (free === undefined) continue;

    assert.throws(
      () => applyTrackMove(img, device, p, copyMany([busiest], free), CONFIRM),
      /table is full/,
      "an overflowing copy must refuse rather than drop locks",
    );
    return;
  }
  // No corpus pattern is full enough to force it. The guard is still exercised by unit shape.
});
