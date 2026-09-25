/**
 * Merging selected patterns into an existing Digitone II project.
 *
 * The fixtures are **real projects from the corpus** — a DN1 with sound locks and a DN2 with a pool
 * somebody actually filled. That matters here more than usual: the whole feature is about not
 * destroying what the destination already has, and a synthetic destination has nothing to destroy.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN1_LAYOUT, DN2_LAYOUT, patternRecord } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { DN1_SPEC } from "@noiseandmatter/dnx-core/project/spec.js";
import {
  SYNTH_TRACK_COUNT as DN1_SYNTH_TRACKS,
  readPattern,
  readSoundPool,
} from "@noiseandmatter/dnx-core/project/dn1.js";
import { applyPatternCopy, planPatternCopy } from "@noiseandmatter/dnx-core/librarian/copy.js";
import { PATTERN, TRACK, TRACK_COUNT, soundLockedSlots } from "@noiseandmatter/dnx-core/project/dn2pattern.js";
import { DN2_POOL_OFFSET, SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "@noiseandmatter/dnx-core/project/soundmap.js";
import { MergeRefused, describeMerge, planPatternMerge } from "@noiseandmatter/dnx-core/expand/merge.js";
import { CORPUS, NO_CORPUS, SKIP_REASON, corpusFiles } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;
const DN2_SOUND_SIZE = 359;

function imageOf(path: string): Uint8Array {
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

/** A DN1 project that actually uses sound locks — otherwise the merge has nothing to re-point. */
function source(): Uint8Array {
  for (const path of corpusFiles("01_DN1/01_Projects", ".dnprj")) {
    const image = imageOf(path);
    if (locksIn(image, "dn1") > 0) return image;
  }
  throw new Error("no DN1 project in the corpus uses sound locks");
}

function destination(): Uint8Array {
  const files = corpusFiles("02_DN2/01_Projects", ".dn2prj");
  if (files.length === 0) throw new Error("no DN2 projects in the corpus");
  return imageOf(files[0]!);
}

/**
 * A **different** Digitone II project with a pattern that uses sound locks.
 *
 * Different from `destination()` on purpose: merging a project into itself resolves every lock as
 * `reused` and would prove nothing about carrying a sound across. Throws rather than skipping — a
 * fixture that quietly finds nothing is a test that passes by not looking.
 */
function dn2Source(): { image: Uint8Array; pattern: number } {
  for (const path of corpusFiles("02_DN2/01_Projects", ".dn2prj").slice(1)) {
    const image = imageOf(path);
    for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
      // `soundLockedSlots`, not the raw `locks` walk, and the difference is the whole fixture.
      // Reading every step's lock byte reports slot 0 and slot 161 locked by all 128 patterns of
      // every corpus project — unset memory, not music. The merge counts a lock only where a trig
      // exists, so a fixture chosen any other way hands it patterns with nothing real to carry.
      const real = [...soundLockedSlots(patternRecord(image, p, DN2_LAYOUT))]
        .filter((slot) => slot < 128 && poolName(image, slot) !== "");
      if (real.length > 0) return { image, pattern: p };
    }
  }
  throw new Error("no second DN2 project in the corpus has a pattern locking a sound that exists");
}

/** A destination slot holding no locks, so a merge into it destroys nothing this test cares about. */
function quietSlot(image: Uint8Array): number {
  for (let p = DN2_LAYOUT.patternCount - 1; p >= 0; p--) {
    if ([...locks(patternRecord(image, p, DN2_LAYOUT))].length === 0) return p;
  }
  throw new Error("every pattern in the destination holds locks");
}

/** One pool slot's bytes, which is what "the same sound" means here. */
function poolSound(image: Uint8Array, slot: number): Uint8Array {
  const at = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE;
  return image.subarray(at, at + DN2_SOUND_SIZE);
}

/** Count sound locks across a whole DN2 image. */
function locksIn(image: Uint8Array, kind: "dn1" | "dn2" = "dn2"): number {
  if (kind === "dn1") {
    // Cheap structural probe: the DN1 layout shares the lock offset within a track record.
    let n = 0;
    for (let p = 0; p < 128; p++) {
      const at = 0x200 + p * 18_432;
      for (let t = 0; t < 4; t++) {
        const track = at + 6 + t * 4_096;
        for (let s = 0; s < 64; s++) if (image[track + 0x400 + s] !== 0xff) n++;
      }
    }
    return n;
  }
  let n = 0;
  for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
    n += [...locks(patternRecord(image, p, DN2_LAYOUT))].length;
  }
  return n;
}

