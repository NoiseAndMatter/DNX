/**
 * The diagnostics capture against the firmware itself, in the emulator.
 *
 * Needs `DNX_DEVSLOTS_FIRMWARE` (a `devslotsfull` build) and the bridge variables, and uses
 * `DNX_EMU_FIRMWARE` (stock) as the control. See `docs/emulator-tests.md`.
 *
 * The card is blank, so the slots hold zeros and RAM holds the defaults. What this proves is the
 * shape the route answers in and that DNX asks for it correctly: six files of the sizes the spec
 * gives, block files of 64 KiB and the shorter last one, and a CRC table that agrees with the
 * blocks it describes. The bytes of a real unit are checked on the unit.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import {
  DevslotsError,
  NEEDS_DIAGNOSTIC_FIRMWARE,
  captureDevslots,
} from "@noiseandmatter/dnx-core/device/devslots.js";
import {
  SETTINGS_FILES,
  SETTING_FIELDS,
  fieldValue,
  readSettingsFile,
  settingsFromCapture,
} from "@noiseandmatter/dnx-core/device/devsettings.js";

const DEVSLOTS = process.env["DNX_DEVSLOTS_FIRMWARE"];
const skip = !bridgePaths()
  ? "no emulator configured: see docs/emulator-tests.md"
  : !DEVSLOTS
    ? "no diagnostics firmware: set DNX_DEVSLOTS_FIRMWARE alongside the bridge variables"
    : false;

const TIMEOUT = 240_000;
const open = new Set<EmulatorBridge>();
after(async () => {
  for (const io of open) await io.close();
});

/** The container's header and trailer around each body. */
const WRAP = 31 + 12;

test("a devslots build: six files, block files, and a CRC table that matches its blocks", { skip, timeout: 4 * TIMEOUT }, async () => {
  const io = await EmulatorBridge.start({ firmware: DEVSLOTS!, startupMs: TIMEOUT });
  open.add(io);
  const files = await captureDevslots({
    transport: io,
    ids: new MessageIds(),
    files: [0, 1, 2, 3, 4, 5, 1000, 1196, 1512],
    // The emulator computes a CRC file far slower than the unit's 3 to 4 s, and the 30 s the
    // bridge allows by default ran out on the first run.
    timeoutMs: 300_000,
  });

  assert.deepEqual(files.map((f) => f.path), [
    "/modinfo/0", "/devslots/0", "/devslots/1", "/devslots/2", "/devslots/3", "/devslots/4",
    "/devslots/5", "/devslots/1000", "/devslots/1196", "/devslots/1512",
  ]);
  const size = Object.fromEntries(files.map((f) => [f.path, f.bytes.length]));
  for (const n of [0, 1, 2]) assert.equal(size[`/devslots/${n}`], 272 + WRAP);
  for (const n of [3, 4, 5]) assert.equal(size[`/devslots/${n}`], 788 + WRAP);
  assert.equal(size["/devslots/1000"], 65_536 + WRAP);
  assert.equal(size["/devslots/1196"], 45_332 + WRAP);
  for (const file of files) assert.equal(file.closed, true, `${file.path} closed`);

  // crc-ram's first entry is the CRC-32 of RAM's block 0, by node's own zlib rather than DNX's.
  const table = files.find((f) => f.path === "/devslots/5")!.bytes.subarray(31, 31 + 788);
  const first = new DataView(table.buffer, table.byteOffset, 4).getUint32(0);
  const block = files.find((f) => f.path === "/devslots/1512")!.bytes.subarray(31, 31 + 65_536);
  assert.equal(first, crc32(block));
});

test("a devslots build: the settings backup reads the running header", { skip, timeout: TIMEOUT }, async () => {
  const io = await EmulatorBridge.start({ firmware: DEVSLOTS!, startupMs: TIMEOUT });
  open.add(io);
  const files = await captureDevslots({ transport: io, ids: new MessageIds(), files: SETTINGS_FILES });
  const file = settingsFromCapture(files, {
    taken: new Date(),
    dnx: "test",
    instrument: { name: "emulator", os: null },
  });
  assert.equal(file.osBuild, "0059");
  const { header } = readSettingsFile(JSON.stringify(file));
  const usb = SETTING_FIELDS.find((f) => f.option === "SYSTEM > USB CONFIG")!;
  assert.doesNotMatch(fieldValue(header, usb).text, /not named/);
});

test("stock firmware: refused before any file is opened", { skip, timeout: TIMEOUT }, async () => {
  const io = await EmulatorBridge.start({ startupMs: TIMEOUT });
  open.add(io);
  await assert.rejects(
    captureDevslots({ transport: io, ids: new MessageIds(), files: [0] }),
    (error: Error) => error instanceof DevslotsError && error.message === NEEDS_DIAGNOSTIC_FIRMWARE,
  );
});
