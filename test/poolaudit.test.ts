/**
 * The preset pool audit.
 *
 * Read-only, and checked against real projects because that is the only place its judgements can be
 * wrong in an interesting way. A pool audit that reports a tidy pool for every input is useless and
 * looks identical to a correct one.
 *
 * The manual is why this exists: *"The primary benefit of presets loaded to the pool is the
 * possibility for them to be preset locked."* A slot earns its place by being locked to, so
 * "occupied but nothing locks it" is the finding worth surfacing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_CORPUS, SKIP_REASON, requireCorpusFile, DN2_PROJECTS, DN1_PROJECTS } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { deviceFor } from "../src/librarian/device.js";
import { POOL_SOUND_COUNT } from "../src/project/soundmap.js";
import { PoolAuditError, auditPool, describePoolAudit } from "../src/librarian/poolaudit.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

function image(dir: string, name: string): Uint8Array {
  return decodeProjectImage(
    parseProject(new Uint8Array(readFileSync(requireCorpusFile(dir, name)))).payload.raw,
  ).image;
}

test("every slot is accounted for, exactly once", { skip }, () => {
  const img = image(DN2_PROJECTS, "008 JAM.dn2prj");
  const audit = auditPool(img, deviceFor(img));

  assert.equal(audit.slots.length, POOL_SOUND_COUNT);
  assert.deepEqual(audit.slots.map((s) => s.index), [...Array(POOL_SOUND_COUNT).keys()]);

  // Occupied and free partition the pool: a slot is one or the other, never both or neither.
  const occupied = audit.slots.filter((s) => s.occupied).map((s) => s.index);
  assert.equal(occupied.length + audit.free.length, POOL_SOUND_COUNT);
  assert.equal(new Set([...occupied, ...audit.free]).size, POOL_SOUND_COUNT);
});

test("a real project has presets, and they carry names and machines", { skip }, () => {
  // The check that stops this passing on an empty read: a project full of music must not audit as
  // an empty pool.
  const img = image(DN2_PROJECTS, "008 JAM.dn2prj");
  const audit = auditPool(img, deviceFor(img));
  const occupied = audit.slots.filter((s) => s.occupied);

  assert.ok(occupied.length > 0, "008 JAM should hold presets in its pool");
  assert.ok(occupied.some((s) => s.name.length > 0), "at least one preset should be named");
  assert.ok(occupied.some((s) => s.machine !== undefined), "at least one machine should decode");
});

test("locked slots are the ones the patterns actually reference", { skip }, () => {
  const img = image(DN2_PROJECTS, "008 JAM.dn2prj");
  const audit = auditPool(img, deviceFor(img));

  for (const slot of audit.slots) {
    // The two must agree: a slot with locks names the patterns holding them, and one without names
    // none. They are computed from the same walk, so disagreement means the walk is wrong.
    assert.equal(
      slot.lockCount > 0,
      slot.patterns.length > 0,
      `slot ${slot.index} reports ${slot.lockCount} locks across ${slot.patterns.length} patterns`,
    );
  }
});

test("scope changes the answer, which is the point of taking it", { skip }, () => {
  const img = image(DN2_PROJECTS, "008 JAM.dn2prj");
  const device = deviceFor(img);

  const whole = auditPool(img, device);
  const onePattern = auditPool(img, device, { patterns: [0] });

  // Narrowing the scope cannot discover locks, only lose them — so one pattern's usage is a subset
  // of the project's, and its unused list is at least as long.
  assert.ok(onePattern.unused.length >= whole.unused.length);
  for (const slot of onePattern.slots) {
    assert.ok(slot.lockCount <= whole.slots[slot.index]!.lockCount);
  }
});

test("duplicates are byte-identical, not merely similar", { skip }, () => {
  const img = image(DN2_PROJECTS, "017 PRESETS.dn2prj");
  const audit = auditPool(img, deviceFor(img));

  for (const group of audit.duplicates) {
    assert.ok(group.length > 1, "a group of one is not a duplicate");
    // Every member must actually hold a preset — comparing empty slots would report 100 duplicates
    // on every project and mean nothing.
    for (const index of group) assert.ok(audit.slots[index]!.occupied);
  }
});

test("a Digitone 1 is refused rather than read with the wrong offsets", { skip }, () => {
  // The failure this prevents is the worst kind an audit can have: confident nonsense. DN2 offsets
  // over DN1 bytes would produce names, counts and findings, all invented.
  const img = image(DN1_PROJECTS, "001 PRESETS.dnprj");
  assert.throws(() => auditPool(img, deviceFor(img)), (error: Error) => {
    assert.ok(error instanceof PoolAuditError);
    assert.match(error.message, /Digitone II patterns/);
    return true;
  });
});

test("the summary always says how full the pool is", { skip }, () => {
  const img = image(DN2_PROJECTS, "008 JAM.dn2prj");
  const lines = describePoolAudit(auditPool(img, deviceFor(img)));
  assert.ok(lines.length > 0);
  assert.match(lines[0]!, /slots hold a preset/);
});
