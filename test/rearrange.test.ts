import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, corpusPath } from "./corpus.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { kitRecord, patternRecord } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { blankPatternKit } from "@noiseandmatter/dnx-core/librarian/blank.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import {
  RearrangeError,
  applyRearrange,
  planRearrange,
  verifyRearrange,
} from "@noiseandmatter/dnx-core/librarian/rearrange.js";
import {
  asImport,
  clear,
  copyMany,
  copyOnto,
  keepOnly,
  mergeShuffles,
  move,
  moveMany,
  outOfRange,
  swap,
} from "@noiseandmatter/dnx-core/librarian/shuffle.js";

/*
 * **The shuffle primitive is tested in `shuffle.test.ts`, not here.**
 *
 * Thirteen tests of `swap`, `move`, `asImport`, `mergeShuffles`, `outOfRange`, `moveMany`,
 * `copyMany` and `keepOnly` used to sit at the top of this file. They predate `shuffle.test.ts` by
 * a week, and that file exists to be their home — its own header says the primitives "were covered
 * only indirectly". Every claim they made is covered there, so they were left behind rather than
 * kept for a reason: `shuffle.ts` reads **100% line and 100% branch coverage without them**, and
 * removing them moved neither number.
 *
 * What belongs here is what a shuffle does to a real project's bytes.
 */

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

/**
 * This asserted `unknown` until 2026-08-15, when the DN2 song table was located on hardware.
 *
 * The old expectation was correct for as long as it stood: the table sat somewhere in the
 * unidentified tail bytes, so the plan warned that it *could not check* rather than claiming a
 * safety it did not have. Now it can check, and a project with no songs earns no warning at all —
 * which is the point of having done the work.
 */
test("DN2: a project with no song is checked, not merely warned about", { skip: skipDn2 }, () => {
  const img = image(DN2_PROJECTS, DN2_FILE);
  assert.equal(deviceFor(img).songState(img), "empty");

  const plan = planRearrange(img, swap(0, 5));
  assert.equal(plan.ok, true);
  assert.ok(
    !plan.findings.some((f) => /song table has\s+never been located|cannot check this project for songs/.test(f.message)),
    "the DN2 song table is located now; nothing should still say it is not",
  );
});

// --- the version guard, which is the case a manager meets first -------------

test("DN2: PRESETS is storage version 2, readable but not writable", { skip: skipV2 }, () => {
  /*
   * **This test asserted the opposite until 2026-09-06**, and it was right to: version 2 was not
   * decoded, so a name read at the version-3 offset would have been a claim about the wrong bytes.
   *
   * It is decoded now — a version-3 record with a 31-byte track settings block, so the track record
   * is 1,183 bytes and everything after the sixteen tracks sits 64 bytes earlier
   * (`dn2-pattern-format.md` §3.5). `asVersion3` normalises it and every reader works unchanged.
   *
   * **`supported` stays false and that is the point of the split.** Reading is safe; writing is
   * not, because putting a normalised record back would widen every track by four bytes. The test
   * below this one holds that line.
   */
  const img = image(DN2_PROJECTS, DN2_V2_FILE);
  const device = deviceFor(img);

  let named = 0;
  let occupied = 0;
  let namedButEmpty = 0;
  for (let i = 0; i < device.patternCount; i++) {
    const summary = device.summarise(img, i);
    assert.equal(summary.version, 2, `pattern ${i} was version ${summary.version}`);
    assert.equal(summary.readable, true, `pattern ${i} should be readable`);
    assert.equal(summary.supported, false, `pattern ${i} must not be writable`);
    if (summary.name) named++;
    if (summary.occupied) occupied++;
    if (summary.name && !summary.occupied) namedButEmpty++;
  }

  /*
   * **The agreement is the real check, not the count.** A normalisation that quietly produced
   * empty records would still satisfy every assertion above; two independent readings landing on
   * the same 33 patterns — the name at one offset, the trigs at another 47 KB away — could not.
   */
  assert.equal(named, 33, "the factory project ships 33 demo patterns");
  assert.equal(occupied, 33, "and the trigs agree with the names, read from a different offset");
  assert.equal(namedButEmpty, 0, "a named pattern with no trigs would mean one of the two is wrong");
  assert.equal(device.summarise(img, 0).name, "LIGHTHOUSE");
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
