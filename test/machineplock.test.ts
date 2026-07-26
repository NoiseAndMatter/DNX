/**
 * Machine-relative lock ids.
 *
 * The point of these tests is the collision: the same id naming different parameters on
 * different machines is the finding, so it is asserted rather than merely documented. If a
 * future capture makes the ids absolute after all, this fails loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  COMB_MINUS_PLOCKS,
  FM_DRUM_PLOCKS,
  FM_TONE_PLOCKS,
  SWARMER_IDS,
  MACHINE_PLOCKS,
  MACHINE_RELATIVE_IDS,
  MULTI_MODE_PLOCKS,
  UNCAPTURED_MACHINES,
  WAVETONE_PLOCKS,
  isMachineRelative,
  machinePlock,
} from "../src/project/machineplock.js";
import { PLOCK_PARAMETERS } from "../src/project/plockparams.js";

test("every shared id between FM TONE and WAVETONE names a different parameter", () => {
  const fm = new Map(FM_TONE_PLOCKS.map((p) => [p.id, p]));
  const wt = new Map(WAVETONE_PLOCKS.map((p) => [p.id, p]));
  const shared = [...fm.keys()].filter((id) => wt.has(id));
  assert.equal(shared.length, 22, "the capture found 22 ids in common");

  for (const id of shared) {
    const a = fm.get(id)!, b = wt.get(id)!;
    if (a.name === undefined || b.name === undefined) continue; // SYN 2 names were not captured
    assert.notEqual(a.name, b.name, `id ${id} means "${a.name}" on both machines`);
  }
});

test("the filter machines collide on exactly two ids", () => {
  const mm = new Map(MULTI_MODE_PLOCKS.map((p) => [p.id, p.name]));
  const cb = new Map(COMB_MINUS_PLOCKS.map((p) => [p.id, p.name]));
  const clash = [...mm.keys()].filter((id) => mm.get(id) !== cb.get(id)).sort((a, b) => a - b);
  assert.deepEqual(clash, [73, 75]);
  assert.equal(mm.get(75), "RESO");
  assert.equal(cb.get(75), "FDBK");
  assert.equal(mm.get(73), "TYPE");
  assert.equal(cb.get(73), "LPF");
});

test("WAVETONE's ids are consecutive, and not in knob order", () => {
  const ids = WAVETONE_PLOCKS.map((p) => p.id).sort((a, b) => a - b);
  assert.equal(ids[0], 33);
  assert.equal(ids[ids.length - 1], 55);
  assert.equal(ids.length, 23, "23 controls");
  for (let i = 1; i < ids.length; i++) assert.equal(ids[i], ids[i - 1]! + 1, "no gaps");

  // SYN page 2's TBL1 takes id 35, between page 1's WAV1 (34) and PD1 (37) -- so an id cannot
  // be derived from a knob position even inside one machine.
  const byId = new Map(WAVETONE_PLOCKS.map((p) => [p.id, p]));
  assert.equal(byId.get(35)!.page, "SYN 2");
  assert.equal(byId.get(34)!.page, "SYN 1");
  assert.equal(byId.get(37)!.page, "SYN 1");
});

test("machine-relative ids never overlap the absolute table", () => {
  for (const p of PLOCK_PARAMETERS) {
    assert.ok(!isMachineRelative(p.id), `absolute id ${p.id} (${p.name}) is inside the machine range`);
  }
  for (const list of Object.values(MACHINE_PLOCKS)) {
    for (const p of list) assert.ok(isMachineRelative(p.id), `machine id ${p.id} is outside the range`);
  }
});

test("resolving an id requires the machine", () => {
  // One id, three meanings, across three filter machines. This is the whole finding in one test.
  assert.equal(machinePlock("MULTI-MODE", 73)!.name, "TYPE");
  assert.equal(machinePlock("COMB-", 73)!.name, "LPF");
  assert.equal(machinePlock("EQUALIZER", 73)!.name, "Q");
  assert.equal(machinePlock("MULTI-MODE", 75)!.name, "RESO");
  assert.equal(machinePlock("COMB-", 75)!.name, "FDBK");
  assert.equal(machinePlock("EQUALIZER", 75)!.name, "GAIN");

  assert.equal(machinePlock("COMB+", 73), undefined, "an uncaptured machine must not resolve");
  assert.ok(UNCAPTURED_MACHINES.includes("COMB+"));
});

test("FM DRUM fills the holes FM TONE left", () => {
  const fm = new Set(FM_TONE_PLOCKS.map((p) => p.id));
  const drum = new Set(FM_DRUM_PLOCKS.map((p) => p.id));
  // 42 and 57..62 are absent from FM TONE and present in FM DRUM: one machine's gap is
  // another's control, which is what makes the SYN range a shared pool rather than a layout.
  for (const id of [42, 57, 58, 59, 60, 61, 62]) {
    assert.ok(!fm.has(id), `FM TONE should not use ${id}`);
    assert.ok(drum.has(id), `FM DRUM should use ${id}`);
  }
  const ids = [...drum].sort((a, b) => a - b);
  assert.equal(ids.length, 30);
  for (let i = 1; i < ids.length; i++) assert.equal(ids[i], ids[i - 1]! + 1, "FM DRUM has no gaps");
});

test("SWARMER's ids are recorded without guessing their knobs", () => {
  assert.deepEqual([...SWARMER_IDS], [33, 34, 35, 36, 37, 38, 39, 40]);
  assert.ok(UNCAPTURED_MACHINES.includes("SWARMER"), "its positions are still unknown");
  assert.equal(MACHINE_PLOCKS["SWARMER"], undefined, "so it has no knob table");
});

test("knob A is 33 and knob B is 34 on every captured SYN machine", () => {
  for (const list of [FM_TONE_PLOCKS, WAVETONE_PLOCKS, FM_DRUM_PLOCKS]) {
    const syn1 = list.filter((p) => p.page === "SYN 1");
    assert.equal(syn1.find((p) => p.knob === "A")!.id, 33);
    assert.equal(syn1.find((p) => p.knob === "B")!.id, 34);
  }
  // ...and knob C already diverges, so the low ids only look positional.
  const c = [FM_TONE_PLOCKS, WAVETONE_PLOCKS, FM_DRUM_PLOCKS]
    .map((l) => l.filter((p) => p.page === "SYN 1").find((p) => p.knob === "C")!.id);
  assert.deepEqual(c, [35, 37, 35]);
});

test("FLTR page 1 and page 2 interleave", () => {
  // 77 is FLTR page 2's DEL, and sits inside FLTR page 1's run of 73..81.
  const page1 = MULTI_MODE_PLOCKS.map((p) => p.id).sort((a, b) => a - b);
  assert.ok(!page1.includes(77), "77 belongs to FLTR page 2");
  assert.ok(page1.includes(76) && page1.includes(78), "and it sits between two page 1 ids");
  assert.ok(PLOCK_PARAMETERS.some((p) => p.id === 77 && p.page === "FLTR 2"));
});

test("FM TONE's SYN 2 is two operator envelopes, distinguished by position", () => {
  const syn2 = FM_TONE_PLOCKS.filter((p) => p.page === "SYN 2");
  assert.equal(syn2.length, 8);
  // The device repeats the same four labels, so the operator has to come from the knob half.
  assert.deepEqual(syn2.map((p) => p.name), [
    "A ATK", "A DEC", "A END", "A LEV", "B ATK", "B DEC", "B END", "B LEV",
  ]);
  const stems = syn2.map((p) => p.name!.split(" ")[1]);
  assert.deepEqual(stems.slice(0, 4), stems.slice(4), "both halves carry the same four stems");
});
