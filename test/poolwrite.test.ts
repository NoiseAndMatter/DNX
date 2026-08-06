/**
 * Adding a preset to a project's pool.
 *
 * Every test here is about a **refusal**, because that is where the value is: writing 359 bytes into
 * an array of 359-byte slots is arithmetic, and what makes this worth having is that it declines to
 * do so when the result would be wrong or would quietly destroy something.
 *
 * Real projects throughout. A pool with room, a pool that is full, and a slot with trigs locked to
 * it are all states that occur, and a synthetic image would only test the arithmetic.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_CORPUS, SKIP_REASON, requireCorpusFile, DN2_PROJECTS } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { deviceFor } from "../src/librarian/device.js";
import { DN2_SOUND_SIZE, SOUND_NAME_OFFSET } from "../src/project/soundmap.js";
import { MACHINE, SOUND_MACHINE_OFFSET } from "../src/project/machine.js";
import { auditPool } from "../src/librarian/poolaudit.js";
import {
  PoolWriteError,
  applyAddPreset,
  describeAddPreset,
  planAddPreset,
} from "../src/librarian/poolwrite.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

function image(name: string): Uint8Array {
  return decodeProjectImage(
    parseProject(new Uint8Array(readFileSync(requireCorpusFile(DN2_PROJECTS, name)))).payload.raw,
  ).image;
}

/** A preset body of the right size, named, with a chosen machine. */
function preset(name: string, machine: number = MACHINE.fmTone): Uint8Array {
  const body = new Uint8Array(DN2_SOUND_SIZE);
  body.set([...name].map((c) => c.charCodeAt(0)), SOUND_NAME_OFFSET);
  body[SOUND_MACHINE_OFFSET] = machine;
  return body;
}

test("a preset lands in the first free slot and the image changes only there", { skip }, () => {
  const before = image("008 JAM.dn2prj");
  const device = deviceFor(before);
  const free = auditPool(before, device).free[0]!;

  const { image: after, plan } = applyAddPreset(before, device, preset("NEW ONE"), {});
  assert.equal(plan.slot, free);

  // Exactly one slot's worth of bytes may differ. Anything else means the offset is wrong, and a
  // pool write that strays corrupts the preset next to it rather than failing.
  let differing = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
  assert.ok(differing > 0, "something must have been written");
  assert.ok(differing <= DN2_SOUND_SIZE, `${differing} bytes changed, more than one slot`);

  assert.equal(auditPool(after, device).slots[free]!.name, "NEW ONE");
});

test("the original image is not modified", { skip }, () => {
  const before = image("008 JAM.dn2prj");
  const copy = Uint8Array.from(before);
  applyAddPreset(before, deviceFor(before), preset("X"), {});
  assert.deepEqual(before, copy, "applying must not write through its argument");
});

test("a MIDI preset is refused, because the pool cannot hold one", { skip }, () => {
  // The manual is flat about it, and a preset lock cannot reach a MIDI preset — so writing it would
  // leave the device holding something it will not use, with nothing saying why.
  const img = image("008 JAM.dn2prj");
  assert.throws(
    () => planAddPreset(img, deviceFor(img), preset("MIDI THING", MACHINE.midi)),
    (error: Error) => {
      assert.ok(error instanceof PoolWriteError);
      assert.match(error.message, /MIDI preset/);
      return true;
    },
  );
});

test("a whole stored file is refused — the body is what goes in", { skip }, () => {
  // 43 bytes of container is exactly the mistake this catches, and it would otherwise write past
  // the slot into the next preset.
  const img = image("008 JAM.dn2prj");
  const file = new Uint8Array(DN2_SOUND_SIZE + 43);
  assert.throws(() => planAddPreset(img, deviceFor(img), file), /43 bytes of container/);
});

test("an occupied slot is refused, and the refusal says what is in it", { skip }, () => {
  const img = image("008 JAM.dn2prj");
  const device = deviceFor(img);
  const used = auditPool(img, device).slots.find((s) => s.occupied && s.lockCount > 0)!;

  assert.throws(
    () => planAddPreset(img, device, preset("NEW"), { slot: used.index }),
    (error: Error) => {
      assert.match(error.message, new RegExp(String(used.lockCount)));
      assert.match(error.message, /changes what those trigs play/);
      return true;
    },
  );

  // With consent it goes ahead, and the plan says what was lost.
  const { plan } = applyAddPreset(img, device, preset("NEW"), {
    slot: used.index,
    confirmOverwrite: true,
  });
  assert.equal(plan.replaces?.lockCount, used.lockCount);
  assert.match(describeAddPreset(plan), /replacing/);
});

test("a full pool is refused, and points at the presets nothing locks", { skip }, () => {
  // 017 PRESETS has all 128 slots occupied — the case where "first free slot" has no answer.
  const img = image("017 PRESETS.dn2prj");
  const device = deviceFor(img);
  assert.equal(auditPool(img, device).free.length, 0, "this project should have a full pool");

  assert.throws(() => planAddPreset(img, device, preset("NEW")), (error: Error) => {
    assert.match(error.message, /pool is full/);
    // Useful rather than merely correct: it names somewhere to make room.
    assert.match(error.message, /locked by nothing/);
    return true;
  });
});

test("a slot outside the pool is refused", { skip }, () => {
  const img = image("008 JAM.dn2prj");
  assert.throws(() => planAddPreset(img, deviceFor(img), preset("X"), { slot: 128 }), /not a pool slot/);
});