/** Every (track, step, slot) lock in one DN2 pattern record. */
function* locks(pattern: Uint8Array): Generator<{ track: number; step: number; slot: number }> {
  for (let track = 0; track < TRACK_COUNT; track++) {
    const at = PATTERN.trackOffset + track * PATTERN.trackSize;
    for (let step = 0; step < 128; step++) {
      const slot = pattern[at + TRACK.soundLockOffset + step]!;
      if (slot !== 0xff) yield { track, step, slot };
    }
  }
}

function poolName(image: Uint8Array, slot: number): string {
  const at = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE + SOUND_NAME_OFFSET;
  const raw = image.subarray(at, at + SOUND_NAME_SIZE);
  const end = raw.indexOf(0);
  return new TextDecoder("windows-1252").decode(end === -1 ? raw : raw.subarray(0, end)).trim();
}

function occupiedPool(image: Uint8Array): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < 128; slot++) if (poolName(image, slot) !== "") out.push(slot);
  return out;
}

// --- the promise: the destination survives ---------------------------------------------------------

test("the destination's other patterns are untouched", { skip }, () => {
  // The whole point of a merge rather than a conversion. `convertProject` would have replaced all
  // 128; this replaces the ones asked for.
  const dest = destination();
  const plan = planPatternMerge({
    source: source(),
    patterns: [0, 1],
    destination: dest,
    landing: 100,
    confirmOverwrite: true,
  });

  for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) {
    if (plan.landingSlots.includes(slot)) continue;
    assert.deepEqual(
      [...patternRecord(plan.image, slot, DN2_LAYOUT)],
      [...patternRecord(dest, slot, DN2_LAYOUT)],
      `pattern ${slot} changed and should not have`,
    );
  }
});

test("the destination's existing pool sounds are still where they were", { skip }, () => {
  // Growing the pool must not move what is in it: every lock in every *other* pattern still points
  // at its own sound, and those locks are not rewritten.
  const dest = destination();
  const before = occupiedPool(dest);
  const plan = planPatternMerge({
    source: source(),
    patterns: [0],
    destination: dest,
    landing: 120,
    confirmOverwrite: true,
  });

  for (const slot of before) {
    assert.equal(poolName(plan.image, slot), poolName(dest, slot), `pool slot ${slot} was disturbed`);
  }
});

test("incoming sounds land after what is already there", { skip }, () => {
  const dest = destination();
  const before = new Set(occupiedPool(dest));
  const plan = planPatternMerge({
    source: source(),
    patterns: [0, 1, 2],
    destination: dest,
    landing: 100,
    confirmOverwrite: true,
  });

  for (const placed of plan.pool) {
    if (placed.reused) {
      assert.ok(before.has(placed.to), `reused slot ${placed.to} was not already occupied`);
    } else {
      assert.ok(!before.has(placed.to), `appended into slot ${placed.to}, which was already in use`);
    }
  }
});

test("every lock in a merged pattern points at the sound it came with", { skip }, () => {
  // The assertion the feature exists for. A lock that survives conversion must resolve, in the
  // destination, to the same *sound* it resolved to in the converted source — by name, since the
  // index is exactly what changed.
  const dest = destination();
  const src = source();
  const plan = planPatternMerge({
    source: src,
    patterns: [0, 1],
    destination: dest,
    landing: 100,
    confirmOverwrite: true,
  });

  const placedFrom = new Map(plan.pool.map((p) => [p.to, p.name]));
  let checked = 0;
  for (const slot of plan.landingSlots) {
    for (const lock of locks(patternRecord(plan.image, slot, DN2_LAYOUT))) {
      const expected = placedFrom.get(lock.slot);
      if (expected === undefined) continue; // a lock we did not place — reported, not silently kept
      assert.equal(poolName(plan.image, lock.slot), expected, `lock at track ${lock.track} step ${lock.step}`);
      checked++;
    }
  }
  assert.ok(plan.pool.length === 0 || checked > 0, "no lock was actually verified");
});

