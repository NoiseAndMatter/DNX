/**
 * DN1 -> DN2 conversion, validated against Elektron's own conversions.
 *
 * Nine DN1 projects sit beside the DN2 projects Elektron's importer produced from them. By
 * using Elektron's output as the *template* as well as the expected result, every byte we
 * do not write stays identical by construction, so any difference is a field we write
 * differently. That makes the byte diff a precise instrument rather than a wall of noise.
 *
 * Two regions are deliberately exempt from byte comparison, because Elektron's own output
 * is not canonical there:
 *
 *  - **Unused trigger slots.** The importer leaves uncleared residue — fragments of earlier
 *    content — beyond the slots it wrote. A natively empty DN2 pattern is 0xFF throughout,
 *    which is what we write.
 *  - **Unused parameter-lock records.** Same story: a mixture of 0xFF and 0x00 depending on
 *    what previously occupied the record. Since an unused record is identified by its 0xFF
 *    parameter id, the remaining bytes are inert — and *only* those records are exempt. The
 *    used ones are compared in full, which is what catches a wrong value in a real lock.
 *
 * Those regions are covered by reading the result back instead: every trig, note and sound
 * lock must agree with the DN1 source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { DN2_LAYOUT, kitRecord, patternRecord } from "../src/project/dn2image.js";
import {
  checkDn2PatternRecord,
  PATTERN,
  readDn2PatternRecord,
  readLockTable,
  TRACK,
} from "../src/project/dn2pattern.js";
import {
  patternRecord as dn1PatternRecord,
  readLockTable as dn1ReadLockTable,
  readPattern,
  readProjectName,
} from "../src/project/dn1.js";
import { isLockSet, lockCoarse, lockFine } from "../src/project/lockvalue.js";
import { convertProject } from "../src/expand/convert.js";
import { knownParameterIds, knownTrigConditions } from "../src/expand/translate.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const PAIRS: [string, string][] = [
  ["002 MORNING_JAM", "MORNING_JAM"],
  ["043 GLITCH_EXPLORE", "006 GLITCH_EXPLORE"],
  ["048 ORION_MIDI_TEST", "007 ORION_MIDI_TEST"],
  ["049 JAM", "008 JAM"],
  ["050 JAGGED", "009 JAGGED"],
  ["051 ODD XS", "010 ODD XS"],
  ["052 JAGGED_PLAY", "011 JAGGED_PLAY"],
  ["053 TECNO_EXP", "012 TECNO_EXP"],
  ["031 DROWSY_WALK", "013 DROWSY_WALK"],
];

const skip = NO_CORPUS && SKIP_REASON;

function image(path: string): Uint8Array {
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

function pair(dn1: string, dn2: string) {
  const source = image(`${CORPUS}01_DN1/01_Projects/${dn1}.dnprj`);
  const elektron = image(`${CORPUS}02_DN2/01_Projects/${dn2}.dn2prj`);
  return { source, elektron, ...convertProject(source, elektron) };
}

/**
 * True when a byte sits in a region whose content is residue rather than data.
 *
 * **The lock table is exempt one record at a time, not wholesale.** It used to be excluded as a
 * block, on the reasoning that unused records hold residue — and it does not follow that the used
 * ones do. That over-broad exemption hid a real bug for months: the two bytes of every lock slot
 * were written swapped, so a locked AMP PAN played hard left, and 15,569 wrong bytes across this
 * corpus sat inside the allowance. Now a record is skipped only when *Elektron's* copy of it is
 * unused, which leaves all 392 used records compared byte for byte.
 *
 * Trigger slots stay exempt as a block: there the residue really is unbounded, and the reading
 * test below covers every trig, note and sound lock independently.
 */
function isResidue(offset: number, elektron: Uint8Array): boolean {
  if (offset < DN2_LAYOUT.headerSize || offset >= DN2_LAYOUT.kitBase) return false;
  const within = (offset - DN2_LAYOUT.headerSize) % DN2_LAYOUT.patternSize;
  if (within >= PATTERN.trigOffset && within < PATTERN.lockOffset) return true;
  if (within < PATTERN.lockOffset || within >= PATTERN.metaOffset) return false;

  // Inside the lock table: find the record this byte belongs to and ask whether Elektron uses it.
  const recordStart = offset - ((within - PATTERN.lockOffset) % PATTERN.lockSize);
  return elektron[recordStart] === 0xff && elektron[recordStart + 1] === 0xff;
}

