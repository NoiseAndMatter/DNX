import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessage, parseMessage } from "../src/sysex/container.js";
import { ProductId } from "../src/sysex/devices.js";
import { DN1_LAYOUT, DN2_LAYOUT } from "../src/project/dn2image.js";
import {
  WriteCode,
  WriteRefused,
  driftSince,
  dumpWrite,
  looksBlank,
  needsJustification,
  nullRoundTrip,
  recordSize,
  settleMsAfter,
  storageVersion,
  verifyWrite,
  versionOf,
  writeToSlot,
} from "../src/device/dumpwrite.js";

const PATTERN_KIT = DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize;

/**
 * A record with an Elektron object header, so it declares a storage version like a real one.
 *
 * **A patternKit keeps its header in the kit half**, because it is `pattern ++ kit` and only the
 * kit opens with `BEEFBACE`. These tests used to put it at byte 0 — which is exactly why they all
 * passed against a version guard that read byte 0, found nothing on either side, and let every
 * patternKit through. The tests encoded the bug they existed to catch. See `versionOffset`.
 */
function record(size: number, version: number, fill = 0x11): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  const at = size === PATTERN_KIT ? DN2_LAYOUT.patternSize : 0;
  bytes.set([0xbe, 0xef, 0xba, 0xce], at);
  bytes.set(
    [(version >>> 24) & 0xff, (version >>> 16) & 0xff, (version >>> 8) & 0xff, version & 0xff],
    at + 4,
  );
  return bytes;
}

test("a write is addressed to a slot and carries the whole record", () => {
  const payload = record(PATTERN_KIT, 3);
  const message = parseMessage(
    dumpWrite(ProductId.DN2, {
      code: WriteCode.PatternKit,
      objNr: 127,
      payload,
      witness: record(PATTERN_KIT, 3),
    }),
  );

  assert.equal(message.productId, ProductId.DN2);
  assert.equal(message.dumpType, 0x50, "a write is a 0x5n — the same message a device sends");
  assert.equal(message.objNr, 127);
  assert.equal(message.payload.length, PATTERN_KIT);
});

test("a payload of the wrong size is refused, not padded or truncated", () => {
  // A short payload is not a partial write to tolerate; it is a different message.
  assert.throws(
    () =>
      dumpWrite(ProductId.DN2, {
        code: WriteCode.PatternKit,
        objNr: 0,
        payload: record(PATTERN_KIT - 1, 3),
        witness: record(PATTERN_KIT, 3),
      }),
    (e: unknown) => e instanceof WriteRefused && /not a partial write/.test(String(e)),
  );
});

test("a storage version the device did not answer with is refused", () => {
  // The corruption this project has spent its life avoiding: a record captured under one firmware
  // written to a device running another.
  assert.throws(
    () =>
      dumpWrite(ProductId.DN2, {
        code: WriteCode.PatternKit,
        objNr: 0,
        payload: record(PATTERN_KIT, 2),
        witness: record(PATTERN_KIT, 3),
      }),
    (e: unknown) => e instanceof WriteRefused && /storage version 2 .* version 3/s.test(String(e)),
  );
});

test("the version check is against the device's own bytes, not our table", () => {
  // A witness is a record the device actually produced. Checking against a firmware table would
  // only test our belief about the firmware.
  const witness = record(PATTERN_KIT, 4);
  assert.doesNotThrow(() =>
    dumpWrite(ProductId.DN2, {
      code: WriteCode.PatternKit,
      objNr: 0,
      payload: record(PATTERN_KIT, 4),
      witness,
    }),
  );
});

test("an unversioned record does not read as a match", () => {
  // No BEEFBACE means no version, and unknown must never pass a version check silently.
  const headerless = new Uint8Array(PATTERN_KIT).fill(0x22);
  assert.equal(storageVersion(headerless), undefined);
  assert.throws(
    () =>
      dumpWrite(ProductId.DN2, {
        code: WriteCode.PatternKit,
        objNr: 0,
        payload: headerless,
        witness: record(PATTERN_KIT, 3),
      }),
    /storage version unknown/,
  );
});

test("an object number outside the 7-bit field is refused", () => {
  assert.throws(
    () =>
      dumpWrite(ProductId.DN2, {
        code: WriteCode.PatternKit,
        objNr: 128,
        payload: record(PATTERN_KIT, 3),
        witness: record(PATTERN_KIT, 3),
      }),
    /7-bit field/,
  );
});

test("ProjectSettings needs a stated reason on either family", () => {
  assert.match(needsJustification(ProductId.DN2, WriteCode.ProjectSettings)!, /global state/);
  assert.match(needsJustification(ProductId.DN1, WriteCode.ProjectSettings)!, /global state/);
});