test("an identical sound already in the pool is reused, not duplicated", { skip }, () => {
  // Merging the same patterns twice must not append the sounds twice: the second run finds them
  // byte-identical and points at them. Otherwise repeated merges exhaust 128 slots.
  const dest = destination();
  const src = source();
  const first = planPatternMerge({ source: src, patterns: [0], destination: dest, landing: 100, confirmOverwrite: true });
  const second = planPatternMerge({ source: src, patterns: [0], destination: first.image, landing: 101, confirmOverwrite: true });

  assert.equal(
    second.pool.filter((p) => !p.reused).length,
    0,
    "the second merge appended sounds the first had already placed",
  );
  assert.equal(occupiedPool(second.image).length, occupiedPool(first.image).length);
});

// --- refusing ---------------------------------------------------------------------------------------

test("occupied destination slots are refused unless confirmed", { skip }, () => {
  const dest = destination();
  // Slot 0 of a real project holds something; that is the point of using a real project.
  assert.throws(
    () => planPatternMerge({ source: source(), patterns: [0], destination: dest, landing: 0 }),
    // The `kind` field, not the wording. Matching prose here is what let a reworded refusal
    // silently stop the page asking — see `MergeRefused` and `expanderplanning.test.ts`.
    (e: unknown) => e instanceof MergeRefused && e.kind === "overwrite",
  );
});

test("a selection running past the last slot is refused, not truncated", { skip }, () => {
  // Quietly dropping the tail is the kind of helpfulness discovered three patterns later. Not
  // wrapped round to bank A either, and not clamped onto H16 — both would put a pattern somewhere
  // nobody chose.
  assert.throws(
    () => planPatternMerge({ source: source(), patterns: [0, 1, 2], destination: destination(), landing: 126, confirmOverwrite: true }),
    (error: Error) => {
      assert.match(error.message, /would land past H16/);
      // Names the one that falls off, because the fix is to anchor earlier and that is easier to
      // judge when you can see which pattern is the problem.
      assert.match(error.message, /A3/);
      return true;
    },
  );
});

test("a Digitone II pattern is refused a Digitone 1 destination", { skip }, () => {
  /*
   * The one direction that stays refused. Sixteen tracks do not fit in four, and the presets have
   * no machine to play them on — there is no conversion, and inventing one would mean deciding
   * which twelve tracks to discard, which belongs to whoever wrote the music.
   *
   * This test used to say "a Digitone 1 destination is refused", which was the limitation rather
   * than the rule. A Digitone 1 destination is fine; a Digitone II *source* for it is not.
   */
  const { image: dn2 } = dn2Source();
  assert.throws(
    () => planPatternMerge({ source: dn2, patterns: [0], destination: source(), landing: 0 }),
    (error: unknown) => error instanceof MergeRefused && /Sixteen tracks do not fit in four/.test(String(error)),
  );
});

test("an empty selection is refused", { skip }, () => {
  assert.throws(
    () => planPatternMerge({ source: source(), patterns: [], destination: destination(), landing: 0 }),
    /no patterns selected/,
  );
});

test("a pool with no room refuses rather than merging half of it", { skip }, () => {
  // A partial merge loses sounds *silently* - the trigs still fire, at whatever the pool holds -
  // which is worse than not merging. So the refusal is the feature.
  const dest = Uint8Array.from(destination());
  // Fill every pool slot with a distinct name, so nothing incoming can be placed or reused.
  for (let slot = 0; slot < 128; slot++) {
    const at = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE + SOUND_NAME_OFFSET;
    dest.set(new TextEncoder().encode(`FULL${slot}\0`), at);
  }

  const src = source();
  const options = { source: src, patterns: [0, 1, 2, 3], destination: dest, landing: 100, confirmOverwrite: true };
  let refused = false;
  try {
    planPatternMerge(options);
  } catch (error) {
    // `kind`, not the sentence — see the overwrite test below for what prose-matching cost.
    refused = error instanceof MergeRefused && error.kind === "pool-overflow";
  }

  // Only meaningful if these patterns need pool slots at all; if they do, it must refuse.
  const needed = planPatternMerge({ ...options, destination: destination() }).pool.length;
  if (needed > 0) {
    assert.ok(refused, "a full pool should have been refused");
    const forced = planPatternMerge({ ...options, allowPoolOverflow: true });
    assert.ok(forced.dropped.length > 0, "the override should report what it dropped");
    assert.match(forced.warnings.join(" "), /nowhere to go/);
  }
});

