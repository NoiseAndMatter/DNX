/**
 * The machine byte inside a sound object, and the omission finding it exposed.
 *
 * The regression this guards is the project's signature failure mode: a field nobody wrote,
 * inheriting the template's value, invisible to a byte diff whose template *is* Elektron's
 * output. Converting against the neutral `EMPTY.dn2prj` is the only way to see it, so that is
 * what the last test here does.
 */

import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { kitRecord, DN2_LAYOUT } from "../src/project/dn2image.js";
import { MACHINE, SOUND_MACHINE_OFFSET, machineName, machineOf } from "../src/project/machine.js";
import { convertProject } from "../src/expand/convert.js";
import { NO_CORPUS, SKIP_REASON, corpusPath, requireCorpusFile, DN1_PROJECTS, DN2_PROJECTS } from "./corpus.js";

const KIT_SOUND_OFFSET = 60;
const SOUND_SIZE = 359;
const SLOTS = 16;
/** DN1 MIDI tracks land on DN2 tracks 5-8. */
const MIDI_SLOTS = [4, 5, 6, 7];

const skip = NO_CORPUS && SKIP_REASON;

function image(path: string): Uint8Array {
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

/** The machine byte of every sound slot of one kit. */
function machines(img: Uint8Array, pattern: number): number[] {
  const kit = kitRecord(img, pattern, DN2_LAYOUT);
  return Array.from({ length: SLOTS }, (_, s) => kit[KIT_SOUND_OFFSET + s * SOUND_SIZE + SOUND_MACHINE_OFFSET]!);
}

test("machineOf reads the documented offset", () => {
  const sound = new Uint8Array(SOUND_SIZE);
  sound[SOUND_MACHINE_OFFSET] = MACHINE.swarmer;
  assert.equal(machineOf(sound), MACHINE.swarmer);
  assert.equal(machineName(MACHINE.swarmer), "SWARMER");
  assert.equal(machineName(MACHINE.midi), "MIDI");
  assert.equal(machineName(99), undefined, "an unseen value must not be given a name");
});

test("the capture's three switched tracks read their machines", { skip }, () => {
  const path = requireCorpusFile(DN2_PROJECTS, "DATA_CAPTURE.dn2prj");
  // A6 is the machines pattern: track 2 FM DRUM, track 3 MIDI, track 7 Wavetone, track 8 Swarmer.
  const got = machines(image(path), 5);
  assert.equal(got[1], MACHINE.fmDrum, "track 2");
  assert.equal(got[2], MACHINE.midi, "track 3");
  assert.equal(got[6], MACHINE.wavetone, "track 7");
  assert.equal(got[7], MACHINE.swarmer, "track 8");
  assert.equal(got[0], MACHINE.fmTone, "track 1 was left alone");
});

test("Elektron's conversions use only FM TONE and MIDI, and MIDI only on slots 4-7", { skip }, () => {
  const projects = ["MORNING_JAM", "006 GLITCH_EXPLORE", "008 JAM", "009 JAGGED"]
    .map((n) => corpusPath(DN2_PROJECTS, `${n}.dn2prj`))
    .filter(existsSync);
  if (projects.length === 0) return;

  let checked = 0;
  for (const path of projects) {
    const img = image(path);
    for (let pattern = 0; pattern < DN2_LAYOUT.patternCount; pattern++) {
      const got = machines(img, pattern);
      for (let slot = 0; slot < SLOTS; slot++) {
        const want = MIDI_SLOTS.includes(slot) ? MACHINE.midi : MACHINE.fmTone;
        assert.equal(got[slot], want, `${path} pattern ${pattern} slot ${slot}`);
        checked++;
      }
    }
  }
  assert.equal(checked, projects.length * DN2_LAYOUT.patternCount * SLOTS);
});

test("conversion writes the MIDI machine even from a neutral template", { skip }, () => {
  const source = requireCorpusFile(DN1_PROJECTS, "002 MORNING_JAM.dnprj");
  const template = requireCorpusFile(DN2_PROJECTS, "EMPTY.dn2prj");

  const templateImage = image(template);
  // The premise: a neutral template has FM TONE everywhere, so inheriting is silently wrong.
  assert.deepEqual(
    MIDI_SLOTS.map((s) => machines(templateImage, 0)[s]),
    [MACHINE.fmTone, MACHINE.fmTone, MACHINE.fmTone, MACHINE.fmTone],
    "EMPTY should carry no MIDI machines, or this test proves nothing",
  );

  const { image: converted } = convertProject(image(source), templateImage);
  for (let pattern = 0; pattern < DN2_LAYOUT.patternCount; pattern++) {
    const got = machines(converted, pattern);
    for (const slot of MIDI_SLOTS) {
      assert.equal(got[slot], MACHINE.midi, `pattern ${pattern} slot ${slot} should be the MIDI machine`);
    }
    for (let slot = 0; slot < 4; slot++) {
      assert.equal(got[slot], MACHINE.fmTone, `pattern ${pattern} slot ${slot} should be FM TONE`);
    }
  }
});