/**
 * True when the only difference is the odd-step parity bit on a step with no trig.
 *
 * The importer writes that bit per 16-step page, and only on pages that contain a trig
 * (plus page 0). We write it on every odd step. It affects 146 bytes across the whole
 * corpus, all in `049 JAM` track 3 where trigs sit only at steps 50-62, so pages 1 and 2
 * stay zero.
 *
 * Tolerated rather than reproduced: `STEP_FLAG.oddStep` is documented as UNKNOWN and is not
 * needed to decode anything, the difference never touches a step that carries a trig, and
 * Elektron's own files disagree with each other about it. Chasing an exact match on a bit
 * whose meaning nobody knows would be precision without accuracy.
 */
function isParityOnly(offset: number, ours: number, theirs: number): boolean {
  if (offset < DN2_LAYOUT.headerSize || offset >= DN2_LAYOUT.kitBase) return false;
  const within = (offset - DN2_LAYOUT.headerSize) % DN2_LAYOUT.patternSize;
  if (within < 0x0004 || within >= 0x4a34) return false;
  const inTrack = (within - 0x0004) % 1187;
  // Step flag words are 128 u16be at the head of the track record; parity is the low byte.
  if (inTrack >= 0x100 || inTrack % 2 === 0) return false;
  return (ours ^ theirs) === 0x10;
}

test("translation tables cover what the corpus exercises", () => {
  assert.equal(knownParameterIds().length, 58);
  assert.equal(knownTrigConditions().length, 35);
  // Non-monotonic on purpose: no arithmetic rule fits, so a table is required.
  assert.ok(knownParameterIds().includes(67));
});

/**
 * True when the difference is Elektron's importer rescaling a lock value we carry verbatim.
 *
 * Six bytes across the whole corpus, all of them the **coarse** half of a lock slot, all on two
 * parameter ids: `17 -> 25` and `43 -> 51` on id 14 (MOD 2 DEST), `71 -> 89` on the same id, and
 * `1 -> 0` on id 73. `dn2pattern.ts` records the same four value changes from the other
 * direction, comparing Elektron's DN1 and DN2 originals — so this is the importer adjusting a
 * parameter whose range moved between the families, not a conversion error.
 *
 * We keep the DN1's value, which the lock-slot test asserts against the source directly. Listed
 * by value pair rather than by offset so that a *seventh* one — a case the corpus has not shown
 * us — fails the test instead of quietly joining the allowance.
 */
const IMPORTER_RESCALES = new Set(["14:17:25", "14:43:51", "14:71:89", "73:1:0"]);

function isImporterRescale(offset: number, ours: number, theirs: number, elektron: Uint8Array): boolean {
  if (offset < DN2_LAYOUT.headerSize || offset >= DN2_LAYOUT.kitBase) return false;
  const within = (offset - DN2_LAYOUT.headerSize) % DN2_LAYOUT.patternSize;
  if (within < PATTERN.lockOffset || within >= PATTERN.metaOffset) return false;

  const inRecord = (within - PATTERN.lockOffset) % PATTERN.lockSize;
  // The coarse byte of a value slot: the header is two bytes, then coarse/fine pairs.
  if (inRecord < 2 || inRecord % 2 !== 0) return false;
  const parameter = elektron[offset - inRecord]!;
  return IMPORTER_RESCALES.has(`${parameter}:${ours}:${theirs}`);
}

test("conversion is byte-identical outside the residue regions", { skip }, () => {
  for (const [dn1, dn2] of PAIRS) {
    const { image: ours, elektron } = pair(dn1, dn2);
    assert.equal(ours.length, elektron.length, `${dn1}: image size changed`);

    let differing = 0;
    let parityOnly = 0;
    let rescaled = 0;
    let firstAt = -1;
    for (let i = 0; i < ours.length; i++) {
      if (ours[i] === elektron[i] || isResidue(i, elektron)) continue;
      if (isParityOnly(i, ours[i]!, elektron[i]!)) {
        parityOnly++;
        continue;
      }
      if (isImporterRescale(i, ours[i]!, elektron[i]!, elektron)) {
        rescaled++;
        continue;
      }
      differing++;
      if (firstAt < 0) firstAt = i;
    }
    assert.ok(rescaled <= 4, `${dn1}: importer rescalings grew to ${rescaled}`);
    assert.equal(
      differing,
      0,
      `${dn1}: ${differing} bytes differ from Elektron's conversion, first at 0x${firstAt.toString(16)}`,
    );
    // Bounded, so a regression that widens this shows up rather than hiding in the allowance.
    assert.ok(parityOnly <= 146, `${dn1}: parity-only differences grew to ${parityOnly}`);
  }
});

