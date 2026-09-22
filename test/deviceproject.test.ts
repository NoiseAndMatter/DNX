import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessage, parseMessage } from "@noiseandmatter/dnx-core/sysex/container.js";
import { ProductId } from "@noiseandmatter/dnx-core/sysex/devices.js";
import { DN2_LAYOUT, kitRecord, patternRecord } from "@noiseandmatter/dnx-core/project/dn2image.js";
import {
  type DeviceIo,
  DEFAULT_WRITE_LIMIT,
  WriteTooLarge,
  readProjectFromDevice,
  writeChangedRecords,
} from "@noiseandmatter/dnx-core/device/deviceproject.js";
import { TEST_PERMIT } from "./permit.js";

const PATTERN_KIT = DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize;

/** A patternKit whose kit half carries a real object header, so it declares a storage version. */
function patternKit(fill: number, version = 3): Uint8Array {
  const bytes = new Uint8Array(PATTERN_KIT).fill(fill);
  const kitAt = DN2_LAYOUT.patternSize;
  bytes.set([0xbe, 0xef, 0xba, 0xce], kitAt);
  bytes.set([0, 0, 0, version], kitAt + 4);
  return bytes;
}

/**
 * An image whose kit records carry a real object header.
 *
 * Not decoration: `dumpWrite` refuses a record whose storage version disagrees with the device's,
 * and a kit half of `0x11` bytes declares no version at all. A fixture without headers tests a
 * refusal rather than a write.
 */
function imageWithKitHeaders(fill: number, version = 3): Uint8Array {
  const image = new Uint8Array(DN2_LAYOUT.imageSize).fill(fill);
  for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) {
    const at = DN2_LAYOUT.kitBase + slot * DN2_LAYOUT.kitSize;
    image.set([0xbe, 0xef, 0xba, 0xce, 0, 0, 0, version], at);
  }
  return image;
}

/**
 * A device that answers every request and records everything sent to it.
 *
 * Instant clock: `wait` resolves immediately, so a test does not spend the real settle delay 128
 * times over. The delay itself is asserted separately — here what matters is that one is awaited.
 */
function fakeDevice(answer?: (m: ReturnType<typeof parseMessage>) => Uint8Array | undefined) {
  const sent: ReturnType<typeof parseMessage>[] = [];
  const waits: number[] = [];
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const io: DeviceIo = {
    send: (bytes) => {
      const message = parseMessage(bytes);
      sent.push(message);
      const reply = answer?.(message);
      // Answered from inside `send`, which is the hard case: a synchronous transport delivers
      // before the caller's send has returned, so the subscription has to be in place already.
      if (reply) for (const listener of [...listeners]) listener(reply);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return { io, sent, waits, get listenerCount() { return listeners.size; } };
}

test("a project read off a device becomes an editable image", async () => {
  const { io, sent } = fakeDevice((m) => {
    if (m.dumpType === 0x60) {
      return buildMessage({
        productId: ProductId.DN2,
        dumpType: 0x50,
        objNr: m.objNr,
        payload: patternKit(m.objNr & 0xff),
      });
    }
    if (m.dumpType === 0x63) {
      return buildMessage({ productId: ProductId.DN2, dumpType: 0x53, objNr: m.objNr, payload: new Uint8Array(359).fill(7) });
    }
    return buildMessage({ productId: ProductId.DN2, dumpType: 0x54, objNr: 0, payload: new Uint8Array(512).fill(9) });
  });

  const donor = new Uint8Array(DN2_LAYOUT.imageSize).fill(0x5a);
  const project = await readProjectFromDevice({ productId: ProductId.DN2, io, donor });

  assert.equal(project.report.ok, 257, "128 patterns, 128 pool sounds, one settings record");
  assert.equal(project.image.length, DN2_LAYOUT.imageSize);
  assert.equal(sent.filter((m) => m.dumpType === 0x60).length, 128);

  // The image is what the rest of the codebase reads: check through the project readers, not by
  // re-deriving our own offsets.
  assert.ok(patternRecord(project.image, 5).every((b) => b === 5));
  assert.ok(kitRecord(project.image, 5).some((b) => b === 0xbe), "the kit half kept its header");

  // And the witness is a record the device produced, which every later write is checked against.
  assert.equal(project.witness.get(0x50)!.length, PATTERN_KIT);
});

test("a read lets go of the port when it is done", async () => {
  // What the old `detach` did, now that a read subscribes for itself. A reader that stays
  // subscribed keeps feeding a finished `DumpReader` from the next conversation on the same port,
  // and the port has no idea it should stop.
  const device = fakeDevice((m) =>
    buildMessage({
      productId: ProductId.DN2,
      dumpType: m.dumpType === 0x60 ? 0x50 : m.dumpType === 0x63 ? 0x53 : 0x54,
      objNr: m.objNr,
      payload: patternKit(0),
    }),
  );
  assert.equal(device.listenerCount, 0, "nothing should be listening before the read");

  await readProjectFromDevice({
    productId: ProductId.DN2,
    io: device.io,
    donor: new Uint8Array(DN2_LAYOUT.imageSize).fill(0x5a),
  });

  assert.equal(device.listenerCount, 0, "the read outlived itself on the port");
});

test("only the records that changed are sent", async () => {
  // The whole point of the module. A pattern move must not cost 14.6 MB.
  const before = imageWithKitHeaders(0x11);
  const after = Uint8Array.from(before);
  after.set(patternKit(0x22).subarray(0, DN2_LAYOUT.patternSize), DN2_LAYOUT.headerSize + 3 * DN2_LAYOUT.patternSize);

  const { io, sent } = fakeDevice();
  const outcome = await writeChangedRecords({
    productId: ProductId.DN2,
    io,
    before,
    after,
    layout: DN2_LAYOUT,
    witness: patternKit(0),
    permit: TEST_PERMIT,
  });

  assert.equal(outcome.written.length, 1);
  assert.equal(outcome.written[0]!.label, "A4");
  assert.equal(sent.length, 1, "one message on the wire, not 128");
  assert.equal(sent[0]!.dumpType, 0x50);
  assert.equal(sent[0]!.objNr, 3);
});

test("an unedited project sends nothing at all", async () => {
  const image = imageWithKitHeaders(0x11);
  const { io, sent } = fakeDevice();
  const outcome = await writeChangedRecords({
    productId: ProductId.DN2,
    io,
    before: image,
    after: Uint8Array.from(image),
    layout: DN2_LAYOUT,
    witness: patternKit(0),
    permit: TEST_PERMIT,
  });
  assert.deepEqual(outcome.written, []);
  assert.equal(sent.length, 0);
});

test("a change to the kit half alone is still a change", async () => {
  // A rename lives in the pattern record and a kit name in the kit record; both must count, or an
  // edit would be silently dropped for living in the wrong half.
  const before = imageWithKitHeaders(0x11);
  const after = Uint8Array.from(before);
  after[DN2_LAYOUT.kitBase + 7 * DN2_LAYOUT.kitSize + 40] = 0x99;

  const { io } = fakeDevice();
  const outcome = await writeChangedRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: patternKit(0), permit: TEST_PERMIT,
  });

  assert.deepEqual(outcome.written.map((w) => w.label), ["A8"]);
});

