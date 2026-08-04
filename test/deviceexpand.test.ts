import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { NO_CORPUS, corpusFiles, DN1_PROJECTS } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN1_LAYOUT, DN2_LAYOUT } from "../src/project/dn2image.js";
import { DN1_POOL_OFFSET, SOUND_NAME_OFFSET } from "../src/project/soundmap.js";
import { TRACK, trackRecord } from "../src/project/dn1.js";
import {
  DeviceExpandRefused,
  planDeviceExpand,
  poolCoverage,
} from "../src/expand/deviceexpand.js";

const DN1_SOUND_SIZE = 302;

/**
 * A DN1 image with one sound-locked trig pointing at `slot`, and optionally a sound in it.
 *
 * Every sound object is **framed**, because `convertProject` refuses an unframed one — a fixture
 * that skipped it would test the framing check rather than the pool guard. Note that framing is
 * exactly what cannot answer "is this slot occupied": a real DN1 pool is 128/128 framed with as
 * few as eleven sounds actually in it.
 */
function dn1With(slot: number, populated: boolean): Uint8Array {
  const image = new Uint8Array(DN1_LAYOUT.imageSize);
  const frame = (at: number): void => image.set([0xbe, 0xef, 0xba, 0xce, 0, 0, 0, 5], at);

  // **Every** pattern's sound locks, not just the first. A zeroed lock byte reads as slot 0, so
  // 127 untouched patterns would silently reference slot 0 from every step of every track — which
  // is exactly what the first version of this fixture did, and it showed up as a phantom lock.
  for (let p = 0; p < DN1_LAYOUT.patternCount; p++) {
    const at = DN1_LAYOUT.headerSize + p * DN1_LAYOUT.patternSize;
    const record = image.subarray(at, at + DN1_LAYOUT.patternSize);
    for (let t = 0; t < 4; t++) {
      trackRecord(record, t).fill(0xff, TRACK.soundLockOffset, TRACK.soundLockOffset + 64);
    }
  }

  const patternAt = DN1_LAYOUT.headerSize;
  const pattern = image.subarray(patternAt, patternAt + DN1_LAYOUT.patternSize);
  trackRecord(pattern, 0)[TRACK.soundLockOffset] = slot;

  // The four kit track sounds of every pattern, and all 128 pool slots.
  for (let k = 0; k < DN1_LAYOUT.patternCount; k++) {
    for (let t = 0; t < 4; t++) {
      frame(DN1_LAYOUT.kitBase + k * DN1_LAYOUT.kitSize + 28 + t * DN1_SOUND_SIZE);
    }
  }
  const poolAt = DN1_LAYOUT.tailBase + DN1_POOL_OFFSET;
  for (let i = 0; i < 128; i++) frame(poolAt + i * DN1_SOUND_SIZE);

  if (populated) {
    image.set(
      new TextEncoder().encode("A SOUND"),
      poolAt + slot * DN1_SOUND_SIZE + SOUND_NAME_OFFSET,
    );
  }
  return image;
}

test("a locked trig with no sound behind it is what the guard looks for", () => {
  const empty = poolCoverage(dn1With(42, false));
  assert.deepEqual(empty.referenced, [42]);
  assert.deepEqual(empty.missing, [42]);
  assert.equal(empty.lockedTrigs, 1);
  assert.equal(empty.complete, false);

  const filled = poolCoverage(dn1With(42, true));
  assert.deepEqual(filled.missing, []);
  assert.equal(filled.complete, true);
});

test("a project with no sound locks at all is complete by definition", () => {
  // The pool is irrelevant to it, so the guard must not block a sketch that never used one.
  const image = new Uint8Array(DN1_LAYOUT.imageSize).fill(0xff);
  const coverage = poolCoverage(image);
  assert.equal(coverage.lockedTrigs, 0);
  assert.equal(coverage.complete, true);
});

test("expanding from a DN1 whose pool was never captured is refused, and says why", () => {
  // The failure this module exists to prevent: a DN1 read over SysEx has no pool at all, because
  // no request reaches one. Expansion would promote every locked trig onto its own track and find
  // nothing to put there — succeeding loudly while losing exactly what it exists to move.
  const source = dn1With(42, false);
  assert.equal(poolCoverage(source).looksUncaptured, true);

  assert.throws(
    () => planDeviceExpand({ source, destination: new Uint8Array(DN2_LAYOUT.imageSize) }),
    (e: unknown) =>
      e instanceof DeviceExpandRefused &&
      /the whole pool is empty/i.test(String(e)) &&
      /SETTINGS > SYSEX DUMP/.test(String(e)),
  );
});

