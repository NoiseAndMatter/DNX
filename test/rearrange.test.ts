import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, corpusPath } from "./corpus.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/project/projectfile.js";
import { kitRecord, patternRecord } from "../src/project/dn2image.js";
import { blankPatternKit } from "../src/librarian/blank.js";
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
  clear,
  copyMany,
  copyOnto,
  keepOnly,
  mergeShuffles,
  move,
  moveMany,
  movedSlots,
  outOfRange,
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

test("out-of-range slots can be reported or thrown, as the caller prefers", () => {
  assert.deepEqual(outOfRange(swap(0, 128), 128), [128]);
  assert.deepEqual(outOfRange(swap(0, 127), 128), []);
  assert.throws(() => assertWithin(swap(0, 128), 128), ShuffleError);
  assert.doesNotThrow(() => assertWithin(swap(0, 127), 128));
});

test("two sources landing on one slot is refused, not silently resolved", () => {
  assert.throws(() => asImport([{ from: 1, to: 5 }, { from: 2, to: 5 }]), ShuffleError);
});

test("a batch lands sources at consecutive slots in the order given", () => {
  const s = moveMany([10, 20, 30], 4);
  assert.equal(sourceOf(s, 4), 10);
  assert.equal(sourceOf(s, 5), 20);
  assert.equal(sourceOf(s, 6), 30);
  assert.equal(sourceOf(s, 10), undefined, "a move empties its sources");
});

test("a batch copy empties nothing", () => {
  const s = copyMany([10, 20], 4);
  assert.equal(sourceOf(s, 10), 10);
  assert.equal(sourceOf(s, 20), 20);
});

test("overlapping batch sources and destinations are a permutation, not a double read", () => {
  const s = moveMany([4, 3], 3);
  assert.equal(sourceOf(s, 3), 4);
  assert.equal(sourceOf(s, 4), 3);
  assert.equal(touchedSlots(s).length, 2, "nothing else is disturbed");
});

test("keepOnly does not clear a slot that is already where it belongs", () => {
  const s = keepOnly([0, 7], 16);
  assert.equal(sourceOf(s, 0), 0, "slot 0 is kept in place and must not be blanked");
  assert.equal(sourceOf(s, 1), 7);
  assert.equal(sourceOf(s, 2), undefined);
  assert.equal(sourceOf(s, 7), undefined, "the moved source is vacated");
});

// --- against real projects -------------------------------------------------

function image(dir: string, name: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(join(corpusPath(dir), name))));
  return decodeProjectImage(payload.raw).image;
}

/**
 * Overwriting occupied slots needs explicit acknowledgement, so most tests here pass it.
 * The tests that check the gate itself deliberately do not.
 */
const CONFIRM = { confirmOverwrite: true } as const;

const DN1_FILE = "002 MORNING_JAM.dnprj";
const DN2_FILE = "MORNING_JAM.dn2prj";
/** The one corpus project whose pattern records are storage version 2, not 3. */
const DN2_V2_FILE = "PRESETS.dn2prj";

function have(dir: string, name: string): boolean {
  return !NO_CORPUS && existsSync(join(corpusPath(dir), name));
}

function firstOccupied(img: Uint8Array): number {
  const device = deviceFor(img);
  for (let i = 0; i < device.patternCount; i++) {
    if (device.summarise(img, i).occupied) return i;
  }
  throw new Error("no occupied pattern in this project");
}