test("every send is followed by a settle", async () => {
  // A request issued behind a 114 KB write is dropped by a device still ingesting it. Found on
  // hardware; this is the guard that stops it coming back.
  const before = imageWithKitHeaders(0x11);
  const after = Uint8Array.from(before);
  for (const slot of [1, 2, 3]) {
    after[DN2_LAYOUT.headerSize + slot * DN2_LAYOUT.patternSize] = 0x99;
  }

  const { io, waits } = fakeDevice();
  await writeChangedRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: patternKit(0), permit: TEST_PERMIT,
  });

  assert.equal(waits.length, 3, "one per record");
  assert.ok(waits.every((ms) => ms >= 250), `settles were ${waits.join(", ")}ms`);
});

test("a transfer-sized change is refused unless the caller means it", async () => {
  // A manager move touches two slots. Anything near a whole project is a mistake or a transfer,
  // and a transfer should announce itself rather than arrive as a surprise 14.6 MB send.
  const before = imageWithKitHeaders(0x11);
  const after = Uint8Array.from(before);
  for (let slot = 0; slot < DEFAULT_WRITE_LIMIT + 1; slot++) {
    after[DN2_LAYOUT.headerSize + slot * DN2_LAYOUT.patternSize] = 0x99;
  }

  const { io, sent } = fakeDevice();
  await assert.rejects(
    () => writeChangedRecords({
      productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: patternKit(0), permit: TEST_PERMIT,
    }),
    (e: unknown) => e instanceof WriteTooLarge && /that is a transfer rather than an edit/i.test(String(e)),
  );
  assert.equal(sent.length, 0, "and nothing goes out before the refusal");

  // Raised deliberately, it proceeds.
  const outcome = await writeChangedRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: patternKit(0), limit: 200, permit: TEST_PERMIT,
  });
  assert.equal(outcome.written.length, DEFAULT_WRITE_LIMIT + 1);
});

test("an edit the wire cannot carry is named, not silently dropped", async () => {
  // Songs are the one thing this project has always refused to risk. An edit that changed one and
  // was told "0 patterns written" would be a lie by omission.
  const before = imageWithKitHeaders(0x11);
  const after = Uint8Array.from(before);
  after[4] = 0x99; // header
  after[DN2_LAYOUT.tailBase + 60_000] = 0x99; // past the settings record: song table country

  const { io } = fakeDevice();
  const outcome = await writeChangedRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: patternKit(0), permit: TEST_PERMIT,
  });

  assert.deepEqual(outcome.written, []);
  assert.equal(outcome.untransmittable.length, 2);
  assert.match(outcome.untransmittable.join(" "), /header/);
  assert.match(outcome.untransmittable.join(" "), /song table/);
});

test("two images of different projects cannot be diffed", async () => {
  const { io } = fakeDevice();
  await assert.rejects(
    () => writeChangedRecords({
      productId: ProductId.DN2,
      io,
      before: new Uint8Array(DN2_LAYOUT.imageSize),
      after: new Uint8Array(100),
      layout: DN2_LAYOUT,
      witness: patternKit(0),
      permit: TEST_PERMIT,
    }),
    /Only two readings of the same project/,
  );
});

test("a write carrying the wrong storage version is refused by the writer's own guard", async () => {
  // The edited image declares version 2 in slot A1's kit; the device's own record says 3. This is
  // the case the guard exists for — a project edited under one firmware, written to another — and
  // it was inert until `versionOffset` was written, because it read byte 0 of a patternKit and a
  // patternKit keeps its header in the kit half.
  const before = imageWithKitHeaders(0x11);
  const after = Uint8Array.from(before);
  after.set([0xbe, 0xef, 0xba, 0xce, 0, 0, 0, 2], DN2_LAYOUT.kitBase);

  const { io } = fakeDevice();
  await assert.rejects(
    () => writeChangedRecords({
      productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: patternKit(0, 3), permit: TEST_PERMIT,
    }),
    /storage version/,
  );
});