test("a plan describes itself in terms somebody can act on", { skip }, () => {
  const lines = describeMerge(
    planPatternMerge({ source: source(), patterns: [0, 1], destination: destination(), landing: 100, confirmOverwrite: true }),
  );
  assert.ok(lines.some((l) => /pattern\(s\)/.test(l)));
  assert.ok(lines.some((l) => /pool/.test(l)));
});

test("a lock pointing outside the pool is reported, never invented", { skip }, () => {
  // Found by the round-trip test above, which kept appending a nameless sound: one lock referenced
  // slot **161** — beyond the 128-slot pool entirely. Reading it walked off the end of the pool
  // into whatever follows and wrote that garbage into the destination.
  //
  // Dangling locks are ordinary in real projects. This reports them and leaves them pointing where
  // they were; what it must never do is manufacture a sound to satisfy one.
  const plan = planPatternMerge({
    source: source(),
    patterns: [0],
    destination: destination(),
    landing: 100,
    confirmOverwrite: true,
  });

  for (const placed of plan.pool) {
    assert.ok(placed.to < 128, `placed a sound at slot ${placed.to}, outside the pool`);
    assert.notEqual(placed.name, "", `placed a nameless sound at ${placed.to} — that is the bug`);
  }
  const reported = plan.dangling.outOfRange.length + plan.dangling.empty.length;
  if (reported > 0) {
    assert.match(plan.warnings.join(" "), /left as (they are|it is)/);
  }
});

/**
 * Conversion notes are scoped to the merge and folded.
 *
 * **Found on hardware-less testing by the user**: selecting one DN1 pattern printed well over a
 * thousand lines into the options strip — one per inferred field per sound across all 128 patterns
 * — which grew the sticky panel past the height of the page and drew the rest of the tool
 * underneath it. Nearly every line was about a pattern staying behind, and nearly every line was
 * the same sentence repeated.
 *
 * A merge has to convert the whole project (a pattern's kit is written by the pass that writes all
 * of them), so the filtering happens on the way out.
 */
test("a one-pattern merge does not report the whole project's conversion notes", { skip }, () => {
  const plan = planPatternMerge({
    source: source(),
    patterns: [0],
    destination: destination(),
    landing: 100,
    confirmOverwrite: true,
  });

  // A Digitone 1 source, so a conversion ran and there is a report. Asserted rather than assumed:
  // without this the reads below would be on `undefined` and prove nothing.
  assert.equal(plan.sourceKind, "dn1");
  assert.ok(plan.report, "a converted source must carry its conversion report");
  const report = plan.report;

  const all = report.warnings.length;
  const kept = plan.notes.reduce((n, note) => n + note.count, 0);
  assert.ok(all > 0, "the corpus source converts with no notes at all — this proves nothing");
  assert.ok(kept < all, `kept every one of the ${all} notes; nothing was scoped`);

  // Every note's count is exactly the number of in-scope warnings carrying that message.
  //
  // Counted rather than matched by text: the same sentence is emitted for pattern 0 and for pattern
  // 90, so "is this message present" cannot tell a kept note from a dropped one. The count can.
  const placed = new Set(plan.pool.map((p) => p.from));
  const expected = new Map<string, number>();
  for (const w of report.warnings) {
    if (w.pattern !== undefined && w.pattern !== 0) continue;
    if (w.poolSlot !== undefined && !placed.has(w.poolSlot)) continue;
    expected.set(w.message, (expected.get(w.message) ?? 0) + 1);
  }
  for (const note of plan.notes) {
    assert.equal(note.count, expected.get(note.message), `"${note.message}" counted wrong`);
  }
  assert.equal(plan.notes.length, expected.size, "a note in scope was dropped");

  // Folded: distinct messages, each with its count, and the counts add up.
  assert.equal(new Set(plan.notes.map((n) => n.message)).size, plan.notes.length, "duplicate messages survived");
  assert.ok(plan.notes.every((n) => n.count >= 1));
});

