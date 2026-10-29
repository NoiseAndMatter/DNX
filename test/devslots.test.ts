/**
 * The diagnostics capture: which numbers it reads, what it refuses before sending anything, and
 * what the zip holds.
 *
 * The block numbers are written out here from the spec's formula (`dn2_firmware/docs/
 * for-dnx-devslots.md` rev 2), not computed with `blockFile`, so a wrong formula in the module
 * cannot agree with itself. The device is a script: it answers a root listing, and any open with a
 * file whose first byte names the path, so a read of the wrong path shows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import {
  DevslotsError,
  NEEDS_DIAGNOSTIC_FIRMWARE,
  blockOf,
  captureDevslots,
  captureEntryName,
  captureFileName,
  parseBlockList,
} from "@noiseandmatter/dnx-core/device/devslots.js";
import { packCapture } from "../web/src/devslotspack.js";
import { readZip } from "../web/src/zip.js";

const put32 = (b: Uint8Array, at: number, v: number): void => {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
};

function rootListing(names: readonly string[]): Uint8Array {
  const out: number[] = [1];
  const push32 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  push32(0);
  push32(names.length + 1);
  push32(names.length);
  for (const name of names) {
    for (const ch of name) out.push(ch.charCodeAt(0));
    out.push(0, 0x01, 0x01);
    push32(128);
  }
  return Uint8Array.from(out);
}

/** What the scripted device serves for a path: the path's text, so a test can see which one it got. */
const served = (path: string): Uint8Array => new TextEncoder().encode(`file ${path}`);

function device(roots: readonly string[]): ApiTransport & { opened: string[]; listed: number } {
  const state = { opened: [] as string[], listed: 0 };
  let open = "";
  return Object.assign(state, {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      const reply = (bytes: Uint8Array): Promise<ApiFrame> =>
        Promise.resolve({
          msgId, respId: msgId, code: code | RESPONSE_BIT, body: bytes,
          isResponse: true, terminated: true,
        });
      switch (code) {
        case StorageCode.List:
          state.listed += 1;
          return reply(rootListing(roots));
        case StorageCode.Open: {
          open = /\/[a-z]+\/\d+/.exec(new TextDecoder("latin1").decode(body))![0];
          state.opened.push(open);
          return reply(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 8, 0, 1));
        }
        case StorageCode.Read: {
          const sequence = (body[4]! << 24) | (body[5]! << 16) | (body[6]! << 8) | body[7]!;
          const data = sequence === 0 ? new Uint8Array(0) : served(open);
          const out = new Uint8Array(22 + data.length);
          out[0] = 1;
          put32(out, 1, 1);
          put32(out, 5, sequence === 0 ? 0 : 1);
          out[13] = sequence === 0 ? 0 : 1;
          put32(out, 18, data.length);
          out.set(data, 22);
          return reply(out);
        }
        default:
          return reply(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0));
      }
    },
  });
}

const DIAGNOSTIC = ["projects", "soundbanks", "kits", "waverider", "wavepool", "modinfo", "devslots"];

test("block numbers: 1000 + source x 256 + block, three sources, 197 blocks", () => {
  assert.deepEqual(blockOf(1000), { source: 0, block: 0 });
  assert.deepEqual(blockOf(1196), { source: 0, block: 196 });
  assert.deepEqual(blockOf(1256), { source: 1, block: 0 });
  assert.deepEqual(blockOf(1708), { source: 2, block: 196 });
  // The gaps between sources, the fourth source, and the six listed files are not blocks.
  for (const file of [999, 1197, 1255, 1709, 1768, 0, 5]) assert.equal(blockOf(file), undefined);
});

