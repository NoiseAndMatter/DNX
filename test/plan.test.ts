import assert from "node:assert/strict";
import { NO_CORPUS, corpusPath, DN1_PROJECTS } from "./corpus.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseProject } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { collectSoundUsage, midiTrackDestination, planExpansion } from "../src/expand/plan.js";

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
    const total = [...usage.values()].reduce((n, u) => n + u.trigCount, 0);
    for (const opts of [{}, { useFreedMidiTracks: true }]) {
      const plan = planExpansion(image, opts);
      assert.equal(plan.promotedTrigs + plan.overflowTrigs, total, `${name}: trig count mismatch`);
      assert.equal(
        plan.assignments.length + plan.overflow.length,
        usage.size,
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
