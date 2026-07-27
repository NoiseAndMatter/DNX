import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/project/projectfile.js";
import { DN2_LAYOUT, patternRecord } from "../src/project/dn2image.js";
import { readDn2Pattern } from "../src/project/dn2pattern.js";
import { DN1_DEVICE, deviceFor } from "../src/librarian/device.js";
import {
  DN2_TRACK_COUNT,
  applyTrackMove,
  planTrackMove,
  trigCounts,
  verifyTrackMove,
} from "../src/librarian/trackmove.js";
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

test("the unlocatable synth/MIDI byte is reported, not glossed over", { skip }, () => {
  const img = image();
  const plan = planTrackMove(img, deviceFor(img), 0, swap(0, 1));
  assert.ok(
    plan.findings.some((f) => f.severity === "warning" && /never located/.test(f.message)),
    "a move should admit what it cannot verify",
  );
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

test("a copy that would overflow the lock table is refused, not truncated", { skip }, () => {
  // 80 lock records for the whole pattern, and copying a track duplicates its locks. Silently
  // dropping the overflow would lose parameter automation with no warning at all.
  const img = image();
  const device = deviceFor(img);

  // Find a pattern whose lock table is over half full, then copy its busiest track.
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    const record = patternRecord(img, p, DN2_LAYOUT);
    let used = 0;
    const perTrack = new Map<number, number>();
    for (let i = 0; i < 80; i++) {
      const track = record[0x10a34 + i * 258]!;
      if (track === 0xff) continue;
      used++;
      perTrack.set(track, (perTrack.get(track) ?? 0) + 1);
    }
    if (used === 0) continue;

    const [busiest, locks] = [...perTrack].sort((x, y) => y[1] - x[1])[0]!;
    if (used + locks <= 80) continue;

    const free = [...Array(DN2_TRACK_COUNT).keys()].find((t) => !perTrack.has(t));
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
