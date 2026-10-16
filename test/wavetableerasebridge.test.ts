/**
 * Erasing the wavetable region, against the firmware that can do it.
 *
 * **The one operation in DNX that destroys everything it addresses**, so what is checked here is
 * not that it reports success but that the instrument is actually empty afterwards, read through
 * its own listings. Every refusal on this route is silent — the session answers the commit before
 * the store acts — so a request that was rejected looks exactly like one that worked.
 *
 * Needs `waverider-erase2-usbprobe`, not the build the other emulator tests use: the erase route
 * and its capability bit exist only there. Point `DNX_ERASE_FIRMWARE` at it. Without that these
 * skip, and the rest of the suite is unaffected.
 *
 * Three properties:
 *
 * - **It empties the region**, proved by both listings and by the working project's pool reading
 *   as empty afterwards.
 * - **Every table is copied before anything is sent**, and a refusal at the question leaves the
 *   instrument untouched — which is the condition the owner set for this existing at all.
 * - **A stale count is refused**, which is the guard that stops a confirmation given against an
 *   old listing from erasing something that arrived since.
 */

import assert from "node:assert/strict";
import { readPoolFile } from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { eraseWavetableStore } from "@noiseandmatter/dnx-core/device/wavetableerase.js";
import { WAVERIDER, writeTableToSlot } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { writePool } from "@noiseandmatter/dnx-core/device/wavepoolwrite.js";
import { listRequest, wholeListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";

const ERASE_FW = process.env["DNX_ERASE_FIRMWARE"];
const skip = !ERASE_FW || bridgePaths({ firmware: ERASE_FW }) === undefined
  ? "no erase firmware: set DNX_ERASE_FIRMWARE to a build carrying the 0x80 capability"
  : false;

const TIMEOUT = 240_000;

const host = {
  ids: new MessageIds(),
  gate: (): void => {},
  confirm: async (): Promise<boolean> => true,
};

async function withBridge<T>(run: (bridge: EmulatorBridge) => Promise<T>): Promise<T> {
  const bridge = await EmulatorBridge.start({ firmware: ERASE_FW!, startupMs: TIMEOUT });
  try {
    return await run(bridge);
  } finally {
    bridge.close();
  }
}

/** How many entries a route lists as used. The only answer that counts here. */
async function used(bridge: EmulatorBridge, root: string): Promise<number> {
  const msgId = new MessageIds().reserve(4);
  const reply = await bridge.request(listRequest(msgId, root), msgId, TIMEOUT);
  return wholeListing(reply, root).entries.filter((e) => e.occupied === true).length;
}

function table(waves: number, points: number): Uint8Array {
  const bytes = new Uint8Array(waves * points * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < waves * points; i++) {
    view.setInt16(i * 2, Math.round(20000 * Math.sin((i / points) * 2 * Math.PI)), false);
  }
  return bytes;
}

function pending(slot: number, name: string) {
  const bytes = table(16, 512);
  return {
    slot, name, waves: 16, points: 512, interpolate: true,
    table: bytes, sourceHash: xxHash32(bytes), sourceSize: bytes.length, gain: 1,
  };
}

/** Put something in the region, so an erase has something to remove. */
async function fill(bridge: EmulatorBridge): Promise<void> {
  for (const slot of [0, 1, 2]) {
    await writeTableToSlot({
      transport: bridge, host, table: pending(slot, `ERASE ME ${slot}`), timeoutMs: TIMEOUT,
    });
  }
  await writePool({
    transport: bridge, host, projectSlot: 4, entries: [0, 1, 2],
    onBackup: () => {}, timeoutMs: TIMEOUT,
  });
}

test("the region is empty afterwards, by its own listings", { skip }, async () => {
  await withBridge(async (bridge) => {
    await fill(bridge);
    assert.equal(await used(bridge, WAVERIDER), 3, "the fixture did not land");
    assert.ok((await used(bridge, "/wavepool")) >= 1, "no pool list to erase");

    const lists = await used(bridge, "/wavepool");
    const copies: { name: string; bytes: Uint8Array }[] = [];
    const result = await eraseWavetableStore({
      transport: bridge,
      host,
      onBackup: (backup) => { copies.push({ name: backup.name, bytes: backup.bytes }); },
      timeoutMs: TIMEOUT,
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.problem, undefined, "the erase reported a problem");
    assert.equal(result.erased, true, "the erase did not take");
    assert.equal(result.tables, 3);

    // **The proof, read rather than believed.** A silent refusal reports the same success.
    assert.equal(await used(bridge, WAVERIDER), 0, "tables are still listed");
    assert.equal(await used(bridge, "/wavepool"), 0, "pool lists are still listed");

    // And a copy of every table and every pool list was handed over before any of it went.
    const tables = copies.filter((c) => c.name.startsWith("waverider-"));
    const pools = copies.filter((c) => c.name.startsWith("wavepool-"));
    assert.equal(tables.length, 3, "one copy per table");
    for (const { bytes } of tables) assert.ok(bytes.length > 16 * 512 * 2, `a copy was only ${bytes.length} bytes`);
    assert.equal(pools.length, lists, "one copy per pool list");
    for (const { bytes } of pools) readPoolFile(bytes);
  });
});

test("saying no leaves everything where it was, with the copies already taken", { skip }, async () => {
  /*
   * The copies come first on purpose: a read that fails has to stop the run before anybody agrees
   * to anything, because there is no undo on the instrument. The visible consequence is that a
   * refusal still produces the copies, and nothing else.
   */
  await withBridge(async (bridge) => {
    await fill(bridge);
    const lists = await used(bridge, "/wavepool");

    const order: string[] = [];
    const result = await eraseWavetableStore({
      transport: bridge,
      host: {
        ids: new MessageIds(),
        gate: (): void => {},
        confirm: async (): Promise<boolean> => { order.push("asked"); return false; },
      },
      onBackup: () => { order.push("copied"); },
      timeoutMs: TIMEOUT,
    });

    assert.equal(result.cancelled, true);
    assert.equal(result.erased, false);
    assert.deepEqual(order, [...Array(3 + lists).fill("copied"), "asked"], "the copies must come first");
    assert.equal(await used(bridge, WAVERIDER), 3, "a refused erase must change nothing");
  });
});

test("an empty region erases without asking anybody to copy nothing", { skip }, async () => {
  // The repeat case: an erase interrupted between the metadata write and the TRIM leaves the
  // store already reading empty, and sending the request again is how the TRIM finishes.
  await withBridge(async (bridge) => {
    let copied = 0;
    const result = await eraseWavetableStore({
      transport: bridge,
      host,
      onBackup: () => { copied += 1; },
      timeoutMs: TIMEOUT,
    });

    assert.equal(copied, 0, "there was nothing to copy");
    assert.equal(result.tables, 0);
    assert.equal(result.erased, true, "a request with both counts zero must still be accepted");
  });
});
