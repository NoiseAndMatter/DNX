/**
 * DNX writing a wavetable to `/waverider`, through its own transport, into firmware in an emulator.
 *
 * ## What is new here
 *
 * `waveriderroute.test.ts` put a store on the card as files and had the firmware read it, which
 * takes the transport out of the question. This sends a write the way the instrument would receive
 * it: open, chunks, commit, then a listing and a read-back, all through `safeWriteFile` and the
 * same `ApiTransport` the manager uses over WebMIDI.
 *
 * So what is checked is the whole chain at once — the slot file's bytes, the chunk framing, the
 * CRC-32 per chunk, the commit, and DNX's own idea of what counts as proof.
 *
 * ## Still not the instrument
 *
 * The card is an image in memory and the firmware's writes go to an overlay, so nothing here says
 * anything about flash, about a torn write, or about whether a loaded table sounds right. A green
 * run is what makes a hardware attempt reasonable.
 *
 * Needs `DNX_WAVERIDER_FIRMWARE` and the bridge variables. `DNX_DN2_CARD_IMAGE` is optional: a
 * formatted +Drive underneath, so the stock directories are real.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { writeTableToSlot } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { readSlotFile } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { POOL_POINTS, POOL_WAVES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { slotSector } from "@noiseandmatter/dnx-core/waverider/layout.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { listRequest, wholeListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";

const MODDED = process.env["DNX_WAVERIDER_FIRMWARE"];
const skip = !MODDED || bridgePaths({ firmware: MODDED }) === undefined
  ? "no /waverider firmware: set DNX_WAVERIDER_FIRMWARE alongside the bridge variables"
  : false;

const TIMEOUT = 240_000;
const CARD = process.env["DNX_DN2_CARD_IMAGE"];

/** A table of the one geometry the pool loads, so a green run could also be heard on hardware. */
function poolTable(seed: number): Uint8Array {
  const table = new Uint8Array(POOL_WAVES * POOL_POINTS * 2);
  for (let i = 0; i < table.length; i++) table[i] = (i * seed + 1) & 0xff;
  return table;
}

function pending(slot: number, name: string, seed: number) {
  const table = poolTable(seed);
  return {
    slot, name, waves: POOL_WAVES, points: POOL_POINTS, interpolate: true,
    table, sourceHash: xxHash32(table), sourceSize: table.length, gain: 1,
  };
}

async function withBridge<T>(run: (bridge: EmulatorBridge) => Promise<T>): Promise<T> {
  const bridge = await EmulatorBridge.start({
    firmware: MODDED!,
    ...(CARD === undefined ? {} : { cardImage: CARD }),
    startupMs: TIMEOUT,
  });
  try {
    return await run(bridge);
  } finally {
    bridge.close();
  }
}

/**
 * Armed, and asked. The test is the person here, so both are explicit rather than defaulted.
 *
 * The same `DriveWriteHost` shape every other write in core takes, which `writeenable.test.ts`
 * scans for: a gate the host supplies, a confirmation it owns, and its own message ids.
 */
const host = {
  ids: new MessageIds(),
  gate: (): void => {},
  confirm: async (): Promise<boolean> => true,
};

test("DNX writes a table, the store takes it, and the slot reads back identical", { skip }, async () => {
  await withBridge(async (bridge) => {
    const table = pending(7, "DNXWRITE", 7);

    const result = await writeTableToSlot({
      transport: bridge, host, table, timeoutMs: TIMEOUT,
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.problem, undefined, "the write reported a problem");
    assert.equal(result.committed, true);

    // **The listing is the proof, not the commit.** A commit cannot refuse: the stock session
    // answers 0x59 before the store's callback runs and ignores what it returns, so a rejected
    // write answers "commit ok" and writes nothing.
    assert.equal(result.listed, true, "the slot must be occupied in the listing afterwards");
    assert.equal(result.listedAs, "DNXWRITE", "the device read the name out of our index entry");

    assert.equal(result.verified, true, "the read-back must match what was sent");
    assert.equal(result.written, 31 + 128 + table.table.length + 12);

    // A table of the pool's geometry, so nothing here is unplayable.
    assert.equal(result.unplayable, undefined);
  });
});

test("the slot the firmware hands back is the file DNX built", { skip }, async () => {
  await withBridge(async (bridge) => {
    const table = pending(5, "ROUNDTRIP", 11);
    const written = await writeTableToSlot({
      transport: bridge, host, table, timeoutMs: TIMEOUT,
    });
    assert.equal(written.problem, undefined);

    // Read it back as a file and parse it with the same reader a verify uses, which checks the
    // entry against the table rather than trusting either.
    const { readStoredFile } = await import("@noiseandmatter/dnx-core/device/storagesession.js");
    const file = await readStoredFile("/waverider/5", { transport: bridge, timeoutMs: TIMEOUT });
    const back = readSlotFile(file.bytes);

    assert.equal(back.entry.slot, 5);
    assert.equal(back.entry.name, "ROUNDTRIP");
    assert.equal(back.entry.waves, POOL_WAVES);
    assert.equal(back.entry.points, POOL_POINTS);
    assert.equal(back.entry.startSector, slotSector(5), "the slot's own extent, not ours to choose");
    assert.equal(back.entry.byteLength, table.table.length);
    assert.equal(back.entry.tableHash, xxHash32(table.table));
    assert.deepEqual([...back.table], [...table.table], "the samples, byte for byte");
  });
});

test("a second slot leaves the first alone, and both appear", { skip }, async () => {
  await withBridge(async (bridge) => {
    for (const [slot, name, seed] of [[0, "FIRST", 3], [9, "SECOND", 13]] as const) {
      const result = await writeTableToSlot({
        transport: bridge, host, table: pending(slot, name, seed), timeoutMs: TIMEOUT,
      });
      assert.equal(result.problem, undefined, `slot ${slot}`);
      assert.equal(result.listed, true, `slot ${slot}`);
    }

    // The two-group alternation carries the untouched slot across, which is the property the
    // scheme exists for on the happy path.
    const reply = await bridge.request(listRequest(90, "/waverider"), 90, TIMEOUT);
    const used = wholeListing(reply, "/waverider").entries
      .filter((e) => e.occupied === true)
      .map((e) => [e.index, e.name]);
    assert.deepEqual(used, [[0, "FIRST"], [9, "SECOND"]]);
  });
});

test("an occupied slot is refused without a backup hook", { skip }, async () => {
  await withBridge(async (bridge) => {
    const first = await writeTableToSlot({
      transport: bridge, host, table: pending(3, "HELD", 5), timeoutMs: TIMEOUT,
    });
    assert.equal(first.listed, true);

    /*
     * The empty-slot rule, reached through the device's real listing rather than a fixture: the
     * slot is occupied now, so a write without `overwrite` is refused before anything is sent.
     *
     * The message is matched exactly, name included. A loose pattern here would also match the
     * listing failing to read, which is a different outcome that would leave the test green while
     * checking nothing about occupancy.
     */
    await assert.rejects(
      writeTableToSlot({ transport: bridge, host, table: pending(3, "OTHER", 6), timeoutMs: TIMEOUT }),
      /\/waverider\/3 holds "HELD" — writing there would overwrite it/,
    );

    // And `overwrite` without a backup hook is refused too, which is the rule that stops a write
    // destroying the only copy of something.
    await assert.rejects(
      writeTableToSlot({
        transport: bridge, host, overwrite: true,
        table: pending(3, "OTHER", 6), timeoutMs: TIMEOUT,
      }),
      /refusing to overwrite a \+Drive slot without a backup hook/,
    );
  });
});
