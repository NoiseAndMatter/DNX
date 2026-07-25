/**
 * Expansion: promoting sound-locked DN1 sounds onto their own DN2 tracks.
 *
 * The invariant that matters is not "the bytes look right" but **every trig still plays the
 * same sound**. Where it plays may change — that is the entire point — so the tests resolve
 * each trig to a sound *name* on both sides and compare those, rather than comparing track
 * numbers or lock bytes.
 *
 * Sound identity resolves differently on each device:
 *   DN1  locked trig  -> pool[soundLock]        unlocked trig -> kit sound for its track
 *   DN2  locked trig  -> pool[soundLock]        unlocked trig -> kit sound for its track
 * so a promoted trig moves from the first form to the second and must still name the same
 * sound.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseProject } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN2_LAYOUT, kitRecord, patternRecord } from "../src/project/dn2image.js";
import {
  checkDn2PatternRecord,
  midiTrackMaskOf,
  readDn2PatternRecord,
} from "../src/project/dn2pattern.js";
import { readKit, readPattern, readSoundPool, SYNTH_TRACK_COUNT } from "../src/project/dn1.js";
import { convertProject } from "../src/expand/convert.js";
import { planExpansion } from "../src/expand/plan.js";
import { destinationsBySound, findCollisions, routePattern } from "../src/expand/route.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;
const PROJECTS = ["002 MORNING_JAM", "049 JAM", "053 TECNO_EXP"];

/** DN2 sound pool and kit sound slots. */
const POOL = DN2_LAYOUT.tailBase + 10_756;
const SOUND_SIZE = 359;
const KIT_SOUND_OFFSET = 60;

