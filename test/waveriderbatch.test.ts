/**
 * `writeTablesToSlots`: several tables into empty `/waverider` slots, asked once, in the emulator.
 *
 * One bridge for every case, because a boot costs about 25 seconds. Each case uses its own slots,
 * so the order of the cases does not matter.
 *
 * The case that matters most is the last: a transport that fails part-way. That used to escape the
 * library's write loop as an unhandled rejection, and nobody was told the run had stopped.
 *
 * Needs `DNX_WAVERIDER_FIRMWARE` and the bridge variables.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { writeTablesToSlots } from "@noiseandmatter/dnx-core/device/waveriderbatch.js";
import { writeTableToSlot } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { readStoreListing } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { POOL_POINTS, POOL_WAVES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";

const MODDED = process.env["DNX_WAVERIDER_FIRMWARE"];
const skip = !MODDED || bridgePaths({ firmware: MODDED }) === undefined
  ? "no /waverider firmware: set DNX_WAVERIDER_FIRMWARE alongside the bridge variables"
  : false;

const TIMEOUT = 240_000;

function pending(slot: number, name: string) {
  const table = new Uint8Array(POOL_WAVES * POOL_POINTS * 2);
  for (let i = 0; i < table.length; i++) table[i] = (i * (slot + 3) + 1) & 0xff;
  return {
    slot, name, waves: POOL_WAVES, points: POOL_POINTS, interpolate: true,
    table, sourceHash: xxHash32(table), sourceSize: table.length, gain: 1,
  };
}

async function occupied(transport: ApiTransport, ids: MessageIds, slots: number[]): Promise<boolean[]> {
  const listing = await readStoreListing(transport, ids);
  return slots.map((slot) => listing.find((row) => row.slot === slot)?.occupied === true);
}

test("a batch writes into empty slots, refuses a taken one, and reports a failure part-way", { skip, timeout: TIMEOUT * 2 }, async (t) => {
  const bridge = await EmulatorBridge.start({ firmware: MODDED!, startupMs: TIMEOUT });
  const ids = new MessageIds();
  const armed = { ids, gate: (): void => {} };
  try {
    await t.test("every table written, listed and verified", async () => {
      let asked = 0;
      const outcome = await writeTablesToSlots({
        transport: bridge,
        host: { ...armed, ask: async (tables) => { asked = tables.length; return true; } },
        tables: [pending(20, "BATCH20"), pending(21, "BATCH21")],
        timeoutMs: TIMEOUT,
      });
      assert.equal(outcome.kind, "done");
      assert.equal(asked, 2, "one question, naming both tables");
      assert.deepEqual(outcome.kind === "done" ? outcome.written.map((r) => r.listedAs) : [], ["BATCH20", "BATCH21"]);
      assert.deepEqual(await occupied(bridge, ids, [20, 21]), [true, true]);
    });

    await t.test("one taken slot refuses the run before the question", async () => {
      await writeTableToSlot({
        transport: bridge, host: { ...armed, confirm: async () => true }, table: pending(31, "TAKEN"),
        timeoutMs: TIMEOUT,
      });
      let asked = false;
      const outcome = await writeTablesToSlots({
        transport: bridge,
        host: { ...armed, ask: async () => { asked = true; return true; } },
        tables: [pending(30, "FREE30"), pending(31, "OVER31")],
        timeoutMs: TIMEOUT,
      });
      assert.equal(outcome.kind, "occupied");
      assert.deepEqual(outcome.kind === "occupied" ? outcome.slots.map((s) => s.slot) : [], [31]);
      assert.equal(asked, false, "nobody is asked about a run that cannot go ahead");
      assert.deepEqual(await occupied(bridge, ids, [30]), [false], "slot 30 was not written");
    });

    await t.test("a slot outside the listing is refused, not taken as empty", async () => {
      const outcome = await writeTablesToSlots({
        transport: bridge,
        host: { ...armed, ask: async () => true },
        tables: [pending(400, "NOWHERE")],
        timeoutMs: TIMEOUT,
      });
      assert.deepEqual(outcome, { kind: "missing", slots: [400] });
    });

    await t.test("WRITE off: nothing asked, nothing sent", async () => {
      let asked = false;
      const outcome = await writeTablesToSlots({
        transport: bridge,
        host: {
          ids,
          gate: () => { throw new Error("WRITE is off. Nothing was sent."); },
          ask: async () => { asked = true; return true; },
        },
        tables: [pending(40, "GATED")],
        timeoutMs: TIMEOUT,
      });
      assert.deepEqual(outcome, { kind: "gated", problem: "WRITE is off. Nothing was sent." });
      assert.equal(asked, false);
      assert.deepEqual(await occupied(bridge, ids, [40]), [false]);
    });

    await t.test("declined: nothing sent", async () => {
      const outcome = await writeTablesToSlots({
        transport: bridge,
        host: { ...armed, ask: async () => false },
        tables: [pending(41, "NO")],
        timeoutMs: TIMEOUT,
      });
      assert.deepEqual(outcome, { kind: "declined" });
      assert.deepEqual(await occupied(bridge, ids, [41]), [false]);
    });

    await t.test("a transport failure part-way is returned with what was written", async () => {
      // The second table's first message times out, as a flaky USB port does.
      let failNext = false;
      const flaky: ApiTransport = {
        request: (bytes, msgId, timeoutMs) => {
          if (failNext) return Promise.reject(new Error(`no reply to 0x${msgId.toString(16)} within ${timeoutMs}ms`));
          return bridge.request(bytes, msgId, timeoutMs);
        },
      };
      const outcome = await writeTablesToSlots({
        transport: flaky,
        host: { ...armed, ask: async () => true },
        tables: [pending(50, "FIRST"), pending(51, "SECOND"), pending(52, "THIRD")],
        onWriting: (done) => { failNext = done === 1; },
        timeoutMs: TIMEOUT,
      });
      assert.equal(outcome.kind, "stopped");
      if (outcome.kind !== "stopped") return;
      assert.deepEqual(outcome.written.map((r) => r.slot), [50]);
      assert.equal(outcome.at.slot, 51);
      assert.match(outcome.problem, /no reply to 0x/);
      assert.deepEqual(await occupied(bridge, ids, [50, 51, 52]), [true, false, false]);
    });
  } finally {
    bridge.close();
  }
});
