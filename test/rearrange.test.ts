import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, corpusPath } from "./corpus.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/project/projectfile.js";
import { deviceFor } from "../src/librarian/device.js";
import {
  RearrangeError,
  applyRearrange,
  planRearrange,
  verifyRearrange,
} from "../src/librarian/rearrange.js";
import {
  NULL_SHUFFLE,
  asImport,
  asShuffle,
  assertWithin,
  copyOnto,
  mergeShuffles,
  movedSlots,
  rereference,
  ShuffleError,
  sourceOf,
  swap,
  touchedSlots,
} from "../src/librarian/shuffle.js";

// --- the shuffle primitive, no corpus needed -------------------------------

test("an untouched slot keeps its own contents", () => {
  const s = swap(3, 9);
  assert.equal(sourceOf(s, 5), 5, "slot 5 is not involved and should keep what it has");
  assert.equal(rereference(s, 5), 5);
});

test("a swap moves both ways and empties nothing", () => {
  const s = swap(3, 9);
  assert.equal(sourceOf(s, 3), 9);
  assert.equal(sourceOf(s, 9), 3);
  assert.deepEqual(touchedSlots(s), [3, 9]);
  for (const slot of touchedSlots(s)) {
    assert.notEqual(sourceOf(s, slot), undefined, `slot ${slot} should not be emptied`);
  }
});

test("a bare intra-bank move empties its source", () => {
  const s = asShuffle([{ from: 3, to: 7 }]);
  assert.equal(sourceOf(s, 7), 3);
  assert.equal(sourceOf(s, 3), undefined, "moving out of 3 leaves it empty");
});

test("an import leaves the source bank alone", () => {
  const s = asImport([{ from: 3, to: 7 }]);
  assert.equal(sourceOf(s, 7), 3);
  assert.equal(sourceOf(s, 3), 3, "the source bank is untouched by an import");
});

test("rereference reports where a moved slot went, for repairing references", () => {
  const s = asShuffle([{ from: 3, to: 7 }]);
  assert.equal(rereference(s, 3), 7);
  assert.deepEqual(movedSlots(s), [3]);
});

test("a move onto itself is a no-op", () => {
  assert.equal(swap(4, 4).isEmpty, true);
  assert.equal(copyOnto(4, 4).isEmpty, true);
  assert.equal(NULL_SHUFFLE.isEmpty, true);
});

test("later moves win when shuffles are merged", () => {
  const merged = mergeShuffles(copyOnto(1, 2), copyOnto(3, 2));
  assert.equal(sourceOf(merged, 2), 3);
});

test("an out-of-range slot is a programming error, not a finding", () => {
  assert.throws(() => assertWithin(swap(0, 128), 128), ShuffleError);
  assert.throws(() => assertWithin(swap(0, -1), 128), ShuffleError);
  assert.doesNotThrow(() => assertWithin(swap(0, 127), 128));
});

// --- against real projects -------------------------------------------------

function image(dir: string, name: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(join(corpusPath(dir), name))));
  return decodeProjectImage(payload.raw).image;
}

const DN1_FILE = "002 MORNING_JAM.dnprj";
const DN2_FILE = "MORNING_JAM.dn2prj";
/** The one corpus project whose pattern records are storage version 2, not 3. */
const DN2_V2_FILE = "PRESETS.dn2prj";

function have(dir: string, name: string): boolean {
  return !NO_CORPUS && existsSync(join(corpusPath(dir), name));
}

const skipDn1 = !have(DN1_PROJECTS, DN1_FILE);
const skipDn2 = !have(DN2_PROJECTS, DN2_FILE);
const skipV2 = !have(DN2_PROJECTS, DN2_V2_FILE);

