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
  FM_TONE_PLOCKS,
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
  assert.equal(machinePlock("MULTI-MODE", 75)!.name, "RESO");
  assert.equal(machinePlock("COMB-", 75)!.name, "FDBK");
  assert.equal(machinePlock("FM DRUM", 75), undefined, "an uncaptured machine must not resolve");
  assert.ok(UNCAPTURED_MACHINES.includes("FM DRUM"));
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
