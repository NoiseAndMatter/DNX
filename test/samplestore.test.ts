/**
 * DNX's `BloomSampleStore` against firmware with the `/samples` route, in the emulator.
 *
 * Needs `DNX_BLOOM_FIRMWARE` and the bridge variables. Skipped until the firmware session's build
 * with the route exists. A green run is what makes a write to the unit reasonable to ask for.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { BloomSampleStore } from "@noiseandmatter/dnx-core/device/samplestore.js";
import { DATA_START_SECTOR, EXTENT_UNIT_SECTORS } from "@noiseandmatter/dnx-core/sample/blsm.js";
import { storedSample } from "@noiseandmatter/dnx-core/sample/format.js";
import { identify, sameSample } from "@noiseandmatter/dnx-core/sample/identity.js";

const FIRMWARE = process.env["DNX_BLOOM_FIRMWARE"];
const skip = !FIRMWARE || bridgePaths({ firmware: FIRMWARE }) === undefined
  ? "no /samples firmware: set DNX_BLOOM_FIRMWARE alongside the bridge variables"
  : false;
const TIMEOUT = 240_000;
const CARD = process.env["DNX_DN2_CARD_IMAGE"];

function tone(channels: 1 | 2, frames: number, step: number) {
  const pcm = new Int16Array(frames * channels);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(12_000 * Math.sin(i * step));
  return storedSample(channels, pcm);
}

test("DNX puts a sample, the firmware allocates it, and a second put is a no-op", { skip, timeout: TIMEOUT * 2 }, async () => {
  const bridge = await EmulatorBridge.start({ firmware: FIRMWARE!, ...(CARD === undefined ? {} : { cardImage: CARD }), startupMs: TIMEOUT });
  try {
    let deletes = 0;
    const store = new BloomSampleStore({
      transport: bridge,
      host: { ids: new MessageIds(), gate: () => {}, confirm: async () => true },
      nameFor: () => "DNXTEST",
      confirmDelete: async () => {
        deletes++;
        return true;
      },
      timeoutMs: TIMEOUT,
    });
    const sample = tone(2, 48_000, 0.05);
    const id = identify(sample);

    await store.put(id, sample);
    const index = await store.readIndex();
    const entry = index.entries.find((e) => e.identityHash === id.hash);
    assert.ok(entry, "the index holds the sample");
    assert.ok(entry.startSector >= DATA_START_SECTOR && entry.startSector % EXTENT_UNIT_SECTORS === 0);
    assert.ok(entry.extentSectors * 512 >= id.size);
    assert.ok((await store.holdings()).some((h) => sameSample(h, id)));

    await store.put(id, sample);
    assert.equal((await store.readIndex()).entries.length, index.entries.length, "no second copy");

    await store.remove(id);
    assert.equal(deletes, 1);
    assert.ok(!(await store.holdings()).some((h) => sameSample(h, id)));
  } finally {
    bridge.close();
  }
});
