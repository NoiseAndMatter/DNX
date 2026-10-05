/**
 * DNX's real +Drive code against the real firmware, running in an emulator.
 *
 * Nothing here is mocked. `sysex_bridge.exe` boots a Digitone II OS image, injects the bytes DNX
 * would put on the wire into the firmware's own SysEx router, and returns what reaches the
 * firmware's own sender. The request builders, the 8-in-7 codec and `parseListing` are DNX's; the
 * handlers are Elektron's. **The only thing simulated is the wire.**
 *
 * ## What this is worth, and what it is not
 *
 * Every +Drive behaviour this project knows was learnt by sending something to the author's
 * instrument and looking at what came back. Three of the longest-standing mistakes — the chunk
 * index read as a byte offset, the stored form sent raw, the missing NUL that froze a Digitone 1
 * three times — would each have shown here in seconds.
 *
 * **It is still not the instrument.** The emulator's card is blank unless given an image, so every
 * slot reads empty and a listing that caps on real hardware fits in one reply here. Agreement is
 * with the firmware's logic, not with a real +Drive's contents.
 *
 * ## Skipped without the emulator, and loud with it
 *
 * Set `DNX_SYSEX_BRIDGE`, `DNX_EMU_FIRMWARE`, and usually `DNX_EMU_CWD` and `DNX_EMU_STATE`. With
 * none of them the tests skip, the way the corpus ones do, because the emulator lives in a
 * different repository and most checkouts will not have it. **With them, nothing is tolerated** —
 * a bridge that is present and not working is a failure, not a skip.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { Code, encodeMessage, readDeviceResponse, readVersionResponse } from "@noiseandmatter/dnx-core/device/api.js";
import { listRequest, parseListing } from "@noiseandmatter/dnx-core/device/storage.js";

const NO_BRIDGE = bridgePaths() === undefined;
const skip = NO_BRIDGE
  ? "no emulator: set DNX_SYSEX_BRIDGE, DNX_EMU_FIRMWARE and DNX_EMU_CWD"
  : false;

/** One bridge for the file. Starting the emulator costs a second even from a saved state. */
let shared: EmulatorBridge | undefined;
async function bridge(): Promise<EmulatorBridge> {
  shared ??= await EmulatorBridge.start({});
  return shared;
}
after(async () => { await shared?.close(); });

const TIMEOUT = 60_000;

test("the firmware identifies itself, and says which OS wrote it", { skip }, async () => {
  const io = await bridge();
  const device = readDeviceResponse((await io.request(encodeMessage(1, Code.Device), 1, TIMEOUT)).body);

  assert.equal(device.deviceName, "Digitone II");
  assert.equal(device.productId, 43);

  // **The file API the Digitakt has and this family does not.** elk-herd gates `hasDriveSamples`
  // on 0x10, 0x11, 0x12, 0x20 and 0x21 all being present; DNX concluded from two instruments that
  // neither Digitone advertises them. The firmware agrees, which is a negative result confirmed
  // from a second direction.
  for (const absent of [0x10, 0x11, 0x12, 0x20, 0x21]) {
    assert.ok(!device.supportedMessages.includes(absent), `0x${absent.toString(16)} must be absent`);
  }
  // And the storage codes DNX actually uses are all advertised, 0x55 and 0x56 included — which
  // `capabilities.ts` still describes as unattempted rather than unadvertised.
  for (const present of [0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59]) {
    assert.ok(device.supportedMessages.includes(present), `0x${present.toString(16)} must be advertised`);
  }

  const version = readVersionResponse((await io.request(encodeMessage(2, Code.Version), 2, TIMEOUT)).body);
  // The container format string and the OS version, from the device, in one reply. DNX reads
  // "0059" out of every 1.11 project header and had been pairing the two by inference.
  assert.equal(JSON.stringify(version).includes("1.11"), true, `version was ${JSON.stringify(version)}`);
});

test("the root lists the three directories DNX expects, in short form", { skip }, async () => {
  const io = await bridge();
  const listing = parseListing((await io.request(listRequest(3, "/"), 3, TIMEOUT)).body);

  assert.equal(listing.declared, 3);
  assert.equal(listing.entries.length, 3);
  assert.ok(listing.complete);
  assert.deepEqual(listing.entries.map((e) => e.name), ["projects", "soundbanks", "kits"]);

  for (const entry of listing.entries) {
    assert.equal(entry.kind, "directory");
    // Short form: a child count and nothing else. No size, no permissions, no occupancy — which
    // is what a fourth root entry has to look like too.
    assert.equal(entry.size, undefined);
    assert.equal(entry.permissions, undefined);
    assert.ok(typeof entry.children === "number");
  }
  assert.deepEqual(listing.entries.map((e) => e.children), [128, 8, 8], "slots, banks, banks");
});