test("the summary lines stay short enough to read", { skip }, () => {
  // The panel that broke was a list somebody had to scan. Whatever a merge finds, its description
  // is a handful of lines; the notes are counted in one of them and rendered elsewhere.
  const lines = describeMerge(
    planPatternMerge({ source: source(), patterns: [0, 1, 2], destination: destination(), landing: 100, confirmOverwrite: true }),
  );
  assert.ok(lines.length <= 12, `describeMerge returned ${lines.length} lines:\n${lines.join("\n")}`);
});

/**
 * Why the expander must not replan a merge it has already applied.
 *
 * `planPatternMerge` is **not idempotent against its own output**, and correctly so: once the
 * patterns have landed, the landing slots hold patterns, and planning the same merge again is a
 * request to overwrite them. The refusal is right.
 *
 * The expander used to ask that question anyway. `destination.apply` calls `onChange`
 * synchronously, which replans — with the same selection, onto the same landing — so every
 * successful merge was followed by a native `confirm` asking the user to approve overwriting the
 * work they had just approved. It reads as a hung page, because a modal blocks the renderer.
 *
 * The fix is in `web/src/expander/main.ts`: the selection is cleared *before* the apply, so the
 * replan has nothing to place. This test guards the assumption that fix rests on. **If
 * `planPatternMerge` is ever made idempotent, this test fails and the page fix becomes
 * unnecessary** — which is exactly what the next person needs to know.
 */
test("planning a merge against its own result asks to overwrite", { skip }, () => {
  const args = {
    source: source(),
    patterns: [0],
    destination: destination(),
    landing: 3,
    landingMode: "contiguous" as const,
  };

  const first = planPatternMerge(args);
  assert.deepEqual(first.landingSlots, [3], "the first plan lands where it was asked to");

  assert.throws(
    // Exactly what the page holds after Apply: the plan's output is now the destination.
    () => planPatternMerge({ ...args, destination: first.image }),
    // **`kind`, not the sentence.** This asked for `/already hold a pattern/`, and rewording the
    // refusal to agree with itself in the singular — one slot *holds* — turned a green suite red
    // on `main`. The wording is prose written for a musician and will be rewritten again; the
    // refusal it names will not. Matching the message made every future edit to it a build break.
    (error: unknown) => error instanceof MergeRefused && error.kind === "overwrite",
    "re-planning onto a slot the merge just filled must refuse rather than silently overwrite",
  );

  // And it goes through when the caller has actually asked for it — the refusal is a question, not
  // a wall. This is the path the CLI takes with --confirm.
  const again = planPatternMerge({ ...args, destination: first.image, confirmOverwrite: true });
  assert.deepEqual(again.landingSlots, [3]);
});

// --- a Digitone II source: the same merge, without a conversion -------------------------------------

test("a Digitone II source is taken as it stands, with no conversion", { skip }, () => {
  /*
   * The case the expander never had. Both projects are already Digitone II, so there is nothing to
   * translate — but the pool work still has to happen, because the source's lock numbers mean
   * nothing in the destination's pool. That is true whichever machine the patterns came from,
   * which is why this is one function and not two.
   */
  const { image: src, pattern } = dn2Source();
  const dest = destination();
  const plan = planPatternMerge({
    source: src,
    patterns: [pattern],
    destination: dest,
    landing: quietSlot(dest),
    confirmOverwrite: true,
  });

  assert.equal(plan.sourceKind, "dn2");
  assert.equal(plan.report, undefined, "nothing was converted, so there is no conversion report");
  assert.deepEqual(plan.notes, [], "conversion notes describe a mapping that did not run");
  assert.equal(plan.image.length, dest.length, "the destination keeps its own size");
});