/**
 * Converting with a NEUTRAL template and comparing against Elektron's output.
 *
 * The byte-diff test above uses Elektron's own conversion as the template, which makes any
 * field we never write match by construction — it is structurally blind to "we forgot to
 * write this". That blindness shipped a real bug: per-track lengths were written correctly
 * but the scale mode was not, so the device ignored them and used the template's master
 * length. A 32-step bass line played as 16 — audibly wrong, while every byte we believed we
 * owned was correct.
 *
 * Using EMPTY.dn2prj as the template exposes that whole class of bug, because its metadata
 * differs from any real project's. A field we fail to write shows up as EMPTY's value rather
 * than Elektron's.
 */
test("pattern metadata is written, not inherited from the template", { skip }, () => {
  const template = image(`${CORPUS}02_DN2/01_Projects/EMPTY.dn2prj`);
  const u16 = (buffer: Uint8Array, at: number) => (buffer[at]! << 8) | buffer[at + 1]!;
  let compared = 0;

  for (const [dn1, dn2] of PAIRS) {
    const source = image(`${CORPUS}01_DN1/01_Projects/${dn1}.dnprj`);
    const elektron = image(`${CORPUS}02_DN2/01_Projects/${dn2}.dn2prj`);
    const { image: ours } = convertProject(source, template);

    for (let p = 0; p < 128; p++) {
      const mine = patternRecord(ours, p);
      const theirs = patternRecord(elektron, p);

      assert.equal(
        u16(mine, PATTERN.lengthOffset),
        u16(theirs, PATTERN.lengthOffset),
        `${dn1} pattern ${p}: master length`,
      );
      assert.equal(
        u16(mine, PATTERN.changeLengthOffset),
        u16(theirs, PATTERN.changeLengthOffset),
        `${dn1} pattern ${p}: change length`,
      );
      assert.equal(
        mine[PATTERN.scaleModeOffset],
        theirs[PATTERN.scaleModeOffset],
        `${dn1} pattern ${p}: scale mode decides whether per-track lengths are honoured`,
      );
      assert.equal(
        mine[PATTERN.speedOffset],
        theirs[PATTERN.speedOffset],
        `${dn1} pattern ${p}: pattern speed`,
      );

      for (let t = 0; t < 8; t++) {
        const at = PATTERN.trackOffset + t * TRACK.size + TRACK.settingsOffset;
        assert.equal(
          mine[at + TRACK.settingsLengthOffset],
          theirs[at + TRACK.settingsLengthOffset],
          `${dn1} pattern ${p} track ${t + 1}: length`,
        );
        assert.equal(
          mine[at + TRACK.settingsSpeedOffset],
          theirs[at + TRACK.settingsSpeedOffset],
          `${dn1} pattern ${p} track ${t + 1}: speed`,
        );
      }
      compared++;
    }
  }
  assert.equal(compared, PAIRS.length * 128);
});

/**
 * A budget per region, measured against Elektron's output with a NEUTRAL template.
 *
 * Anything we do not write inherits the template, so these numbers are the honest size of
 * what is still unmapped. They are asserted as ceilings rather than zeroes because several
 * regions are genuinely not transferred yet — the point is that they cannot silently grow,
 * and that a region we have fixed cannot regress.
 *
 * Budgets are bytes per project, averaged over the pairs, with a little headroom.
 */
test("unwritten regions stay within their known budget", { skip }, () => {
  const template = image(`${CORPUS}02_DN2/01_Projects/EMPTY.dn2prj`);
  const budgets: Record<string, number> = {
    "track settings": 20, // was 5,158 before the field map
    "kit FX region": 200, // was 1,016, then 409 before the rescaled field was placed
    "kit header": 20, // was 48, before track levels were transferred
    "pattern metadata": 5, // was 135: mostly one constant the device writes as 1
    "kit MIDI records": 20, // was 10,112: sixteen inherited names plus untransferred config
  };
  const seen: Record<string, number> = {};
  const bump = (k: string, n: number) => (seen[k] = (seen[k] ?? 0) + n);
  const diff = (a: Uint8Array, b: Uint8Array, at: number, len: number) => {
    let n = 0;
    for (let i = 0; i < len; i++) if (a[at + i] !== b[at + i]) n++;
    return n;
  };

  for (const [dn1, dn2] of PAIRS) {
    const source = image(`${CORPUS}01_DN1/01_Projects/${dn1}.dnprj`);
    const elektron = image(`${CORPUS}02_DN2/01_Projects/${dn2}.dn2prj`);
    const { image: ours } = convertProject(source, template);

    for (let p = 0; p < 128; p++) {
      const mine = patternRecord(ours, p);
      const theirs = patternRecord(elektron, p);
      for (let t = 0; t < 8; t++) {
        const at = PATTERN.trackOffset + t * TRACK.size + TRACK.settingsOffset;
        bump("track settings", diff(mine, theirs, at, TRACK.settingsSize));
      }
      bump("pattern metadata", diff(mine, theirs, PATTERN.metaOffset, 44));

      const myKit = kitRecord(ours, p);
      const theirKit = kitRecord(elektron, p);
      bump("kit FX region", diff(myKit, theirKit, 5804, 160));
      bump("kit header", diff(myKit, theirKit, 0, 60));
      // All sixteen records, not just the four the importer fills: the other twelve carry
      // names the template would otherwise leak through.
      for (let m = 0; m < 16; m++) bump("kit MIDI records", diff(myKit, theirKit, 5964 + m * 268, 268));
    }
  }

  for (const [region, budget] of Object.entries(budgets)) {
    const perProject = Math.round((seen[region] ?? 0) / PAIRS.length);
    assert.ok(
      perProject <= budget,
      `${region}: ${perProject} bytes/project differ from Elektron, budget is ${budget}`,
    );
  }
});

