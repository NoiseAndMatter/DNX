import assert from "node:assert/strict";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseProject } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN1_KIT, DN1_LAYOUT, DN2_KIT, DN2_LAYOUT, kitRecord } from "../src/project/dn2image.js";
import {
  COPY_MAP,
  DEFAULT_BYTES,
  DN1_POOL_OFFSET,
  DN1_SOUND_SIZE,
  DN2_POOL_OFFSET,
  DN2_SOUND_SIZE,
  DN2_PROJECT_SOUND_VERSION,
  POOL_SOUND_COUNT,
  SCALAR_FIELDS,
  SELECTOR_FIELDS,
  SELECTOR_TABLE,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
  convertDn1SoundToDn2,
  convertDn1SoundToDn2Detailed,
  mapSelector,
} from "../src/project/soundmap.js";

const EXAMPLES = CORPUS ?? "";

/**
 * Projects held out of the mapping derivation. Only these three are used for the
 * reproduction assertions below, so the test measures the map against data it was not
 * fitted to — apart from the ten `VALIDATION_COPIES` entries and one scalar-table entry
 * that these very projects revealed, which the module documents as such.
 */
const HELD_OUT_PAIRS = [
  { name: "ODD XS", dn1: "051 ODD XS.dnprj", dn2: "010 ODD XS.dn2prj" },
  { name: "TECNO_EXP", dn1: "053 TECNO_EXP.dnprj", dn2: "012 TECNO_EXP.dn2prj" },
  { name: "DROWSY_WALK", dn1: "031 DROWSY_WALK.dnprj", dn2: "013 DROWSY_WALK.dn2prj" },
];

const OBJECT_MAGIC = [0xbe, 0xef, 0xba, 0xce];

function loadImage(path: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  return decodeProjectImage(payload.raw).image;
}

function hasMagic(data: Uint8Array, at: number): boolean {
  return OBJECT_MAGIC.every((b, i) => data[at + i] === b);
}

interface SoundPair {
  label: string;
  dn1: Uint8Array;
  dn2: Uint8Array;
}

/** Every aligned sound pair of one project pair: 4 kit slots x 128 kits, plus 128 pool slots. */
function soundPairs(dn1File: string, dn2File: string, label: string): SoundPair[] {
  const image1 = loadImage(dn1File);
  const image2 = loadImage(dn2File);
  const pairs: SoundPair[] = [];

  for (let kit = 0; kit < DN1_LAYOUT.patternCount; kit++) {
    const kit1 = kitRecord(image1, kit, DN1_LAYOUT);
    const kit2 = kitRecord(image2, kit, DN2_LAYOUT);
    for (let slot = 0; slot < DN1_KIT.soundCount; slot++) {
      const at1 = DN1_KIT.soundOffset + slot * DN1_SOUND_SIZE;
      const at2 = DN2_KIT.soundOffset + slot * DN2_SOUND_SIZE;
      assert.ok(hasMagic(kit1, at1), `${label} DN1 kit ${kit} slot ${slot} is not object-framed`);
      assert.ok(hasMagic(kit2, at2), `${label} DN2 kit ${kit} slot ${slot} is not object-framed`);
      pairs.push({
        label: `${label} kit ${kit} slot ${slot}`,
        dn1: kit1.subarray(at1, at1 + DN1_SOUND_SIZE),
        dn2: kit2.subarray(at2, at2 + DN2_SOUND_SIZE),
      });
    }
  }

  for (let slot = 0; slot < POOL_SOUND_COUNT; slot++) {
    const at1 = DN1_LAYOUT.tailBase + DN1_POOL_OFFSET + slot * DN1_SOUND_SIZE;
    const at2 = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE;
    assert.ok(hasMagic(image1, at1), `${label} DN1 pool slot ${slot} is not object-framed`);
    assert.ok(hasMagic(image2, at2), `${label} DN2 pool slot ${slot} is not object-framed`);
    pairs.push({
      label: `${label} pool slot ${slot}`,
      dn1: image1.subarray(at1, at1 + DN1_SOUND_SIZE),
      dn2: image2.subarray(at2, at2 + DN2_SOUND_SIZE),
    });
  }

  return pairs;
}

function heldOutPairs(): SoundPair[] {
  const out: SoundPair[] = [];
  for (const pair of HELD_OUT_PAIRS) {
    const dn1File = join(EXAMPLES, "01_DN1/01_Projects", pair.dn1);
    const dn2File = join(EXAMPLES, "02_DN2/01_Projects", pair.dn2);
    if (!existsSync(dn1File) || !existsSync(dn2File)) continue;
    out.push(...soundPairs(dn1File, dn2File, pair.name));
  }
  return out;
}