test("a dangling lock in a real project is a warning, not a refusal", () => {
  // `003 AMBZ.dnprj` locks five trigs to pool slot 11, which holds a framed but nameless sound.
  // That is the project's own untidiness and the file path has always tolerated it; refusing
  // would block a project that converts perfectly well. The corpus test below is what caught this.
  const source = dn1With(42, true);
  // A second lock, pointing at a slot with nothing in it, on a pool that is otherwise populated.
  trackRecord(
    source.subarray(DN1_LAYOUT.headerSize, DN1_LAYOUT.headerSize + DN1_LAYOUT.patternSize),
    1,
  )[TRACK.soundLockOffset] = 99;

  const coverage = poolCoverage(source);
  assert.deepEqual(coverage.missing, [99]);
  assert.equal(coverage.looksUncaptured, false, "one slot holds a sound, so the pool exists");

  const plan = planDeviceExpand({ source, destination: new Uint8Array(DN2_LAYOUT.imageSize) });
  assert.match(plan.warnings[0]!, /dangling lock in the project rather than a missing capture/);
});

test("the refusal can be overridden knowingly, and then it warns instead", () => {
  const plan = planDeviceExpand({
    source: dn1With(42, false),
    destination: new Uint8Array(DN2_LAYOUT.imageSize),
    allowIncompletePool: true,
  });
  assert.match(plan.warnings[0]!, /never captured/);
  assert.equal(plan.pool.complete, false);
});

test("a destination that is not a Digitone II is refused", () => {
  assert.throws(
    () =>
      planDeviceExpand({
        source: dn1With(42, true),
        destination: new Uint8Array(DN1_LAYOUT.imageSize),
      }),
    /a DN1 cannot receive one/,
  );
});

test("only the slots that differ from the destination are counted", () => {
  // The reason reading the destination first is worth a minute: expanding onto a DN2 that already
  // holds the result costs nothing, and expanding onto a blank costs only the patterns with work.
  const source = dn1With(42, true);
  const destination = new Uint8Array(DN2_LAYOUT.imageSize);

  const first = planDeviceExpand({ source, destination });
  assert.ok(first.changedSlots.length > 0, "a blank destination differs from a conversion");

  // Feed the conversion back as the destination: nothing left to send.
  const second = planDeviceExpand({ source, destination: first.image });
  assert.deepEqual(second.changedSlots, []);
  assert.equal(second.estimatedBytes, 0);
  assert.match(second.warnings.join(" "), /nothing to write/);
});

test("the destination is the template, so its bytes survive where nothing overwrites them", () => {
  // The insight that removes the template file: convertProject transplants into whatever it is
  // given, so a destination read off the target device carries its own header and tail through.
  const destination = new Uint8Array(DN2_LAYOUT.imageSize).fill(0x5a);
  const plan = planDeviceExpand({ source: dn1With(42, true), destination });

  // The tail past the settings record — song table country — is untouched by conversion.
  const deep = DN2_LAYOUT.tailBase + 80_000;
  assert.equal(plan.image[deep], 0x5a, "the destination's own tail came through");
});

// --- against the corpus --------------------------------------------------------------------------

test("a real DN1 project's locks are all backed by pool sounds", (t) => {
  // The guard has to agree with reality on a project that actually uses sound locks, or it is a
  // rule nobody can satisfy. Fails rather than skips if the corpus is present but unreadable —
  // a test that can pass by finding nothing is not a test.
  if (NO_CORPUS) {
    t.skip("no corpus");
    return;
  }

  let checked = 0;
  for (const path of corpusFiles(DN1_PROJECTS, ".dnprj").slice(0, 6)) {
    const name = path.replace(/^.*[\\/]/, "");
    const { payload } = parseProject(new Uint8Array(readFileSync(path)));
    const { image } = decodeProjectImage(payload.raw);
    if (image.length !== DN1_LAYOUT.imageSize) continue;

    const coverage = poolCoverage(image);
    checked++;
    if (coverage.lockedTrigs === 0) continue;

    // Not `missing.length === 0` — `003 AMBZ.dnprj` has a genuine dangling lock, and asserting
    // otherwise is what proved the first version of this guard too strict. What must hold is that
    // a project read from a **file** never looks like an uncaptured pool.
    assert.equal(
      coverage.looksUncaptured,
      false,
      `${name} has ${coverage.lockedTrigs} locked trig(s) and an entirely empty pool, which should ` +
        `be impossible for a project read off disk`,
    );
    assert.ok(coverage.populated > 0, `${name} has locks but no sounds anywhere in its pool`);
  }

  assert.ok(checked > 0, "the corpus is present but no DN1 project could be read");
});