test("every trig, note and sound lock survives the conversion", { skip }, () => {
  let patterns = 0;
  let trigs = 0;
  let locks = 0;

  for (const [dn1, dn2] of PAIRS) {
    const { image: ours, source } = pair(dn1, dn2);

    for (let p = 0; p < 128; p++) {
      const expected = readPattern(source, p);
      const actual = readDn2PatternRecord(patternRecord(ours, p), p, 0x00f0);
      patterns++;

      for (const track of expected.tracks) {
        const got = actual.tracks[track.index]!;
        assert.deepEqual(
          got.trigs.map((t) => t.step),
          track.trigs.map((t) => t.step),
          `${dn1} pattern ${p} track ${track.index}: trig steps differ`,
        );

        for (let i = 0; i < track.trigs.length; i++) {
          const want = track.trigs[i]!;
          const have = got.trigs[i]!;
          trigs++;
          if (want.hasNote) {
            assert.equal(have.note, want.note, `${dn1} p${p} t${track.index} s${want.step}: note`);
          }
          if (want.soundLock !== undefined) {
            locks++;
            assert.equal(
              have.soundLock,
              want.soundLock,
              `${dn1} p${p} t${track.index} s${want.step}: sound lock`,
            );
          }
        }
      }
    }
  }

  assert.equal(patterns, PAIRS.length * 128);
  assert.ok(trigs > 7_000, `expected the corpus to exercise thousands of trigs, saw ${trigs}`);
  assert.ok(locks > 2_000, `expected thousands of sound locks, saw ${locks}`);
});

/**
 * A lock slot is a coarse byte then a fine one, and conversion must not swap them.
 *
 * The byte diff above covers this now, but only as one term in a total. This asserts the thing
 * itself, in the vocabulary of the format, because the failure it guards against is not subtle in
 * its effect and was invisible in its cause: reading the DN1 pair little-endian and writing it
 * big-endian moved every value into the fine byte and left coarse at zero. For AMP PAN — bipolar,
 * centred at 64 — that is hard left on every pan-locked trig.
 *
 * Compared as a sorted multiset of `track:step:coarse.fine`, so it does not depend on records
 * keeping their order or on the parameter-id translation. Three values legitimately differ:
 * Elektron rescales a parameter whose range changed, and the DN1 side is the one being read here,
 * so the comparison is against the *source*, not against Elektron's output.
 */
test("parameter-lock values keep their coarse and fine bytes in order", { skip }, () => {
  let slots = 0;

  for (const [dn1, dn2] of PAIRS) {
    const { image: ours, source } = pair(dn1, dn2);

    for (let p = 0; p < 128; p++) {
      const want = dn1LockSlots(source, p);
      const have = dn2LockSlots(ours, p);
      slots += want.length;
      assert.deepEqual(have, want, `${dn1} pattern ${p}: lock slot values differ from the DN1`);
    }
  }

  assert.ok(slots > 5_000, `expected the corpus to exercise thousands of lock slots, saw ${slots}`);
});

function dn1LockSlots(image: Uint8Array, pattern: number): string[] {
  return describeSlots(
    dn1ReadLockTable(dn1PatternRecord(image, pattern)).map((r) => ({ track: r.track, values: r.values })),
  );
}

function dn2LockSlots(image: Uint8Array, pattern: number): string[] {
  return describeSlots(
    readLockTable(patternRecord(image, pattern)).map((r) => ({ track: r.track, values: r.values })),
  );
}