test("every trig in a merged Digitone II pattern still plays the sound it played", { skip }, () => {
  /*
   * **The property the whole feature turns on.** A lock is an index into a 128-slot pool, and two
   * projects number their pools differently. Re-pointing is not a detail of the copy, it is the
   * copy. Checked by bytes rather than by name: a name is a label somebody typed, and two
   * different sounds can share one.
   */
  const { image: src, pattern } = dn2Source();
  const dest = destination();
  const landing = quietSlot(dest);
  const plan = planPatternMerge({
    source: src, patterns: [pattern], destination: dest, landing, confirmOverwrite: true,
  });

  const before = [...locks(patternRecord(src, pattern, DN2_LAYOUT))];
  const after = [...locks(patternRecord(plan.image, landing, DN2_LAYOUT))];
  assert.ok(before.length > 0, "the chosen source pattern has no locks; this test proves nothing");
  assert.equal(after.length, before.length, "a lock went missing in the copy");

  const moved = new Map(plan.pool.map((p) => [p.from, p.to]));
  let checked = 0;
  for (const [i, was] of before.entries()) {
    const now = after[i]!;
    assert.equal(now.track, was.track);
    assert.equal(now.step, was.step);

    const to = moved.get(was.slot);
    if (to === undefined) continue; // dangling in the source: left pointing where it was
    assert.equal(now.slot, to, `the lock at track ${was.track} step ${was.step} was not re-pointed`);
    assert.deepEqual(
      [...poolSound(plan.image, now.slot)],
      [...poolSound(src, was.slot)],
      `slot ${now.slot} does not hold the sound that slot ${was.slot} held`,
    );
    checked++;
  }
  assert.ok(checked > 0, "every lock was dangling; no sound was actually carried across");
});

test("a sound the destination already holds is reused, not appended twice", { skip }, () => {
  // Merging the same pattern twice must not keep growing the pool. The second pass finds every
  // sound already there, byte for byte, and points at it.
  const { image: src, pattern } = dn2Source();
  const dest = destination();
  const first = planPatternMerge({
    source: src, patterns: [pattern], destination: dest, landing: quietSlot(dest),
    confirmOverwrite: true,
  });
  const second = planPatternMerge({
    source: src, patterns: [pattern], destination: first.image, landing: quietSlot(first.image),
    confirmOverwrite: true,
  });

  assert.ok(first.pool.length > 0, "nothing was placed; this test proves nothing");
  assert.ok(
    second.pool.every((p) => p.reused),
    `the second merge appended ${second.pool.filter((p) => !p.reused).length} sound(s) again`,
  );
  assert.deepEqual(
    occupiedPool(second.image),
    occupiedPool(first.image),
    "the pool grew on a merge that had nothing new to add",
  );
});

test("an expansion plan with a Digitone II source is refused, not ignored", { skip }, () => {
  // Dropping it silently would leave a caller believing tracks were promoted. A DN2 pattern
  // already has sixteen; there is nothing for expansion to decide.
  const { image: src, pattern } = dn2Source();
  const dest = destination();
  assert.throws(
    () => planPatternMerge({
      source: src,
      patterns: [pattern],
      destination: dest,
      landing: quietSlot(dest),
      confirmOverwrite: true,
      plan: {} as never,
    }),
    (error: unknown) => error instanceof MergeRefused && /expansion plan/.test(String(error)),
  );
});

test("a source that is neither machine's image is refused by size", { skip }, () => {
  assert.throws(
    () => planPatternMerge({
      source: new Uint8Array(1024), patterns: [0], destination: destination(), landing: 0,
    }),
    (error: unknown) => error instanceof MergeRefused && /neither a Digitone 1/.test(String(error)),
  );
});

// --- Digitone 1 into Digitone 1: the same answer as the engine it replaces --------------------------

/**
 * A DN1 project and a pattern in it whose trigs lock a preset that exists.
 *
 * **Selected from the decoder, not from the librarian.** It used to ask `planPatternCopy` which
 * patterns had sound moves, which was fine while that was a separate engine and is circular now
 * that it calls the merge: the fixture for a test of X must not be chosen by X. `readPattern` and
 * `readSoundPool` are validated against the matched corpus independently of either engine.
 */
function dn1SourcePattern(): { image: Uint8Array; pattern: number } {
  for (const path of corpusFiles("01_DN1/01_Projects", ".dnprj")) {
    const image = imageOf(path);
    const pool = readSoundPool(image);
    for (let p = 0; p < 128; p++) {
      for (const track of readPattern(image, p).tracks) {
        if (track.index >= DN1_SYNTH_TRACKS) continue;
        for (const trig of track.trigs) {
          const lock = trig.soundLock;
          if (lock === undefined) continue;
          const sound = pool[lock];
          if (sound?.framed && sound.name !== "") return { image, pattern: p };
        }
      }
    }
  }
  throw new Error("no DN1 project in the corpus has a pattern locking a preset that exists");
}

