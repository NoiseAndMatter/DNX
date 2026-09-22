/**
 * What a whole-project read tells you, in words.
 *
 * `readReportRows` is eighty lines of derivation that used to sit inside a `card()` call in
 * `probe/main.ts`, which meant **the only way to see what a report says about a partial read was to
 * perform a partial read on real hardware.** Seven of its eight conditional rows had therefore never
 * been rendered by anybody except a device having a bad night.
 *
 * Nearly every sentence in it is something the hardware taught us rather than something the format
 * says — a Digitone 1 answering four sounds when asked for 128, DIN throttling to 3 kB/s, an object
 * number the device does not echo, a checksum that fails once and never again. Those are the
 * sentences most worth pinning down, because they are the ones a reader will act on at two in the
 * morning and the ones nothing else in the codebase would notice going wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportRows } from "../web/src/probe/report.js";
import { type ReadReport, type StepResult } from "@noiseandmatter/dnx-core/device/dumpreader.js";
import { type ReadStep } from "@noiseandmatter/dnx-core/device/readplan.js";
import { RequestCode } from "@noiseandmatter/dnx-core/device/dumprequest.js";

function step(label: string, over: Partial<ReadStep> = {}): ReadStep {
  return {
    code: RequestCode.Pattern, objNr: 0, expect: 0x51, label, payloadBytes: 1024, ...over,
  };
}

function result(label: string, over: Partial<StepResult> = {}): StepResult {
  return { step: step(label), status: "ok", payloadBytes: 1024, ...over };
}

/** A clean read of `n` objects. Every count zero, because that is what a good run looks like. */
function report(over: Partial<ReadReport> = {}): ReadReport {
  const results = over.results ?? [result("Pattern A1"), result("Pattern A2")];
  return {
    results,
    ok: results.length,
    silent: 0,
    bytes: 12_345,
    late: 0,
    foreign: 0,
    objNrMismatches: 0,
    sizeMismatches: 0,
    badChecksums: 0,
    stopped: false,
    skipped: 0,
    gaveUpOn: [],
    elapsedMs: 2000,
    bytesPerSecond: 6172,
    ...over,
  };
}

/** The rows as a lookup, since order is asserted separately from content. */
const byTitle = (rows: [string, string][]) => Object.fromEntries(rows);

/* ---- the clean case, which is most of them --------------------------------------------- */

test("a clean read prints three rows and no others", () => {
  /*
   * **The whole design of this report.** Nine categories with zeros in seven of them buries the two
   * that matter, so every row below the first three appears only when it happened. If this ever
   * grows a fourth unconditional row, that was a decision and it should be a visible one.
   */
  const rows = readReportRows(report(), 2000);
  assert.deepEqual(rows.map(([k]) => k), ["Answered", "Bytes", "Took"]);
  assert.equal(byTitle(rows)["Answered"], "2 of 2");
  assert.equal(byTitle(rows)["Bytes"], "12,345");
  assert.equal(byTitle(rows)["Took"], "2.0s — 6 kB/s");
});

test("a rate is printed only when something arrived", () => {
  // Zero bytes per second is not "0 kB/s", it is nothing to report. A rate of zero beside a failed
  // read reads as a measurement of the transport, which it is not.
  const rows = readReportRows(report({ bytesPerSecond: 0, bytes: 0 }), 400);
  assert.equal(byTitle(rows)["Took"], "0.4s");
});

test("the elapsed time is the caller's, not the reader's", () => {
  /*
   * The reader times its own run; the caller times the plan, the sends and the draining. The number
   * a person compares against a stopwatch is the caller's, which is why it is a parameter at all —
   * and passing `report.elapsedMs` instead would silently under-report every read.
   */
  const rows = readReportRows(report({ elapsedMs: 2000 }), 9500);
  assert.match(byTitle(rows)["Took"]!, /^9\.5s/);
});

/* ---- the rows that only a bad night produces ------------------------------------------- */

test("skipped objects are reported as the device's answer, not as failures", () => {
  /*
   * **The one piece of tone worth protecting.** A Digitone 1 asked for 128 sounds gives four.
   * Without this line that reads as 124 things going wrong rather than as a device with four
   * sounds, and the instruction that follows is the actual next step for the person reading it.
   */
  const rows = byTitle(readReportRows(
    report({ skipped: 124, gaveUpOn: [{ code: RequestCode.Sound, after: 3 }] }), 1000));
  const said = rows["Not asked for"]!;
  assert.match(said, /^124 — the device went quiet on 0x63 after 3 in a row/);
  assert.match(said, /SETTINGS > SYSEX DUMP/, "it must say where the sound pool comes from instead");
  assert.doesNotMatch(said, /fail|error|wrong/i, "this is an answer, not a failure");
});

