/**
 * Merging selected patterns into an existing Digitone II project.
 *
 * The fixtures are **real projects from the corpus** — a DN1 with sound locks and a DN2 with a pool
 * somebody actually filled. That matters here more than usual: the whole feature is about not
 * destroying what the destination already has, and a synthetic destination has nothing to destroy.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN2_LAYOUT, patternRecord } from "../src/project/dn2image.js";
import { PATTERN, TRACK, TRACK_COUNT } from "../src/project/dn2pattern.js";
import { DN2_POOL_OFFSET, SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "../src/project/soundmap.js";
import { MergeRefused, describeMerge, planPatternMerge } from "../src/expand/merge.js";
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
    (e: unknown) => e instanceof MergeRefused && /already hold a pattern/.test(String(e)),
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

test("a Digitone 1 destination is refused", { skip }, () => {
  assert.throws(
    () => planPatternMerge({ source: source(), patterns: [0], destination: source(), landing: 0 }),
    /not a Digitone II image/,
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
    refused = error instanceof MergeRefused && /no room/.test(String(error));
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

  const all = plan.report.warnings.length;
  const kept = plan.notes.reduce((n, note) => n + note.count, 0);
  assert.ok(all > 0, "the corpus source converts with no notes at all — this proves nothing");
  assert.ok(kept < all, `kept every one of the ${all} notes; nothing was scoped`);

  // Every note's count is exactly the number of in-scope warnings carrying that message.
  //
  // Counted rather than matched by text: the same sentence is emitted for pattern 0 and for pattern
  // 90, so "is this message present" cannot tell a kept note from a dropped one. The count can.
  const placed = new Set(plan.pool.map((p) => p.from));
  const expected = new Map<string, number>();
  for (const w of plan.report.warnings) {
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
    (error: unknown) =>
      error instanceof MergeRefused && /already hold a pattern/.test((error as Error).message),
    "re-planning onto a slot the merge just filled must refuse rather than silently overwrite",
  );

  // And it goes through when the caller has actually asked for it — the refusal is a question, not
  // a wall. This is the path the CLI takes with --confirm.
  const again = planPatternMerge({ ...args, destination: first.image, confirmOverwrite: true });
  assert.deepEqual(again.landingSlots, [3]);
});