test("a Digitone 1's sound write needs one, and a Digitone II's does not", () => {
  // The read direction is ambiguous on a DN1 — kit track sound or pool slot — so the write
  // direction is unproven, and an unproven write is not where to find out.
  assert.match(needsJustification(ProductId.DN1, WriteCode.Sound)!, /ambiguous even when reading/);
  assert.equal(needsJustification(ProductId.DN2, WriteCode.Sound), undefined);
});

test("a justified write of a refused code goes through", () => {
  const payload = record(512, 3);
  assert.doesNotThrow(() =>
    dumpWrite(ProductId.DN2, {
      code: WriteCode.ProjectSettings,
      objNr: 0,
      payload,
      witness: record(512, 3),
      allow: "restoring settings read from this same device a minute ago",
    }),
  );
});

test("record sizes are known for every writable code on both families", () => {
  for (const product of [ProductId.DN1, ProductId.DN2]) {
    for (const code of Object.values(WriteCode)) {
      assert.ok(recordSize(product, code)! > 0, `0x${code.toString(16)} on ${product}`);
    }
  }
  assert.equal(recordSize(ProductId.DN2, WriteCode.Pattern), DN2_LAYOUT.patternSize);
  assert.equal(recordSize(ProductId.DN2, WriteCode.Kit), DN2_LAYOUT.kitSize);
});

test("a product whose records we have not measured is refused", () => {
  assert.throws(
    () =>
      dumpWrite(0x14, {
        code: WriteCode.PatternKit,
        objNr: 0,
        payload: record(PATTERN_KIT, 3),
        witness: record(PATTERN_KIT, 3),
      }),
    /no record size recorded/,
  );
});

test("the null round trip sends a captured record back where it came from", () => {
  // The safest possible first write: identical bytes to the same slot. If it works nothing
  // changed; if it is broken nothing changed either.
  const captured = buildMessage({
    productId: ProductId.DN2,
    dumpType: 0x50,
    objNr: 42,
    payload: record(PATTERN_KIT, 3),
  });

  const written = parseMessage(nullRoundTrip(ProductId.DN2, captured));
  const original = parseMessage(captured);

  assert.equal(written.objNr, original.objNr, "same slot");
  assert.equal(written.dumpType, original.dumpType);
  assert.deepEqual([...written.payload], [...original.payload], "same bytes");
});

test("writing to a different slot restamps the slot the record claims", () => {
  // A record carries the slot it believes it occupies. Sent somewhere else without restamping, the
  // device may file it under its own idea of where it belongs.
  const SLOT_AT = 12;
  const payload = record(PATTERN_KIT, 3);
  payload[SLOT_AT] = 0;
  const captured = buildMessage({ productId: ProductId.DN2, dumpType: 0x50, objNr: 0, payload });

  const written = parseMessage(writeToSlot(ProductId.DN2, captured, 99, SLOT_AT));

  assert.equal(written.objNr, 99, "addressed to the destination");
  assert.equal(written.payload[SLOT_AT], 99, "and the record agrees with the address");
  assert.equal(payload[SLOT_AT], 0, "the source record is not modified");
});

test("a blank slot is recognised despite its slot index and kit name", () => {
  // A blank in slot 5 differs from a blank in slot 0 at exactly those places. Counting them as
  // content would call every empty slot occupied and make the guard useless.
  const blank = { pattern: new Uint8Array(100).fill(7), kit: new Uint8Array(40).fill(9) };
  const captured = new Uint8Array(140);
  captured.set(blank.pattern, 0);
  captured.set(blank.kit, 100);
  captured[3] = 42; // slot index
  captured.set([1, 2, 3, 4], 100 + 8); // kit name

  assert.deepEqual(looksBlank(captured, blank, 3, 8, 16), { blank: true, differingBytes: 0 });

  captured[50] = 0xff;
  assert.deepEqual(looksBlank(captured, blank, 3, 8, 16), { blank: false, differingBytes: 1 });
});

test("a device is left alone after a dump, for as long as the dump takes it", () => {
  // Found on hardware: a 114 KB write landed correctly and the read-back request that followed got
  // no reply, because it went out with zero delay behind the dump. elk-herd has always paced this.
  const patternKitOnTheWire = 114_118;

  const dn2 = settleMsAfter(patternKitOnTheWire, ProductId.DN2);
  const dn1 = settleMsAfter(patternKitOnTheWire, ProductId.DN1);
  assert.ok(dn2 >= 300, `${dn2}ms for 114 KB at 800 B/ms`);
  assert.ok(dn1 > dn2, "the older machine is slower per byte, so it gets longer");

  // A floor, because a small record still needs the device to come back to itself.
  assert.equal(settleMsAfter(0, ProductId.DN2), 250);
});