/** A different DN1 project, to merge into. */
function dn1Destination(source: Uint8Array): Uint8Array {
  for (const path of corpusFiles("01_DN1/01_Projects", ".dnprj")) {
    const image = imageOf(path);
    if (image.length !== source.length) continue;
    let same = true;
    for (let i = 0; i < image.length; i += 4096) {
      if (image[i] !== source[i]) { same = false; break; }
    }
    if (!same) return image;
  }
  throw new Error("only one distinct DN1 project in the corpus");
}

/**
 * What the pre-fold `librarian/copy.ts` wrote, on the fixture the two helpers above select.
 *
 * Recorded 2026-09-25 from the standalone engine, immediately before it became a wrapper over
 * the merge. `001 PRESETS.dnprj` pattern 1 into `002 MORNING_JAM.dnprj` slot 127, one sound
 * move 10 -> 64, 1,570 of 2,781,700 bytes changed.
 */
const COPY_ENGINE_DIGEST = "92a8c074b628f4343002c9ee6389a9e2da8a052a1c775196fc32cd7cf4d8626d";
const COPY_ENGINE_CHANGED_BYTES = 1_570;

test("the merge still writes what the copy engine wrote", { skip }, () => {
  /*
   * **The evidence that let `librarian/copy.ts` become a wrapper, kept alive after the fold.**
   *
   * `copy.ts` was the engine validated on hardware: a pattern copied into another project loaded
   * on a Digitone 1 and played, carrying exactly the sounds it needed. That evidence is about
   * bytes, so it only transfers while the bytes are unchanged.
   *
   * This used to run both engines and demand identical images. **That test cannot say anything
   * now** — `applyPatternCopy` calls `planPatternMerge`, so comparing them would compare the
   * merge with itself and pass however either behaved. A check that can only succeed is not a
   * check.
   *
   * So the digest is pinned instead, taken from the old implementation before it was deleted. It
   * is a fixture from outside the code under test in the only sense available: the code that
   * produced it no longer exists to agree with itself. If this fails, the merge has changed what
   * a Digitone 1 copy writes, and the hardware evidence no longer covers it.
   */
  const { image: src, pattern } = dn1SourcePattern();
  const dest = dn1Destination(src);
  const landing = 127;

  const copied = applyPatternCopy(src, pattern, dest, landing).image;

  assert.equal(copied.length, dest.length, "a copy should not change the image size");
  assert.equal(
    createHash("sha256").update(copied).digest("hex"),
    COPY_ENGINE_DIGEST,
    "the bytes a Digitone 1 copy writes have changed since the hardware-validated engine wrote them",
  );

  // Stated separately so a failure says *how much* moved, not only that the digest missed.
  let changed = 0;
  for (let i = 0; i < copied.length; i++) if (copied[i] !== dest[i]) changed++;
  assert.equal(changed, COPY_ENGINE_CHANGED_BYTES, "a different number of bytes was written");
});

test("a merged pattern keeps saying which slot it came from, as a device paste does", { skip }, () => {
  /*
   * Measured on `008 JAM.dn2prj`, written by a Digitone II: the record at F1 is byte-identical to
   * F9's, the slot-index field included, and F2, F4 and F10 are F9 pasted and then edited. All
   * four still say F9. A paste on the instrument does not touch this field, so neither does a
   * copy here.
   *
   * A move is the other case and does rewrite it — see `rearrange.ts`, which verifies it. The
   * device has no move operation, so there is a hardware behaviour to match for a copy and none
   * for a move.
   */
  const { image: src, pattern } = dn1SourcePattern();
  const dest = dn1Destination(src);
  const landing = 120;
  assert.notEqual(pattern, landing, "the source and landing slots must differ for this to mean anything");

  const merged = planPatternMerge({
    source: src, patterns: [pattern], destination: dest, landing, confirmOverwrite: true,
  }).image;

  const was = patternRecord(src, pattern, DN1_LAYOUT)[DN1_SPEC.pattern.slotIndexOffset];
  const now = patternRecord(merged, landing, DN1_LAYOUT)[DN1_SPEC.pattern.slotIndexOffset];
  assert.equal(now, was, "the merge rewrote a field the instrument leaves alone");
  assert.notEqual(now, landing, "and it is not the landing slot, which is the whole point");
});
