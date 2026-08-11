/**
 * Loading a kit into a pattern.
 *
 * The write itself is `set` at a computed offset. What is worth testing is everything around it:
 * that the preview tells the truth about which tracks change and which of them anyone will hear,
 * that the trigs survive untouched, and that the refusals name something a person can act on.
 *
 * **Kits come from real projects.** A synthetic 10,752-byte block would agree with the arithmetic
 * and say nothing about whether the sixteen presets, the levels and the MIDI mask are being read
 * out of the places a Digitone II keeps them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, SKIP_REASON, requireCorpusFile } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN2_LAYOUT, kitRecord, patternRecord } from "../src/project/dn2image.js";
import { readDn2PatternRecord } from "../src/project/dn2pattern.js";
import { deviceFor } from "../src/librarian/device.js";
import { summariseTracks } from "../src/librarian/tracksummary.js";
import {
  KitWriteError,
  applyLoadKit,
  describeLoadKit,
  planLoadKit,
} from "../src/librarian/kitwrite.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

function image(dir: string, name: string): Uint8Array {
  return decodeProjectImage(
    parseProject(new Uint8Array(readFileSync(requireCorpusFile(dir, name)))).payload.raw,
  ).image;
}

const dn2 = () => image(DN2_PROJECTS, "012 TECNO_EXP.dn2prj");

/**
 * A pattern with trigs on several tracks, and one whose kit differs from it.
 *
 * Chosen by looking rather than assumed: a pair whose kits happen to match would make every
 * assertion below vacuously true, which is the failure mode that matters in a test like this.
 */
function busyPair(img: Uint8Array): { from: number; to: number } {
  for (let to = 0; to < DN2_LAYOUT.patternCount; to++) {
    const summary = summariseTracks(img, to);
    if (summary.every((t) => t.trigCount === 0)) continue;
    for (let from = 0; from < DN2_LAYOUT.patternCount; from++) {
      if (from === to) continue;
      const a = kitRecord(img, from, DN2_LAYOUT);
      const b = kitRecord(img, to, DN2_LAYOUT);
      if (a.some((byte, i) => byte !== b[i])) return { from, to };
    }
  }
  throw new Error("012 TECNO_EXP should hold a pattern with trigs and a different kit somewhere");
}

test("loading a kit replaces the sound and leaves the sequence alone", { skip }, () => {
  const before = image(DN2_PROJECTS, "012 TECNO_EXP.dn2prj");
  const device = deviceFor(before);
  const { from, to } = busyPair(before);
  const kit = Uint8Array.from(kitRecord(before, from, DN2_LAYOUT));

  const { image: after, plan } = applyLoadKit(before, device, kit, { pattern: to });

  // The music is the thing that must not move. Read back through the pattern decoder, which knows
  // nothing about kits: every trig on every track, at the same step, with the same note.
  const was = readDn2PatternRecord(patternRecord(before, to, DN2_LAYOUT), to, 0x00f0);
  const now = readDn2PatternRecord(patternRecord(after, to, DN2_LAYOUT), to, 0x00f0);
  assert.deepEqual(
    now.tracks.map((t) => t.trigs.map((g) => [g.step, g.note])),
    was.tracks.map((t) => t.trigs.map((g) => [g.step, g.note])),
    "trigs must survive a kit change untouched",
  );

  // And the kit is now the one that was loaded, byte for byte.
  assert.deepEqual(kitRecord(after, to, DN2_LAYOUT), kit);

  // Exactly one kit's worth of bytes may differ. More means the offset is wrong, and a kit write
  // that strays lands in the neighbouring pattern's kit.
  let differing = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
  assert.ok(differing > 0, "something must have been written");
  assert.ok(differing <= DN2_LAYOUT.kitSize, `${differing} bytes changed, more than one kit`);

  assert.ok(plan.changedTracks.length > 0, "the chosen kits differ, so tracks must change");
});