/** `track:step:coarse.fine` for every set slot, sorted — a multiset that ignores record order. */
function describeSlots(records: { track: number; values: number[] }[]): string[] {
  const out: string[] = [];
  for (const record of records) {
    record.values.forEach((raw, step) => {
      if (!isLockSet(raw)) return;
      out.push(`${record.track}:${step}:${lockCoarse(raw)}.${lockFine(raw)}`);
    });
  }
  return out.sort();
}

test("converted patterns pass the DN2 structural check", { skip }, () => {
  for (const [dn1, dn2] of PAIRS) {
    const { image: ours } = pair(dn1, dn2);
    for (let p = 0; p < 128; p++) {
      const result = checkDn2PatternRecord(patternRecord(ours, p));
      assert.ok(result.ok, `${dn1} pattern ${p}: ${result.problems.slice(0, 3).join("; ")}`);
    }
  }
});

test("the corpus converts with nothing unmapped", { skip }, () => {
  // Interpolated selector values are expected: the sound mapping fills a gap when the
  // neighbouring deltas agree, and that produced byte-exact output on held-out projects.
  // What must never appear is an unmapped parameter, condition or selector, since those
  // would mean writing a guess to hardware.
  for (const [dn1, dn2] of PAIRS) {
    const { report } = pair(dn1, dn2);
    const unmapped = report.warnings.filter((w) => !w.message.includes("interpolated"));
    assert.deepEqual(
      unmapped.map((w) => w.message),
      [],
      `${dn1}: conversion could not map some fields`,
    );
    assert.equal(report.patternsWritten, 128);
  }
});

test("the project name carries across", { skip }, () => {
  for (const [dn1, dn2] of PAIRS) {
    const { image: ours, source } = pair(dn1, dn2);
    assert.equal(readProjectName(ours), readProjectName(source), dn1);
  }
});

test("inputs are never modified", { skip }, () => {
  const source = image(`${CORPUS}01_DN1/01_Projects/002 MORNING_JAM.dnprj`);
  const template = image(`${CORPUS}02_DN2/01_Projects/MORNING_JAM.dn2prj`);
  const sourceCopy = Uint8Array.from(source);
  const templateCopy = Uint8Array.from(template);

  convertProject(source, template);

  assert.deepEqual(source, sourceCopy, "DN1 image was mutated");
  assert.deepEqual(template, templateCopy, "template was mutated");
});

test("a mis-sized image is rejected rather than producing garbage", { skip }, () => {
  const source = image(`${CORPUS}01_DN1/01_Projects/002 MORNING_JAM.dnprj`);
  const template = image(`${CORPUS}02_DN2/01_Projects/MORNING_JAM.dn2prj`);
  assert.throws(() => convertProject(new Uint8Array(10), template), /DN1 image must be/);
  assert.throws(() => convertProject(source, new Uint8Array(10)), /DN2 template must be/);
});

/**
 * MIDI track configuration must survive the conversion.
 *
 * `048 ORION_MIDI_TEST` exists precisely because someone sat down and configured MIDI tracks,
 * so it is the one project in the corpus where this can fail visibly. Before the field map
 * these records were not written at all and the converted project inherited the template's
 * channels and CC assignments.
 */
test("MIDI track configuration lands on DN2 tracks 5-8", { skip }, () => {
  const template = image(`${CORPUS}02_DN2/01_Projects/EMPTY.dn2prj`);
  const source = image(`${CORPUS}01_DN1/01_Projects/048 ORION_MIDI_TEST.dnprj`);
  const elektron = image(`${CORPUS}02_DN2/01_Projects/007 ORION_MIDI_TEST.dn2prj`);
  const { image: ours } = convertProject(source, template);

  const MIDI_BASE = 5_964;
  const RECORD = 268;
  let differing = 0;
  let configured = 0;

  for (let p = 0; p < 128; p++) {
    const mine = kitRecord(ours, p);
    const theirs = kitRecord(elektron, p);
    const fromTemplate = kitRecord(template, p);

    for (let record = 0; record < 16; record++) {
      const at = MIDI_BASE + record * RECORD;
      for (let i = 0; i < RECORD; i++) {
        if (mine[at + i] !== theirs[at + i]) differing++;
        // Something the template got wrong and we now get right — proof the transfer does
        // real work rather than agreeing with the template by luck.
        if (theirs[at + i] !== fromTemplate[at + i] && mine[at + i] === theirs[at + i]) configured++;
      }
    }
  }

  assert.ok(configured > 1_000, `expected the transfer to correct the template, corrected ${configured} bytes`);
  assert.ok(differing <= 5, `${differing} MIDI-record bytes differ from Elektron across 128 kits`);
});