function firstEmpty(img: Uint8Array, notThis: number): number {
  const device = deviceFor(img);
  for (let i = 0; i < device.patternCount; i++) {
    const s = device.summarise(img, i);
    if (i !== notThis && s.supported && !s.occupied) return i;
  }
  throw new Error("no empty pattern in this project");
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

    const { image: out, verification } = applyRearrange(img, swap(a, b), CONFIRM);

    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.equal(device.summarise(out, a).name, nameB, "slot a should now hold b's pattern");
    assert.equal(device.summarise(out, b).name, nameA, "slot b should now hold a's pattern");
  });

  test(`${label}: a swapped record is told which slot it now occupies`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const { image: out } = applyRearrange(img, swap(2, 11), CONFIRM);

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
    const once = applyRearrange(img, swap(1, 6), CONFIRM).image;
    const twice = applyRearrange(once, swap(1, 6), CONFIRM).image;
    assert.deepEqual(twice, img, "a swap should be its own inverse");
  });

  test(`${label}: applying does not modify the input image`, { skip }, () => {
    const img = image(dir, file);
    const before = Uint8Array.from(img);
    applyRearrange(img, swap(0, 7), CONFIRM);
    assert.deepEqual(img, before);
  });

  test(`${label}: a move carries the pattern and empties its source`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const from = firstOccupied(img);
    const to = firstEmpty(img, from);
    const movedName = device.summarise(img, from).name;

    const { image: out, plan, verification } = applyRearrange(img, move(from, to), CONFIRM);

    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.deepEqual(plan.emptied, [from]);
    assert.equal(device.summarise(out, to).name, movedName, "the pattern did not arrive");
    assert.equal(device.summarise(out, from).occupied, false, "the source was not emptied");
  });

  test(`${label}: a cleared slot reads as an empty pattern`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const slot = firstOccupied(img);
    assert.equal(device.summarise(img, slot).occupied, true, "expected a slot with trigs");

    const { image: out, verification } = applyRearrange(img, clear(slot), CONFIRM);

    assert.equal(verification.ok, true, verification.problems.join("; "));
    const after = device.summarise(out, slot);
    assert.equal(after.occupied, false);
    assert.equal(after.trigCount, 0);
    assert.equal(after.supported, true, "the blank must be a version we can read");
  });

  test(`${label}: a cleared slot is byte-identical to the device's own empty pattern`, {
    skip,
  }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const { image: out } = applyRearrange(img, clear(9), CONFIRM);

    const { pattern, kit } = blankPatternKit(device, 9);
    assert.deepEqual(Uint8Array.from(patternRecord(out, 9, device.layout)), pattern);
    assert.deepEqual(Uint8Array.from(kitRecord(out, 9, device.layout)), kit);
  });

  test(`${label}: clearing occupied work is destructive and needs confirmation`, { skip }, () => {
    const img = image(dir, file);
    const slot = firstOccupied(img);
    const plan = planRearrange(img, clear(slot));

    assert.equal(plan.ok, true, "destroying work is the user's call, not a blocker");
    assert.equal(plan.destructive.length, 1);
    assert.equal(plan.destructive[0]!.slot, slot);
    assert.equal(
      plan.destructive[0]!.replacedBy,
      undefined,
      "an emptied slot is replaced by nothing",
    );
    assert.throws(
      () => applyRearrange(img, clear(slot)),
      RearrangeError,
      "must refuse to destroy work unless told to",
    );
  });

  test(`${label}: a batch move lands sources at consecutive slots`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const a = firstOccupied(img);
    const b = firstEmpty(img, a);
    const names = [device.summarise(img, a).name, device.summarise(img, b).name];

    const { image: out, verification } = applyRearrange(img, moveMany([a, b], 100), CONFIRM);

    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.equal(device.summarise(out, 100).name, names[0]);
    assert.equal(device.summarise(out, 101).name, names[1]);
    assert.equal(device.summarise(out, a).occupied, false, "source a was not emptied");
  });

  test(`${label}: a batch copy leaves its sources in place`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const a = firstOccupied(img);
    const name = device.summarise(img, a).name;

    const { image: out } = applyRearrange(img, copyMany([a, a + 1], 100), CONFIRM);

    assert.equal(device.summarise(out, 100).name, name);
    assert.equal(device.summarise(out, a).name, name, "a copy must not empty its source");
  });

  test(`${label}: every collision is reported with what replaces it`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const a = firstOccupied(img);
    const plan = planRearrange(img, copyMany([a], a + 1));

    const landing = plan.destructive.find((c) => c.slot === a + 1);
    if (device.summarise(img, a + 1).occupied) {
      assert.ok(landing, "an occupied destination must appear in destructive");
      assert.equal(landing.replacedBy, a, "the report must name what overwrites it");
    }
  });

  test(`${label}: a batch running past the end of the bank is explained, not thrown`, {
    skip,
  }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const plan = planRearrange(img, moveMany([0, 1, 2], device.patternCount - 1));

    assert.equal(plan.ok, false);
    assert.ok(
      plan.findings.some((f) => f.severity === "blocker" && /outside/.test(f.message)),
      "expected a blocker explaining the overrun",
    );
  });

  test(`${label}: keepOnly preserves a pattern already in its final position`, { skip }, () => {
    const img = image(dir, file);
    const device = deviceFor(img);
    const keepInPlace = 0;
    const keepMoved = firstOccupied(img) === 0 ? 3 : firstOccupied(img);
    const nameA = device.summarise(img, keepInPlace).name;
    const nameB = device.summarise(img, keepMoved).name;

    const { image: out, verification } = applyRearrange(
      img,
      keepOnly([keepInPlace, keepMoved], device.patternCount),
      CONFIRM,
    );

    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.equal(device.summarise(out, 0).name, nameA, "the in-place pattern was cleared");
    assert.equal(device.summarise(out, 1).name, nameB);
    for (const slot of [2, 5, 40, 127]) {
      assert.equal(device.summarise(out, slot).occupied, false, `slot ${slot} survived`);
    }
  });

  test(`${label}: the plan names where the blank came from`, { skip }, () => {
    const img = image(dir, file);
    const plan = planRearrange(img, clear(9));
    assert.match(plan.blankSource, /slot \d+$/);
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
  assert.throws(() => applyRearrange(img, swap(0, 5), CONFIRM), RearrangeError);
});

test("verification catches a slot index that was not rewritten", { skip: skipDn2 }, () => {
  const img = image(DN2_PROJECTS, DN2_FILE);
  const device = deviceFor(img);
  const { image: out } = applyRearrange(img, swap(2, 11), CONFIRM);

  // Corrupt exactly what applyRearrange is responsible for maintaining.
  const at = device.layout.headerSize + 2 * device.layout.patternSize;
  out[at + device.slotIndexOffset] = 99;

  const verification = verifyRearrange(out, swap(2, 11));
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((p) => /believes it occupies slot 99/.test(p)));
});