test("a project slot's index is the device's own, and it counts from one", { skip }, async () => {
  // `/projects/56` in Elektron Transfer's traffic is slot 56, and DNX has assumed the listing
  // agreed. This is the first time anything has checked: the index is a field in the entry, not a
  // position, and it runs 1..128. An off-by-one here is a project opened from the wrong slot,
  // which is the mistake this whole subsystem is arranged to prevent.
  const io = await bridge();
  const listing = parseListing((await io.request(listRequest(4, "/projects"), 4, TIMEOUT)).body);

  assert.equal(listing.declared, 128);
  assert.equal(listing.entries.length, 128, "a blank card's empty names all fit one reply");
  const indices = listing.entries.map((e) => e.index);
  assert.equal(indices[0], 1, "one-based");
  assert.equal(indices.at(-1), 128);
  assert.deepEqual(indices, indices.map((_, i) => i + 1), "contiguous");

  for (const entry of listing.entries) {
    assert.equal(entry.kind, "file");
    assert.equal(entry.size, 16 * 1024 * 1024, "the slot's allocation, not a file length");
    // The two fields a `/waverider` handler has to get right or a write is refused locally.
    assert.equal(entry.permissions, 0x007e);
    assert.equal(entry.writable, true);
    assert.equal(entry.occupied, false, "blank card");
  }
});

test("a page is a half-open window over index values, not a start and a count", { skip }, async () => {
  /*
   * **This is why `Page` was renamed.** The field called `count` is the window's `end`, and the
   * firmware's *router* applies it identically to every route, so no handler can change it.
   *
   * It explains an observation DNX had carried for months as an oddity: `(0, 45)` on `/projects`
   * returns 44 entries, because `[0, 45)` over a 1-based slot space loses position 0. Not an
   * off-by-one in the device — an off-by-one in the name.
   */
  const io = await bridge();
  const page = async (id: number, first: number, end: number) =>
    parseListing((await io.request(listRequest(id, "/projects", { first, end }), id, TIMEOUT)).body);

  const low = await page(5, 0, 45);
  assert.equal(low.entries[0]!.index, 1, "slot 0 does not exist, so [0,45) starts at 1");
  assert.equal(low.entries.at(-1)!.index, 44);
  assert.equal(low.entries.length, 44);

  // The end is clipped to the directory rather than refused.
  const high = await page(6, 100, 145);
  assert.equal(high.entries[0]!.index, 100);
  assert.equal(high.entries.at(-1)!.index, 128);
  assert.equal(high.next, 129, "the clipped end, which is where a caller resumes");

  // A backwards window asks for nothing, which is what any empty range means.
  const backwards = await page(7, 10, 5);
  assert.equal(backwards.entries.length, 0);

  // **`declared` is the page's own count, so completeness means nothing on a paged reply.**
  assert.equal(low.declared, 44);
  assert.equal(low.complete, true, "trivially, which is why core asks unpaged");
});

test("stock has no /waverider route, and says so", { skip }, async () => {
  // The baseline. On the modded image this becomes a listing — `waveriderroute.test.ts` runs that
  // against the same parser, so the two files together say the route is the only difference.
  const io = await bridge();
  await assert.rejects(
    async () => parseListing((await io.request(listRequest(8, "/waverider"), 8, TIMEOUT)).body),
    /Invalid path/,
  );
});

test("a message the firmware does not handle produces an explicit no-reply", { skip }, async () => {
  // A timeout and a silent success are indistinguishable otherwise, and "the handler was never
  // reached" is a result worth being able to see. The bridge reports it as an empty reply list.
  const io = await bridge();
  const hello = Uint8Array.of(0xf0, 0x00, 0x20, 0x3c, 0x7d, 0x00, 0x01, 0xf7);
  const { replies } = await io.exchange(hello, TIMEOUT);
  assert.deepEqual(replies, [], "stock does not answer the probe's HELLO");

  // And the bridge is still usable afterwards, which a fatal would not be.
  const listing = parseListing((await io.request(listRequest(7, "/"), 7, TIMEOUT)).body);
  assert.equal(listing.entries.length, 3);
});

test("a reply is matched by respId, never by its own msgId", { skip }, async () => {
  /*
   * The device's `msgId` is its own counter and bears no relation to ours — a request sent as
   * msgId 3 came back as msgId 2 with respId 3. Every transport in DNX matches on `respId`, and
   * matching on `msgId` instead would work for exactly as long as the two counters agreed, which
   * on a fresh connection they very nearly do.
   */
  const io = await bridge();
  const mine = 1234;
  const { replies } = await io.exchange(listRequest(mine, "/"), TIMEOUT);

  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.respId, mine, "respId echoes ours");
  assert.notEqual(replies[0]!.msgId, mine, "and msgId is the device's own counter");
});