test("verify is the only proof a write worked", () => {
  // A device that stored the bytes and one that ignored the message look identical from here.
  const sent = record(64, 3);
  assert.equal(verifyWrite(sent, record(64, 3)).ok, true);

  const changed = record(64, 3);
  changed[40] = 0x99;
  const verdict = verifyWrite(sent, changed);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.at, 40);

  assert.match(verifyWrite(sent, record(63, 3)).reason!, /returned 63 bytes/);
});

test("a null round trip asks whether the slot is still what it captured", () => {
  /*
   * **The question `writeBack` did not use to ask.** Sending a captured record back to its own slot
   * is the safest write there is only while the slot still holds those bytes. Turn a knob between
   * the read and the write and it is an ordinary overwrite of an ordinary edit, made under a
   * confirmation promising nothing would change.
   */
  const captured = record(64, 3);
  assert.deepEqual(driftSince(captured, record(64, 3)), { same: true, differingBytes: 0 });
});

test("drift is counted, not stopped at, because the count is what the decision turns on", () => {
  /*
   * The difference from `verifyWrite`, which shares the comparison and answers a different
   * question. That one stops at the first differing byte because one wrong byte is already the
   * whole answer. This one is read by somebody deciding whether to write at all, and "three bytes
   * differ" and "half the record differs" are not the same decision.
   */
  const captured = record(64, 3);
  const onDevice = record(64, 3);
  onDevice[10] = 0x7f;
  onDevice[40] = 0x01;

  const drift = driftSince(captured, onDevice);
  assert.equal(drift.same, false);
  assert.equal(drift.differingBytes, 2, "both are counted, not just the first");
  assert.equal(drift.at, 10, "and the first is still named");
  assert.match(drift.reason!, /2 of 64 bytes differ/);
  assert.match(drift.reason!, /first at 10/);
});

test("two different lengths are drift without a byte count, which would not mean anything", () => {
  const drift = driftSince(record(64, 3), record(32, 3));
  assert.equal(drift.same, false);
  assert.equal(drift.at, undefined, "there is no first differing byte between records of two sizes");
  assert.match(drift.reason!, /holds 32 bytes and the capture is 64/);
});

// --- the Digitone 1, whose records carry a version and no magic ---------------------------------

const DN1_PATTERN_KIT = DN1_LAYOUT.patternSize + DN1_LAYOUT.kitSize;

/** A Digitone 1 record: a bare u32be version at byte 0, with no `BEEFBACE` in front of it. */
function dn1Record(size: number, version: number, fill = 0x11): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  new DataView(bytes.buffer).setUint32(0, version, false);
  return bytes;
}

test("a Digitone 1 record declares a version even with no object magic", () => {
  /*
   * The guard was inert on this family for as long as it existed. `DN1_KIT` has no magic and
   * neither does a Digitone 1 pattern record, so requiring `BEEFBACE` made both sides of the
   * comparison unknown and every write passed. OS 1.43 is the first firmware to move a Digitone 1
   * record version, which is when that stops being harmless.
   */
  assert.equal(versionOf(ProductId.DN1, WriteCode.PatternKit, dn1Record(DN1_PATTERN_KIT, 10)), 10);
  assert.equal(versionOf(ProductId.DN1, WriteCode.Pattern, dn1Record(DN1_LAYOUT.patternSize, 11)), 11);
  assert.equal(versionOf(ProductId.DN1, WriteCode.Kit, dn1Record(DN1_LAYOUT.kitSize, 11)), 11);
});

test("a Digitone 1 write across record versions is refused", () => {
  assert.throws(
    () =>
      dumpWrite(ProductId.DN1, {
        code: WriteCode.PatternKit,
        objNr: 0,
        payload: dn1Record(DN1_PATTERN_KIT, 10),
        witness: dn1Record(DN1_PATTERN_KIT, 11),
      }),
    (error: unknown) =>
      error instanceof WriteRefused &&
      /storage version 10 and the device answered with version 11/.test((error as Error).message),
  );
});

test("a Digitone 1 write at the device's own version goes through", () => {
  for (const version of [10, 11]) {
    const message = parseMessage(
      dumpWrite(ProductId.DN1, {
        code: WriteCode.PatternKit,
        objNr: 3,
        payload: dn1Record(DN1_PATTERN_KIT, version),
        witness: dn1Record(DN1_PATTERN_KIT, version),
      }),
    );
    assert.equal(message.payload.length, DN1_PATTERN_KIT);
  }
});
