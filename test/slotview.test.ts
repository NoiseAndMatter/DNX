/**
 * How one pattern slot reads, shared by both tools.
 *
 * **Written because there were three copies of this mapping** — the manager once, the expander
 * twice — and two were line for line identical while the third differed deliberately. That is the
 * real cost of a copied view-model: a genuine difference and an accidental one look exactly alike.
 *
 * `slotview.ts` has no DOM, which is what makes these tests possible at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BANK_SIZE, countOccupiedIn, patternSlotView } from "../web/src/slotview.js";
import type { Device } from "../src/librarian/device.js";

/** A device that reports exactly what a test asks it to, and nothing else. */
function fakeDevice(summaries: Record<number, Partial<ReturnType<Device["summarise"]>>>): Device {
  return {
    patternCount: 128,
    summarise: (_image: Uint8Array, index: number) => ({
      name: "",
      occupied: false,
      supported: true,
      version: 1,
      trigCount: 0,
      soundLockCount: 0,
      ...summaries[index],
    }),
  } as unknown as Device;
}

const image = new Uint8Array(0);

test("an occupied slot says what is in it", () => {
  const device = fakeDevice({ 0: { name: "IMAGINE", occupied: true, trigCount: 17, soundLockCount: 4 } });
  const view = patternSlotView(device, image, 0);
  assert.equal(view.id, "A1");
  assert.equal(view.name, "IMAGINE");
  assert.equal(view.detail, "17 trigs · 4 locks");
  assert.equal(view.occupied, true);
});

test("no locks means no lock clause, rather than a zero", () => {
  const device = fakeDevice({ 0: { name: "DREAMS", occupied: true, trigCount: 16 } });
  assert.equal(patternSlotView(device, image, 0).detail, "16 trigs");
});

test("an empty slot says empty, and an unnamed one gets a placeholder", () => {
  const device = fakeDevice({ 5: { occupied: false } });
  const view = patternSlotView(device, image, 5);
  assert.equal(view.detail, "empty");
  assert.equal(view.name, "—", "an empty name must not render as nothing at all");
});

test("a record we cannot read never looks like an empty one", () => {
  // The distinction this whole view-model exists to protect: "there is something here I cannot
  // read" and "there is nothing here" must never render alike, because one of them is somebody's
  // work and the tool is about not destroying it.
  const device = fakeDevice({ 9: { supported: false, version: 7, occupied: true, trigCount: 40 } });
  const view = patternSlotView(device, image, 9);
  assert.equal(view.detail, "unreadable version");
  assert.equal(view.name, "v7", "the version is the one useful thing we can still say");
  assert.equal(view.supported, false);
});

test("live patterns override the record, which is the expander's source grid", () => {
  // A pattern the expansion plan will not carry reads as empty even though the DN1 record has
  // trigs in it. The only deliberate difference between the two grids, and now the only argument.
  const device = fakeDevice({
    0: { name: "KEPT", occupied: true, trigCount: 12 },
    1: { name: "DROPPED", occupied: true, trigCount: 99 },
  });
  const live = new Set([0]);

  assert.equal(patternSlotView(device, image, 0, live).occupied, true);
  assert.equal(patternSlotView(device, image, 0, live).detail, "12 trigs");

  const dropped = patternSlotView(device, image, 1, live);
  assert.equal(dropped.occupied, false, "not live means it reads as empty");
  assert.equal(dropped.detail, "empty");
  assert.equal(dropped.name, "DROPPED", "the name still shows — it is the occupancy that changes");
});

test("a bank counts only what it holds", () => {
  const device = fakeDevice({ 0: { occupied: true }, 3: { occupied: true }, 16: { occupied: true } });
  assert.equal(countOccupiedIn(0, device, image), 2, "the next bank's slot must not be counted");
  assert.equal(countOccupiedIn(1, device, image), 1);
  assert.equal(countOccupiedIn(2, device, image), 0);
});

test("counting follows the live set when given one", () => {
  const device = fakeDevice({ 0: { occupied: true }, 1: { occupied: true } });
  assert.equal(countOccupiedIn(0, device, image, new Set([1])), 1);
});

test("the last bank stops at the device's pattern count", () => {
  // A device whose count is not a multiple of the bank size has a short last bank, and counting
  // past the end reads records that are not there.
  const device = { ...fakeDevice({ 126: { occupied: true }, 127: { occupied: true } }), patternCount: 127 } as Device;
  assert.equal(countOccupiedIn(7, device, image), 1, "slot 127 is past the end and must not count");
});

test("a bank is sixteen slots on both families", () => {
  assert.equal(BANK_SIZE, 16);
});
