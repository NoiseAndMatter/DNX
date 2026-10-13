/**
 * Deleting a wavetable, against the firmware's own handlers.
 *
 * **This path has run against an instrument and never against a test.** It lived in the probe
 * page, where it could only be exercised by a person clicking it with hardware attached, so the
 * careful parts — the copy before the question, the refusal to delete an empty slot, the second
 * listing that proves it went — were things the code said rather than things anybody had checked.
 * Lifting it into core on 2026-10-13 is what made these possible.
 *
 * Three properties, in the order they can go wrong:
 *
 * - **A table written and then deleted leaves the slot free**, proved by a listing rather than by
 *   the delete's own reply. This route answers optimistically; `commit ok` and nothing written is
 *   the shape that cost us slot 9.
 * - **The copy reaches the hook before the question is asked.** A delete whose copy failed is a
 *   delete nobody can reverse, so the order is the safety, not a tidiness.
 * - **An empty slot is reported, not deleted.** It is a question not worth asking the instrument
 *   and not worth asking a person either.
 *
 * `/waverider` needs the modded firmware, so these skip with the rest when it is not configured.
 * `docs/emulator-tests.md` says how to configure it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { deleteTableSlot } from "@noiseandmatter/dnx-core/device/waveriderdelete.js";
import { WAVERIDER, writeTableToSlot } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { listRequest, wholeListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";

const MODDED = process.env["DNX_WAVERIDER_FIRMWARE"];
const skip = !MODDED || bridgePaths({ firmware: MODDED }) === undefined
  ? "no /waverider firmware: set DNX_WAVERIDER_FIRMWARE alongside the bridge variables"
  : false;

const TIMEOUT = 240_000;

/** Armed and asked, explicitly, because the test is the person here. */
const host = {
  ids: new MessageIds(),
  gate: (): void => {},
  confirm: async (): Promise<boolean> => true,
};

async function withBridge<T>(run: (bridge: EmulatorBridge) => Promise<T>): Promise<T> {
  const bridge = await EmulatorBridge.start({ firmware: MODDED!, startupMs: TIMEOUT });
  try {
    return await run(bridge);
  } finally {
    bridge.close();
  }
}

/** Whether the listing says a slot is in use, which is the only answer that counts here. */
async function occupied(bridge: EmulatorBridge, slot: number): Promise<boolean> {
  const ids = new MessageIds();
  const msgId = ids.reserve(1);
  const reply = await bridge.request(listRequest(msgId, WAVERIDER), msgId, TIMEOUT);
  return wholeListing(reply, WAVERIDER).entries.find((e) => e.index === slot)?.occupied === true;
}

/** Everything `writeTableToSlot` wants, so a test states only what it is about. */
function pending(slot: number, name: string) {
  const bytes = table(16, 512);
  return {
    slot, name, waves: 16, points: 512, interpolate: true,
    table: bytes, sourceHash: xxHash32(bytes), sourceSize: bytes.length, gain: 1,
  };
}

/** A playable table: 16 x 512 is the geometry every build loads. */
function table(waves: number, points: number): Uint8Array {
  const bytes = new Uint8Array(waves * points * 2);
  const view = new DataView(bytes.buffer);
  for (let wave = 0; wave < waves; wave++) {
    for (let point = 0; point < points; point++) {
      const value = Math.round(20000 * Math.sin((point / points) * 2 * Math.PI));
      view.setInt16((wave * points + point) * 2, value, false);
    }
  }
  return bytes;
}

test("a table written and then deleted leaves the slot free", { skip }, async () => {
  await withBridge(async (bridge) => {
    const slot = 11;
    assert.equal(await occupied(bridge, slot), false, "the card should start with this slot free");

    const written = await writeTableToSlot({
      transport: bridge,
      host,
      table: pending(slot, "DELETE ME"),
      timeoutMs: TIMEOUT,
    });
    assert.equal(written.listed, true, "the table did not land, so the delete would prove nothing");
    assert.equal(await occupied(bridge, slot), true);

    const copies: { name: string; bytes: number }[] = [];
    const result = await deleteTableSlot({
      transport: bridge,
      host,
      slot,
      onBackup: (backup) => { copies.push({ name: backup.name, bytes: backup.bytes.length }); },
      timeoutMs: TIMEOUT,
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.problem, undefined, "the delete reported a problem");
    // **The listing is the proof, not the reply.** See this module's note.
    assert.equal(result.deleted, true, "the delete reported success");
    assert.equal(await occupied(bridge, slot), false, "the slot is still in use on the instrument");

    assert.equal(copies.length, 1, "exactly one copy, of the table that went");
    assert.ok(copies[0]!.bytes > 16 * 512 * 2, `the copy was only ${copies[0]!.bytes} bytes`);
    assert.match(copies[0]!.name, /DELETE ME/, "the copy should be named after what it holds");
  });
});

test("the copy is taken before the question, not after it", { skip }, async () => {
  /*
   * **The order is the safety.** There is no undo on the instrument, so a delete whose copy failed
   * must stop before anybody agrees to anything. Checked by refusing at the question and asserting
   * the copy already happened — which also proves a cancelled delete leaves the table alone.
   */
  await withBridge(async (bridge) => {
    const slot = 12;
    await writeTableToSlot({
      transport: bridge,
      host,
      table: pending(slot, "KEEP ME"),
      timeoutMs: TIMEOUT,
    });

    const order: string[] = [];
    const result = await deleteTableSlot({
      transport: bridge,
      host: {
        ids: new MessageIds(),
        gate: (): void => {},
        confirm: async (): Promise<boolean> => { order.push("asked"); return false; },
      },
      slot,
      onBackup: () => { order.push("copied"); },
      timeoutMs: TIMEOUT,
    });

    assert.deepEqual(order, ["copied", "asked"], "the copy must come first");
    assert.equal(result.cancelled, true);
    assert.equal(result.deleted, false);
    assert.equal(await occupied(bridge, slot), true, "a refused delete must leave the table alone");
  });
});

test("an empty slot is reported rather than deleted", { skip }, async () => {
  await withBridge(async (bridge) => {
    const slot = 200;
    let asked = false;
    const result = await deleteTableSlot({
      transport: bridge,
      host: {
        ids: new MessageIds(),
        gate: (): void => {},
        confirm: async (): Promise<boolean> => { asked = true; return true; },
      },
      slot,
      onBackup: () => { throw new Error("nothing should be copied from an empty slot"); },
      timeoutMs: TIMEOUT,
    });

    assert.equal(result.deleted, false);
    assert.match(result.problem ?? "", /already empty/);
    assert.equal(asked, false, "nobody should be asked about deleting nothing");
  });
});