test("the mapping classifies every DN2 sound byte exactly once", () => {
  const owner = new Map<number, string>();
  const claim = (offset: number, who: string) => {
    const previous = owner.get(offset);
    assert.equal(previous, undefined, `dn2[${offset}] claimed by both ${previous} and ${who}`);
    owner.set(offset, who);
  };

  for (let i = 0; i < SOUND_NAME_SIZE; i++) claim(SOUND_NAME_OFFSET + i, "name");
  for (const [dn2Offset] of COPY_MAP) claim(dn2Offset, "copy");
  for (const [dn2Offset] of SELECTOR_FIELDS) claim(dn2Offset, "selector");
  for (const field of SCALAR_FIELDS) claim(field.dn2Offset, "scalar");
  for (const [dn2Offset] of DEFAULT_BYTES) claim(dn2Offset, "default");

  // Whatever is left is the implicit zero fill.
  let zeroFilled = 0;
  for (let offset = 0; offset < DN2_SOUND_SIZE; offset++) if (!owner.has(offset)) zeroFilled++;
  assert.equal(owner.size + zeroFilled, DN2_SOUND_SIZE);

  // No DN1 byte may feed two different DN2 fields.
  const sources = new Map<number, number>();
  for (const [dn2Offset, dn1Offset] of COPY_MAP) {
    assert.equal(sources.get(dn1Offset), undefined, `dn1[${dn1Offset}] copied to two DN2 offsets`);
    sources.set(dn1Offset, dn2Offset);
  }
});

test("mapSelector only interpolates where the neighbouring deltas agree", () => {
  assert.deepEqual(mapSelector(24), { value: 40, kind: "verified" });
  // 27 -> 43 and 29 -> 45 are both +16, so 28 -> 44.
  assert.deepEqual(mapSelector(28), { value: 44, kind: "interpolated" });
  // 11 -> 21 is +10 but 15 -> 29 is +14, so 12 and 13 stay unmapped.
  assert.deepEqual(mapSelector(12), { value: 12, kind: "unmapped" });
  assert.deepEqual(mapSelector(13), { value: 13, kind: "unmapped" });
  // The top of the table is not monotone, so nothing above it may be guessed.
  assert.equal(mapSelector(200).kind, "unmapped");
  for (const [from, to] of SELECTOR_TABLE) assert.deepEqual(mapSelector(from), { value: to, kind: "verified" });
});

test("convertDn1SoundToDn2 rejects malformed input", () => {
  assert.throws(() => convertDn1SoundToDn2(new Uint8Array(DN1_SOUND_SIZE - 1)), /302-byte/);
  assert.throws(() => convertDn1SoundToDn2(new Uint8Array(DN1_SOUND_SIZE)), /BEEFBACE/);
});

test("held-out projects: conversion reproduces Elektron's DN2 sounds byte for byte", { skip: NO_CORPUS && SKIP_REASON }, () => {
  const pairs = heldOutPairs();
  assert.ok(pairs.length > 0, "no held-out project files found under 00_Examples");
  assert.equal(pairs.length, HELD_OUT_PAIRS.length * (128 * 4 + 128));

  const failures: string[] = [];
  for (const pair of pairs) {
    const converted = convertDn1SoundToDn2(pair.dn1);
    if (converted.length !== pair.dn2.length) {
      failures.push(`${pair.label}: length ${converted.length} != ${pair.dn2.length}`);
      continue;
    }
    for (let offset = 0; offset < converted.length; offset++) {
      if (converted[offset] !== pair.dn2[offset]) {
        failures.push(
          `${pair.label}: dn2[${offset}] got 0x${converted[offset]!.toString(16)} want 0x${pair.dn2[offset]!.toString(16)}`,
        );
      }
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} mismatched bytes`);
});

test("held-out projects: nothing is dropped and no selector goes unmapped", { skip: NO_CORPUS && SKIP_REASON }, () => {
  const surprises: string[] = [];
  const interpolated = new Set<number>();
  for (const pair of heldOutPairs()) {
    for (const warning of convertDn1SoundToDn2Detailed(pair.dn1).warnings) {
      if (warning.kind === "interpolated") interpolated.add(warning.value);
      else surprises.push(`${pair.label}: ${warning.kind} ${warning.detail}`);
    }
  }
  assert.deepEqual(surprises.slice(0, 20), [], `${surprises.length} warnings`);

  // The held-out sounds do exercise the interpolation rule, and the byte-for-byte test
  // above passes, so these five selector values are confirmed rather than guessed.
  assert.deepEqual([...interpolated].sort((a, b) => a - b), [28, 35, 38, 47, 56]);
});

test("converted sounds carry the DN2 object framing and the DN1 name", () => {
  const decoder = new TextDecoder("latin1");
  const readName = (data: Uint8Array) => {
    const raw = data.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
    const end = raw.indexOf(0);
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
  };

  for (const pair of heldOutPairs()) {
    const converted = convertDn1SoundToDn2(pair.dn1);
    assert.ok(hasMagic(converted, 0), `${pair.label}: missing object magic`);
    assert.equal(converted[7], DN2_PROJECT_SOUND_VERSION, `${pair.label}: wrong version`);
    assert.deepEqual(
      [...converted.subarray(DN2_SOUND_SIZE - 4)],
      [0xba, 0xce, 0xf0, 0x0c],
      `${pair.label}: missing object terminator`,
    );
    assert.equal(readName(converted), readName(pair.dn1), `${pair.label}: name changed`);
  }
});

test("name residue after the NUL terminator is cleared, as the DN2 files do", () => {
  const dn1 = new Uint8Array(DN1_SOUND_SIZE);
  dn1.set(OBJECT_MAGIC, 0);
  dn1[7] = 5;
  // "AB\0CD" — DN1 leaves "CD" behind from a previous name; DN2 must not.
  dn1.set([0x41, 0x42, 0x00, 0x43, 0x44], SOUND_NAME_OFFSET);

  const converted = convertDn1SoundToDn2(dn1);
  assert.deepEqual(
    [...converted.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE)],
    [0x41, 0x42, ...new Array<number>(14).fill(0)],
  );
});
