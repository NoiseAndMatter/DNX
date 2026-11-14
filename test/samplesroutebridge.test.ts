/**
 * The `/samples` client against the firmware's own route, in the emulator.
 *
 * The route is on a local firmware branch, not released. Only digikit main's `sysex_bridge`
 * models the card's store area, and it takes the patched image with `--base`, the stock image's
 * SHA-256. So this test has its own variables:
 *
 * - `DNX_SAMPLES_BRIDGE`: digikit main's `sysex_bridge.exe`
 * - `DNX_SAMPLES_FIRMWARE`: an image with the route
 * - `DNX_SAMPLES_BASE`: the stock image's SHA-256, OS 1.11 when it is not set
 *
 * The card is blank, so the first part 0 makes the store. The firmware's writes stay in the
 * bridge's overlay. One boot serves every check, in order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { safeWriteSamplePart } from "@noiseandmatter/dnx-core/device/safewrite.js";
import {
  type RouteHost,
  deleteSample,
  hasSamplesRoute,
  readIndex,
  readInfo,
  uploadSample,
} from "@noiseandmatter/dnx-core/device/samplesroute.js";
import { buildPart, partBytes, sha256Hex, unhex } from "@noiseandmatter/dnx-core/sample/routerecords.js";

const EXE = process.env["DNX_SAMPLES_BRIDGE"];
const FIRMWARE = process.env["DNX_SAMPLES_FIRMWARE"];
const BASE = process.env["DNX_SAMPLES_BASE"] ?? "2af43e65e3d8390b41c9f66222620f8cce027d73ed87db00c80b440f628472e0";
const skip = !EXE || !FIRMWARE || bridgePaths({ exe: EXE, firmware: FIRMWARE }) === undefined
  ? "no /samples firmware: set DNX_SAMPLES_BRIDGE and DNX_SAMPLES_FIRMWARE"
  : false;

const TIMEOUT = 600_000;

/** A file in the native file's shape: a 64-byte header, int16 big-endian PCM, 16 zero bytes. */
function native(frames: number, seed: number): Uint8Array {
  const file = new Uint8Array(64 + 2 * frames + 16);
  file.fill(seed, 0, 64);
  const view = new DataView(file.buffer);
  for (let i = 0; i < frames; i++) view.setInt16(64 + 2 * i, (((i * 37 + seed * 101) % 2001) - 1000) * 16);
  return file;
}

test("the /samples route: send, resume, drop, delete", { skip, timeout: TIMEOUT * 2 }, async (t) => {
  const bridge = await EmulatorBridge.start({ exe: EXE!, firmware: FIRMWARE!, base: BASE, startupMs: TIMEOUT });
  const host: RouteHost = { transport: bridge, ids: new MessageIds(), gate: () => {}, timeoutMs: TIMEOUT };
  try {
    let partSize = 0;

    await t.test("the build has the route, and a blank card holds no sample", async () => {
      assert.equal(await hasSamplesRoute(host), true);
      const info = await readInfo(host);
      assert.equal(info.open, false);
      assert.equal(info.longest, 67_108_864);
      partSize = info.partSize;
      assert.equal(partSize, 524_288);
      assert.deepEqual((await readIndex(host)).rows, []);
    });

    const long = native(300_000, 4); // 600,080 bytes: two parts
    await t.test("a file of two parts is stored and listed with its id, length and path", async () => {
      const sent: number[] = [];
      const done = await uploadSample(host, { path: "samples/drums/Long", file: long, onProgress: (s) => sent.push(s) });
      assert.equal(done.kind, "stored");
      assert.deepEqual(sent, [partSize, long.length]);
      const rows = (await readIndex(host)).rows;
      assert.deepEqual(rows, [{ id: await sha256Hex(long), length: long.length, path: "samples/drums/Long" }]);
    });

    await t.test("the same file again sends nothing", async () => {
      const again = await uploadSample(host, { path: "samples/Other name", file: long });
      assert.deepEqual(again, { kind: "present", id: await sha256Hex(long), path: "samples/drums/Long" });
    });

    const resumed = native(270_000, 5); // two parts
    await t.test("a send that stopped after part 1 goes on at part 2", async () => {
      const id = unhex(await sha256Hex(resumed));
      const path = "samples/Again";
      await safeWriteSamplePart({
        transport: bridge,
        path: "/samples/0",
        bytes: buildPart({ part: 0, whole: resumed.length, id, path, bytes: partBytes(resumed, 0, partSize) }),
        gate: () => {},
        msgId: host.ids.reserve(32),
        timeoutMs: TIMEOUT,
      });
      const done = await uploadSample(host, { path, file: resumed });
      assert.equal(done.kind, "stored");
      assert.equal(done.kind === "stored" && done.resumedAt, 1);
    });

    const left = native(280_000, 6);
    const hat = native(700, 3);
    await t.test("an unfinished upload of another file is dropped, and the new file goes in", async () => {
      const id = unhex(await sha256Hex(left));
      await safeWriteSamplePart({
        transport: bridge,
        path: "/samples/0",
        bytes: buildPart({ part: 0, whole: left.length, id, path: "samples/Left", bytes: partBytes(left, 0, partSize) }),
        gate: () => {},
        msgId: host.ids.reserve(32),
        timeoutMs: TIMEOUT,
      });
      assert.equal((await readInfo(host)).open, true);
      const done = await uploadSample(host, { path: "samples/Hat", file: hat });
      assert.equal(done.kind, "stored");
      const paths = (await readIndex(host)).rows.map((row) => row.path).sort();
      assert.deepEqual(paths, ["samples/Again", "samples/Hat", "samples/drums/Long"]);
    });

    await t.test("a delete removes the file, and a second delete finds nothing", async () => {
      const id = await sha256Hex(hat);
      assert.equal(await deleteSample(host, id), true);
      assert.equal((await readIndex(host)).rows.some((row) => row.id === id), false);
      assert.equal(await deleteSample(host, id), false);
    });
  } finally {
    bridge.close();
  }
});
