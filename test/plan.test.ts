import assert from "node:assert/strict";
import { NO_CORPUS, corpusPath, DN1_PROJECTS } from "./corpus.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseProject } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { collectSoundUsage, midiTrackDestination, planExpansion } from "../src/expand/plan.js";
import { SYNTH_TRACK_COUNT, readPattern } from "../src/project/dn1.js";

const DIR = NO_CORPUS ? "" : corpusPath(DN1_PROJECTS);

function projects(): { name: string; image: Uint8Array }[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.toLowerCase().endsWith(".dnprj"))
    .map((f) => {
      const { payload } = parseProject(new Uint8Array(readFileSync(join(DIR, f))));
      return { name: f, image: decodeProjectImage(payload.raw).image };
    });
}

const all = projects();
const skip = all.length === 0;

test("DN1 MIDI tracks map positionally to DN2 tracks 5-8", () => {
  assert.equal(midiTrackDestination(4), 5);
  assert.equal(midiTrackDestination(7), 8);
});

test("by default only the guaranteed-free tracks 9-16 are used", { skip }, () => {
  for (const { name, image } of all) {
    const plan = planExpansion(image);
    assert.deepEqual(plan.freeTracks, [9, 10, 11, 12, 13, 14, 15, 16], `${name}`);
    for (const a of plan.assignments) {
      assert.ok(a.dn2Track >= 9 && a.dn2Track <= 16, `${name}: assigned out-of-range T${a.dn2Track}`);
    }
  }
});

test("freed MIDI tracks are appended, so 9-16 still fill first", { skip }, () => {
  for (const { name, image } of all) {
    const plan = planExpansion(image, { useFreedMidiTracks: true });
    assert.deepEqual(plan.freeTracks.slice(0, 8), [9, 10, 11, 12, 13, 14, 15, 16], `${name}`);

    // Every extra destination must be the counterpart of an UNUSED DN1 MIDI track.
    for (const t of plan.freeTracks.slice(8)) {
      assert.ok(t >= 5 && t <= 8, `${name}: unexpected extra destination T${t}`);
      assert.ok(
        !plan.usedMidiTracks.includes(t + 3),
        `${name}: T${t} offered but its DN1 MIDI track carries trigs`,
      );
    }
    const expected = 8 + (4 - plan.usedMidiTracks.length);
    assert.equal(plan.freeTracks.length, expected, `${name}: wrong destination count`);
  }
});

test("enabling freed MIDI tracks never promotes fewer sounds", { skip }, () => {
  for (const { name, image } of all) {
    const base = planExpansion(image);
    const more = planExpansion(image, { useFreedMidiTracks: true });
    assert.ok(
      more.assignments.length >= base.assignments.length,
      `${name}: enabling the option lost promotions`,
    );
    // The same sounds must still win. Compare as sets — assignments are ordered by
    // destination track, so positional comparison would test the sort, not the ranking.
    const promoted = new Set(more.assignments.map((a) => a.usage.poolSlot));
    for (const a of base.assignments) {
      assert.ok(
        promoted.has(a.usage.poolSlot),
        `${name}: pool slot ${a.usage.poolSlot} won without the option but lost with it`,
      );
    }
  }
});

test("no locked trig is ever lost — promoted plus overflow accounts for all", { skip }, () => {
  for (const { name, image } of all) {
    const { usage } = collectSoundUsage(image);
    const total = usage.reduce((n, u) => n + u.trigCount, 0);
    for (const opts of [{}, { useFreedMidiTracks: true }]) {
      const plan = planExpansion(image, opts);
      assert.equal(plan.promotedTrigs + plan.overflowTrigs, total, `${name}: trig count mismatch`);
      assert.equal(
        plan.assignments.length + plan.overflow.length,
        usage.length,
        `${name}: sound count mismatch`,
      );
    }
  }
});

test("a sound locked on several source tracks is merged onto one destination", { skip }, () => {
  let sawMerge = false;
  for (const { name, image } of all) {
    const plan = planExpansion(image);
    const seen = new Set<number>();
    for (const a of plan.assignments) {
      assert.ok(!seen.has(a.dn2Track), `${name}: T${a.dn2Track} assigned twice`);
      seen.add(a.dn2Track);
      if (a.usage.sourceTracks.length > 1) sawMerge = true;
    }
  }
  assert.ok(sawMerge, "expected at least one multi-source-track sound in the corpus");
});

test("source tracks that disagree on length or speed are never merged", { skip }, () => {
  let sawSplit = false;

  for (const { name, image } of all) {
    const { usage } = collectSoundUsage(image);

    for (let p = 0; p < 128; p++) {
      const pattern = readPattern(image, p);
      // What each source track would impose on a shared destination, in this pattern.
      const profiles = new Map<number, Map<number, string>>();
      for (const track of pattern.tracks) {
        if (track.index >= SYNTH_TRACK_COUNT) continue;
        for (const trig of track.trigs) {
          if (trig.soundLock === undefined) continue;
          const byTrack = profiles.get(trig.soundLock) ?? new Map<number, string>();
          byTrack.set(track.index, `${track.length}/${track.speed}`);
          profiles.set(trig.soundLock, byTrack);
        }
      }

      for (const [slot, byTrack] of profiles) {
        if (new Set(byTrack.values()).size < 2) continue;
        sawSplit = true;

        // Every candidate covering this slot must hold source tracks that all agree.
        for (const candidate of usage.filter((u) => u.poolSlot === slot)) {
          const covered = candidate.sourceTracks.filter((t) => byTrack.has(t));
          const distinct = new Set(covered.map((t) => byTrack.get(t)!));
          assert.ok(
            distinct.size <= 1,
            `${name} pattern ${p + 1} slot ${slot}: merged tracks ${covered.join()} disagree (${[...distinct].join(" vs ")})`,
          );
        }
      }
    }
  }

  assert.ok(sawSplit, "expected the corpus to contain at least one incompatible pair");
});

test("compact mode packs each pattern from the first free track, losing nothing", { skip }, () => {
  for (const { name, image } of all) {
    const plan = planExpansion(image, { compactPerPattern: true });
    assert.ok(plan.perPattern, `${name}: no per-pattern allocation`);

    for (const [p, allocation] of plan.perPattern!) {
      const used = allocation.assignments.map((a) => a.dn2Track).sort((a, b) => a - b);
      const expected = plan.freeTracks.slice(0, used.length);
      assert.deepEqual(used, expected, `${name} pattern ${p + 1}: destinations are not packed`);

      // Every sound locked in this pattern is accounted for: promoted or explicitly left.
      const local = collectSoundUsage(image, [p]).usage;
      assert.equal(
        allocation.assignments.length + allocation.overflow.length,
        local.length,
        `${name} pattern ${p + 1}: candidate count mismatch`,
      );
    }
  }
});

test("compact mode promotes at least as much as the global map", { skip }, () => {
  for (const { name, image } of all) {
    const global = planExpansion(image);
    const compact = planExpansion(image, { compactPerPattern: true });
    const compactOverflow = [...compact.perPattern!.values()].reduce((n, a) => n + a.overflow.length, 0);
    const globalOverflowPerPattern = global.overflow.reduce((n, u) => n + u.patterns.length, 0);
    assert.ok(
      compactOverflow <= globalOverflowPerPattern,
      `${name}: compact left ${compactOverflow} behind vs global ${globalOverflowPerPattern}`,
    );
  }
});