test("the preview names the tracks that change, and reads them off the kits", { skip }, () => {
  const img = dn2();
  const { from, to } = busyPair(img);
  const kit = kitRecord(img, from, DN2_LAYOUT);
  const plan = planLoadKit(img, deviceFor(img), kit, { pattern: to });

  // The preview is the product here, so it is checked against the two kits independently — not
  // against itself. `after` must be what the source pattern shows, `before` what the destination
  // shows, and `summariseTracks` is the reader both surfaces already use.
  const source = summariseTracks(img, from);
  const destination = summariseTracks(img, to);
  for (const track of plan.tracks) {
    assert.equal(track.after.presetName, source[track.index]!.presetName, `${track.label} after`);
    assert.equal(track.before.presetName, destination[track.index]!.presetName, `${track.label} before`);
    assert.equal(track.after.level, source[track.index]!.level, `${track.label} level`);
    assert.equal(track.trigCount, destination[track.index]!.trigCount, `${track.label} trigs`);
  }

  // A track can only be audible if it changed and has trigs that are not all preset-locked.
  for (const index of plan.audibleTracks) {
    const track = plan.tracks[index]!;
    assert.ok(track.changed && track.trigCount > track.lockedTrigs, `${track.label} is not audible`);
  }
  assert.ok(
    plan.audibleTracks.every((t) => plan.changedTracks.includes(t)),
    "an audible track must also be a changed one",
  );
});

test("loading a pattern's own kit is reported as changing nothing", { skip }, () => {
  // The honest answer to a no-op, and the one case where a preview could mislead by staying silent.
  const img = dn2();
  const plan = planLoadKit(img, deviceFor(img), kitRecord(img, 0, DN2_LAYOUT), { pattern: 0 });

  assert.deepEqual(plan.changedTracks, []);
  assert.deepEqual(plan.audibleTracks, []);
  assert.match(describeLoadKit(plan).join(" "), /identical .* Loading it changes nothing/);
});

test("preset-locked trigs are counted as unaffected", { skip }, () => {
  // A preset lock points at the pool, which a kit does not contain. So those trigs keep their
  // sound, and a preview that counted them as changing would overstate the damage.
  const img = dn2();
  const { from } = busyPair(img);

  let checked = 0;
  for (let to = 0; to < DN2_LAYOUT.patternCount; to++) {
    const plan = planLoadKit(img, deviceFor(img), kitRecord(img, from, DN2_LAYOUT), { pattern: to });
    for (const track of plan.tracks) {
      assert.ok(
        track.lockedTrigs <= track.trigCount,
        `${track.label} claims ${track.lockedTrigs} locked of ${track.trigCount} trigs`,
      );
      if (track.lockedTrigs > 0) checked++;
      if (track.changed && track.trigCount > 0 && track.lockedTrigs === track.trigCount) {
        assert.ok(
          !plan.audibleTracks.includes(track.index),
          `${track.label} is fully preset-locked and must not be called audible`,
        );
      }
    }
  }
  assert.ok(checked > 0, "TECNO_EXP is a sound-locked project — some track must have locked trigs");
});

test("a stored file is refused — the body is what goes in", { skip }, () => {
  // 10,795 is what `/kits/A/1` actually read off a Digitone II: the record plus 43 bytes of
  // container. Writing that would run past the kit into the next pattern's.
  const img = dn2();
  assert.throws(
    () => planLoadKit(img, deviceFor(img), new Uint8Array(DN2_LAYOUT.kitSize + 43), { pattern: 0 }),
    (error: Error) => {
      assert.ok(error instanceof KitWriteError);
      assert.match(error.message, /43 bytes of container/);
      return true;
    },
  );
});

test("a Digitone 1 project is refused, because it has no kits at all", { skip }, () => {
  const dn1 = image(DN1_PROJECTS, "002 MORNING_JAM.dnprj");
  assert.throws(
    () => planLoadKit(dn1, deviceFor(dn1), new Uint8Array(DN2_LAYOUT.kitSize), { pattern: 0 }),
    (error: Error) => {
      assert.ok(error instanceof KitWriteError);
      assert.match(error.message, /no kits/);
      return true;
    },
  );
});

test("a pattern outside the project is refused", { skip }, () => {
  const img = dn2();
  assert.throws(
    () => planLoadKit(img, deviceFor(img), new Uint8Array(DN2_LAYOUT.kitSize), { pattern: 128 }),
    /not a pattern/,
  );
});

test("the original image is not modified", { skip }, () => {
  const before = dn2();
  const copy = Uint8Array.from(before);
  const { from, to } = busyPair(before);
  applyLoadKit(before, deviceFor(before), kitRecord(before, from, DN2_LAYOUT), { pattern: to });
  assert.deepEqual(before, copy, "applying must not write through its argument");
});