function image(path: string): Uint8Array {
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

function soundName(buffer: Uint8Array, at: number): string {
  const field = buffer.subarray(at + 12, at + 28);
  const nul = field.indexOf(0);
  return new TextDecoder("latin1").decode(nul < 0 ? field : field.subarray(0, nul));
}

function expanded(project: string) {
  const source = image(`${CORPUS}01_DN1/01_Projects/${project}.dnprj`);
  const template = image(`${CORPUS}02_DN2/01_Projects/EMPTY.dn2prj`);
  const plan = planExpansion(source);
  return { source, plan, ...convertProject(source, template, { plan }) };
}

test("routing leaves everything in place when there is no plan", { skip }, () => {
  const source = image(`${CORPUS}01_DN1/01_Projects/002 MORNING_JAM.dnprj`);
  const routing = routePattern(readPattern(source, 0), new Map());

  assert.equal(routing.moved, 0);
  assert.equal(routing.destinationsUsed.size, 0);
  for (const entry of routing.routed) {
    assert.equal(entry.destinationTrack, entry.sourceTrack);
    assert.equal(entry.clearSoundLock, false);
  }
});

test("routing moves exactly the trigs whose sound was promoted", { skip }, () => {
  const source = image(`${CORPUS}01_DN1/01_Projects/002 MORNING_JAM.dnprj`);
  const plan = planExpansion(source);
  const destinations = destinationsBySound(plan);
  const promoted = new Set(plan.assignments.map((a) => a.usage.poolSlot));

  let moved = 0;
  for (let p = 0; p < 128; p++) {
    for (const entry of routePattern(readPattern(source, p), destinations).routed) {
      const lock = entry.trig.soundLock;
      const shouldMove =
        entry.sourceTrack < SYNTH_TRACK_COUNT && lock !== undefined && promoted.has(lock);

      assert.equal(entry.clearSoundLock, shouldMove, `pattern ${p} step ${entry.trig.step}`);
      if (shouldMove) {
        moved++;
        assert.equal(entry.destinationTrack, destinations.get(lock!));
      } else {
        assert.equal(entry.destinationTrack, entry.sourceTrack);
      }
    }
  }
  assert.ok(moved > 0, "expected the corpus to promote something");
});

test("every trig still plays the same sound after expansion", { skip }, () => {
  let checked = 0;

  for (const project of PROJECTS) {
    const { source, image: out } = expanded(project);
    const pool = readSoundPool(source);

    for (let p = 0; p < 128; p++) {
      const record = patternRecord(out, p);
      const kit = kitRecord(out, p);
      const dn1Kit = readKit(source, p);
      const result = readDn2PatternRecord(record, p, midiTrackMaskOf(kit));

      for (const track of readPattern(source, p).tracks) {
        if (track.index >= SYNTH_TRACK_COUNT) continue;

        for (const trig of track.trigs) {
          const want =
            trig.soundLock !== undefined
              ? pool[trig.soundLock]!.name
              : (dn1Kit.sounds[track.index]?.name ?? "");

          // The trig may now be on any track; find one at this step playing that sound.
          let found: string | undefined;
          for (let d = 0; d < 16 && found === undefined; d++) {
            const candidate = result.tracks[d]!.trigs.find((t) => t.step === trig.step);
            if (!candidate) continue;
            const name =
              candidate.soundLock !== undefined
                ? soundName(out, POOL + candidate.soundLock * SOUND_SIZE)
                : soundName(kit, KIT_SOUND_OFFSET + d * SOUND_SIZE);
            if (name === want) found = name;
          }

          checked++;
          assert.equal(
            found,
            want,
            `${project} pattern ${p} track ${track.index + 1} step ${trig.step}: ` +
              `no track plays "${want}"`,
          );
        }
      }
    }
  }
  // Synth tracks only — MIDI trigs have no sound to resolve — so this is well under the
  // corpus-wide trig count.
  assert.ok(checked > 3_000, `expected thousands of trigs, saw ${checked}`);
});

test("promoted trigs land on free tracks and drop their sound lock", { skip }, () => {
  for (const project of PROJECTS) {
    const { image: out, report, plan } = expanded(project);
    assert.ok(report.trigsPromoted > 0, `${project}: nothing promoted`);

    for (const track of report.tracksUsed) {
      assert.ok(
        plan.freeTracks.includes(track),
        `${project}: promoted onto T${track}, which is not in the free pool`,
      );
    }

    // A destination track must carry no sound locks — its sound is now its own.
    for (let p = 0; p < 128; p++) {
      const record = patternRecord(out, p);
      const result = readDn2PatternRecord(record, p, midiTrackMaskOf(kitRecord(out, p)));
      for (const track of report.tracksUsed) {
        for (const trig of result.tracks[track - 1]!.trigs) {
          assert.equal(
            trig.soundLock,
            undefined,
            `${project} pattern ${p} T${track} step ${trig.step}: promoted track still locked`,
          );
        }
      }
    }
  }
});

test("expanded patterns pass the DN2 structural check", { skip }, () => {
  for (const project of PROJECTS) {
    const { image: out } = expanded(project);
    for (let p = 0; p < 128; p++) {
      const result = checkDn2PatternRecord(patternRecord(out, p));
      assert.ok(result.ok, `${project} pattern ${p}: ${result.problems.slice(0, 3).join("; ")}`);
    }
  }
});

test("claiming a MIDI track clears its bit in the kit mask", { skip }, () => {
  for (const project of PROJECTS) {
    const { image: out, report } = expanded(project);
    for (let p = 0; p < 128; p++) {
      const mask = midiTrackMaskOf(kitRecord(out, p));
      for (const track of report.tracksUsed) {
        assert.equal(
          (mask >> (track - 1)) & 1,
          0,
          `${project} pattern ${p}: T${track} was promoted but is still flagged MIDI`,
        );
      }
    }
  }
});

test("collisions are detected rather than silently merged", { skip }, () => {
  // Force every sound onto one track so same-step trigs from different sources collide.
  const source = image(`${CORPUS}01_DN1/01_Projects/049 JAM.dnprj`);
  const pool = readSoundPool(source);
  const everything = new Map<number, number>();
  pool.forEach((s, i) => {
    if (s.name) everything.set(i, 8);
  });

  let collisions = 0;
  for (let p = 0; p < 128; p++) {
    collisions += findCollisions(routePattern(readPattern(source, p), everything)).length;
  }
  assert.ok(collisions > 0, "packing every sound onto one track should collide somewhere");
});