test("a pasted list: separators, repeats, and a refusal of the whole list for one bad number", () => {
  assert.deepEqual(parseBlockList("1000, 1256,1512\n1000"), [1000, 1256, 1512]);
  assert.throws(() => parseBlockList("1000, 1197"), DevslotsError);
  assert.throws(() => parseBlockList("1000, -3"), DevslotsError);
  assert.throws(() => parseBlockList("0x3e8"), DevslotsError);
  assert.throws(() => parseBlockList("  "), DevslotsError);
  const seventeen = Array.from({ length: 17 }, (_, i) => 1000 + i).join(" ");
  assert.throws(() => parseBlockList(seventeen), /more than 16/);
  assert.equal(parseBlockList(Array.from({ length: 16 }, (_, i) => 1000 + i).join(" ")).length, 16);
});

test("a build without the root: refused after the listing, before any file is opened", async () => {
  const unit = device(["projects", "soundbanks", "kits", "waverider", "wavepool", "modinfo"]);
  await assert.rejects(
    captureDevslots({ transport: unit, ids: new MessageIds(), files: [0, 1] }),
    (error: Error) => error instanceof DevslotsError && error.message === NEEDS_DIAGNOSTIC_FIRMWARE,
  );
  assert.equal(unit.listed, 1);
  assert.deepEqual(unit.opened, []);
});

test("a diagnostic build: /modinfo/0 first, then each file in order, each timed", async () => {
  const unit = device(DIAGNOSTIC);
  let clock = 0;
  const files = await captureDevslots({
    transport: unit,
    ids: new MessageIds(),
    files: [0, 1, 2, 3, 4, 5],
    now: () => (clock += 10),
  });
  assert.deepEqual(unit.opened, [
    "/modinfo/0", "/devslots/0", "/devslots/1", "/devslots/2", "/devslots/3", "/devslots/4",
    "/devslots/5",
  ]);
  for (const file of files) {
    assert.deepEqual(file.bytes, served(file.path));
    assert.equal(file.ms, 10);
  }
});

test("entry and zip names", () => {
  assert.equal(captureEntryName("/modinfo/0"), "modinfo_0.bin");
  assert.equal(captureEntryName("/devslots/3"), "devslots_3_crc-40000.bin");
  assert.equal(captureEntryName("/devslots/1512"), "devslots_1512_ram_block-0.bin");
  const taken = new Date(2026, 9, 29, 14, 7);
  assert.equal(captureFileName(taken, 0x0ddba11, false), "dn2-diagnostics_20261029-1407_00ddba11.zip");
  assert.equal(captureFileName(taken, undefined, true), "dn2-diagnostics-blocks_20261029-1407_unknown.zip");
});

test("the zip: every file byte for byte, and a manifest that hashes each", async () => {
  const unit = device(DIAGNOSTIC);
  const files = await captureDevslots({ transport: unit, ids: new MessageIds(), files: [0, 1000] });
  const packed = await packCapture(files, { name: "Digitone II", firmwareVersion: "1.11" }, "blocks",
    new Date(2026, 9, 29, 14, 7));

  // The scripted record is not a mod-info record, so the image id is unknown and the reason kept.
  assert.equal(packed.name, "dn2-diagnostics-blocks_20261029-1407_unknown.zip");
  assert.ok("error" in packed.manifest.modinfo);

  const zip = await readZip(packed.bytes);
  assert.deepEqual([...zip.keys()], [
    "modinfo_0.bin", "devslots_0_slot-40000.bin", "devslots_1000_slot-40000_block-0.bin",
    "manifest.json",
  ]);
  assert.deepEqual(zip.get("devslots_1000_slot-40000_block-0.bin"), served("/devslots/1000"));

  const manifest = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")));
  assert.equal(manifest.instrument.os, "1.11");
  // SHA-256 of "file /devslots/0", from outside the module: `printf 'file /devslots/0' | sha256sum`.
  const slot0 = manifest.files.find((f: { path: string }) => f.path === "/devslots/0");
  assert.equal(slot0.sha256, SLOT0_SHA256);
  assert.equal(slot0.bytes, 16);
});

const SLOT0_SHA256 = "073e56b48c2a649e4c315d11b2265c7368342e83d65cea1bf666353a28e5e05e";