test("a silent object names the first one, so there is somewhere to look", () => {
  const results = [result("Pattern A1"), result("Sound 42", { status: "silent" }),
                   result("Sound 43", { status: "silent" })];
  const rows = byTitle(readReportRows(report({ results, ok: 1, silent: 2 }), 1000));
  assert.match(rows["No answer"]!, /^2 object\(s\), first at Sound 42/);
  // Both explanations are offered because both have been true on this hardware, and guessing
  // between them from a count is exactly what a reader should not be asked to do.
  assert.match(rows["No answer"]!, /device sends nothing for that slot, or the transport is too slow/);
});

test("a late answer points at the cable, with the manual reference", () => {
  /*
   * Non-zero here means the timeouts are too tight for this transport — most likely DIN, which the
   * manual says throttles a transfer to roughly 3 kB/s. The section number is in the string because
   * the person reading it is holding the instrument and can go and check.
   */
  const rows = byTitle(readReportRows(report({ late: 5 }), 1000));
  assert.match(rows["Answered late"]!, /USB\+MIDI, switch it to USB/);
  assert.match(rows["Answered late"]!, /3 kB\/s \(manual §13\.4\.2\)/);
});

test("an object number the device does not echo changes how a rebuild must work", () => {
  // Expected to be zero. When it is not, reassembly has to go by send order rather than by the
  // number in the message — which is a different program, not a warning.
  const rows = byTitle(readReportRows(report({ objNrMismatches: 3 }), 1000));
  assert.match(rows["Object number differed"]!, /must go by send order rather than by the number/);
});

test("an unexpected size names an example, because the count alone is not actionable", () => {
  const results = [
    result("Pattern A1"),
    result("Pattern A2", { payloadBytes: 999, step: step("Pattern A2", { payloadBytes: 1024 }) }),
  ];
  const rows = byTitle(readReportRows(report({ results, sizeMismatches: 1 }), 1000));
  assert.equal(rows["Unexpected size"], "1 — e.g. Pattern A2: 999 bytes, expected 1024");
});

test("bad checksums are called transit corruption and list what to read again", () => {
  /*
   * **The failure the hardware found.** One Digitone II pattern arrived with a bad checksum and
   * 6,433 wrong bytes in a 248-message dump, and came back perfectly the next night. Rare, silent,
   * and fixed by asking again — so the row has to say *not a format problem*, or the next person
   * spends an evening in a hex editor.
   */
  const results = [result("Pattern A1"), result("Pattern G11", { checksumOk: false })];
  const rows = byTitle(readReportRows(report({ results, badChecksums: 1 }), 1000));
  assert.match(rows["Bad checksums"]!, /corrupt in transit, not a format problem/);
  assert.match(rows["Bad checksums"]!, /Pattern G11/, "the steps to retry must be named");
});

test("a long retry list is truncated with a count, not silently cut", () => {
  const results = Array.from({ length: 9 },
    (_, i) => result(`Pattern A${i + 1}`, { checksumOk: false }));
  const rows = byTitle(readReportRows(report({ results, badChecksums: 9 }), 1000));
  assert.match(rows["Bad checksums"]!, /Pattern A6, \+3 more/,
    "six named and the remainder counted — a bare truncation would hide how much is wrong");
});

test("silent steps and bad checksums are both worth reading again", () => {
  // `stepsToRetry` collects both, so a read with one of each lists two steps. The row is the only
  // place a person is told what to do next, and leaving out the silent ones would send them back
  // for half of it.
  const results = [result("Pattern A1", { status: "silent" }),
                   result("Pattern A2", { checksumOk: false })];
  const rows = byTitle(readReportRows(report({ results, silent: 1, badChecksums: 1 }), 1000));
  assert.match(rows["Bad checksums"]!, /Pattern A1, Pattern A2/);
});

test("stopping is recorded as your decision", () => {
  const rows = byTitle(readReportRows(report({ stopped: true }), 1000));
  assert.equal(rows["Stopped"], "by you, before the plan finished");
});

test("foreign traffic is counted and dismissed in one line", () => {
  const rows = byTitle(readReportRows(report({ foreign: 12 }), 1000));
  assert.equal(rows["Other traffic"], "12 message(s), ignored");
});

/* ---- everything at once ---------------------------------------------------------------- */

test("a thoroughly bad read reports every finding, in a fixed order", () => {
  /*
   * The order is the reading order and it is deliberate: what you got, then what you were not given,
   * then what went wrong with what you were. Asserted because a row appended in the wrong place is
   * invisible in review and obvious on the page.
   */
  const results = [
    result("Pattern A1"),
    result("Sound 42", { status: "silent" }),
    result("Pattern A2", { checksumOk: false }),
  ];
  const rows = readReportRows(report({
    results, ok: 1, silent: 1, late: 2, foreign: 4, objNrMismatches: 1, sizeMismatches: 1,
    badChecksums: 1, stopped: true, skipped: 7,
    gaveUpOn: [{ code: RequestCode.Sound, after: 3 }],
  }), 1000);
  assert.deepEqual(rows.map(([k]) => k), [
    "Answered", "Bytes", "Took", "Stopped", "Not asked for", "No answer", "Answered late",
    "Object number differed", "Unexpected size", "Bad checksums", "Other traffic",
  ]);
});