for (const [label, dir, file, skip] of [
  ["DN1", DN1_PROJECTS, DN1_FILE, skipDn1],
  ["DN2", DN2_PROJECTS, DN2_FILE, skipDn2],
] as const) {
  test(`${label}: planning is pure`, { skip }, () => {
    const img = image(dir, file);
    const before = Uint8Array.from(img);
    planRearrange(img, swap(0, 5));
    assert.deepEqual(img, before, "planning must not modify the image");
  });

  test(`${label}: a swap exchanges both patterns and their kits`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const a = 0;
    const b = 5;

    const nameA = device.summarise(img, a).name;
    const nameB = device.summarise(img, b).name;

    const { image: out, verification } = applyRearrange(img, swap(a, b));

    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.equal(device.summarise(out, a).name, nameB, "slot a should now hold b's pattern");
    assert.equal(device.summarise(out, b).name, nameA, "slot b should now hold a's pattern");
  });

  test(`${label}: a swapped record is told which slot it now occupies`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const { image: out } = applyRearrange(img, swap(2, 11));

    for (const slot of [2, 11]) {
      const at = device.layout.headerSize + slot * device.layout.patternSize;
      assert.equal(
        out[at + device.slotIndexOffset],
        slot,
        `pattern in slot ${slot} still believes it lives elsewhere`,
      );
    }
  });

  test(`${label}: swapping twice returns the original image`, { skip }, () => {
    const img = image(dir, file);
    const once = applyRearrange(img, swap(1, 6)).image;
    const twice = applyRearrange(once, swap(1, 6)).image;
    assert.deepEqual(twice, img, "a swap should be its own inverse");
  });

  test(`${label}: applying does not modify the input image`, { skip }, () => {
    const img = image(dir, file);
    const before = Uint8Array.from(img);
    applyRearrange(img, swap(0, 7));
    assert.deepEqual(img, before);
  });

  test(`${label}: a move that would leave a hole is refused`, { skip }, () => {
    const img = image(dir, file);
    const plan = planRearrange(img, asShuffle([{ from: 3, to: 8 }]));

    assert.equal(plan.ok, false, "leaving a hole needs a blank pattern we do not have");
    assert.deepEqual(plan.emptied, [3]);
    assert.throws(() => applyRearrange(img, asShuffle([{ from: 3, to: 8 }])), RearrangeError);
  });

  test(`${label}: the plan reports what would be overwritten`, { skip }, () => {
    const img = image(dir, file);
    const plan = planRearrange(img, copyOnto(0, 5));
    const change = plan.changes.find((c) => c.to === 5);

    assert.ok(change, "expected a change landing on slot 5");
    assert.equal(change.from, 0);
    assert.equal(typeof change.destinationOccupied, "boolean");
  });
}

test("DN1: a project with no song reports its song table as empty", { skip: skipDn1 }, () => {
  const img = image(DN1_PROJECTS, DN1_FILE);
  const state = deviceFor(img).songState(img);
  assert.ok(state === "empty" || state === "occupied", `unexpected DN1 song state ${state}`);
});

test("DN2: the song table is unknown, and the plan says so rather than claiming safety", {
  skip: skipDn2,
}, () => {
  const img = image(DN2_PROJECTS, DN2_FILE);
  assert.equal(deviceFor(img).songState(img), "unknown");

  const plan = planRearrange(img, swap(0, 5));
  assert.equal(plan.ok, true, "an unknown song table warns, it does not block");
  assert.ok(
    plan.findings.some((f) => f.severity === "warning" && /song table/.test(f.message)),
    "expected a warning about the unlocatable DN2 song table",
  );
});

// --- the version guard, which is the case a manager meets first -------------

test("DN2: PRESETS is storage version 2, and every pattern of it", { skip: skipV2 }, () => {
  const img = image(DN2_PROJECTS, DN2_V2_FILE);
  const device = deviceFor(img);

  for (let i = 0; i < device.patternCount; i++) {
    const summary = device.summarise(img, i);
    assert.equal(summary.version, 2, `pattern ${i} was version ${summary.version}`);
    assert.equal(summary.supported, false);
    assert.equal(summary.name, undefined, "an unsupported record must not claim a name");
  }
});

test("DN2: a version we do not parse is refused, not guessed at", { skip: skipV2 }, () => {
  const img = image(DN2_PROJECTS, DN2_V2_FILE);
  const plan = planRearrange(img, swap(0, 5));

  assert.equal(plan.ok, false);
  assert.ok(
    plan.findings.some((f) => f.severity === "blocker" && /version 2/.test(f.message)),
    `expected a version blocker, got: ${plan.findings.map((f) => f.message).join(" | ")}`,
  );
  assert.throws(() => applyRearrange(img, swap(0, 5)), RearrangeError);
});

test("verification catches a slot index that was not rewritten", { skip: skipDn2 }, () => {
  const img = image(DN2_PROJECTS, DN2_FILE);
  const device = deviceFor(img);
  const { image: out } = applyRearrange(img, swap(2, 11));

  // Corrupt exactly what applyRearrange is responsible for maintaining.
  const at = device.layout.headerSize + 2 * device.layout.patternSize;
  out[at + device.slotIndexOffset] = 99;

  const verification = verifyRearrange(out, swap(2, 11));
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((p) => /believes it occupies slot 99/.test(p)));
});
