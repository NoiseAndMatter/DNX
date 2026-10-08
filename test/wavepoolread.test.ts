/**
 * Reading a pool and the store together, which is the whole reason this is one function.
 *
 * MISSING is a claim about two readings at once: *this entry names a slot that is empty now*. From
 * a listing taken minutes ago it is wrong in both directions — a table uploaded since looks
 * deleted, one deleted since looks present — so the test that matters here is that both readings
 * come from the same call, in order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { readPool, readStoreListing } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { buildPoolFile } from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { INDEX_ENTRIES } from "@noiseandmatter/dnx-core/waverider/layout.js";

const put32 = (b: Uint8Array, at: number, v: number): void => {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
};

/** A `/waverider` listing: 256 file entries, named ones in use. */
function storeListing(used: Record<number, string>): Uint8Array {
  const out: number[] = [1];
  const push32 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  push32(0);
  push32(INDEX_ENTRIES + 1);
  push32(INDEX_ENTRIES);
  for (let slot = 0; slot < INDEX_ENTRIES; slot++) {
    const name = used[slot];
    for (const ch of name ?? "") out.push(ch.charCodeAt(0));
    // name NUL, kind 00 (a file), layout 02 (index, size, permissions, occupancy)
    out.push(0, 0x00, 0x02);
    push32(slot);
    // Every slot reports the fixed 512 KiB extent, which is why geometry is not in a listing.
    push32(524_288);
    out.push(0x00, 0x7e, name === undefined ? 0 : 1, name === undefined ? 0 : 1);
  }
  return Uint8Array.from(out);
}

function device(file: Uint8Array, used: Record<number, string>): ApiTransport & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      asked.push(code);
      const reply = (bytes: Uint8Array): Promise<ApiFrame> =>
        Promise.resolve({
          msgId, respId: msgId, code: code | RESPONSE_BIT, body: bytes,
          isResponse: true, terminated: true,
        });

      switch (code) {
        case StorageCode.List:
          return reply(storeListing(used));
        case StorageCode.Open:
          return reply(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 8, 0, 1));
        case StorageCode.Read: {
          const sequence = (body[4]! << 24) | (body[5]! << 16) | (body[6]! << 8) | body[7]!;
          const data = sequence === 0 ? new Uint8Array(0) : file;
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
  };
}

test("the pool and the store arrive together, and the join names the missing table", async () => {
  // The record names slots 9 and 20; the store holds 9 and not 20, so pool slot 2 plays Prim.
  const file = buildPoolFile({
    projectSlot: 4,
    automatic: false,
    entries: [9, 20],
    generation: 7,
  });
  const io = device(file, { 9: "HS SAW" });

  const reading = await readPool({
    transport: io,
    ids: new MessageIds(),
    projectSlot: 4,
    timeoutMs: 1_000,
  });

  assert.equal(reading.summary.tables, 1);
  assert.equal(reading.summary.missing, 1);
  assert.equal(reading.summary.cells[1]?.state, "missing");
  assert.equal(reading.summary.cells[0]?.name, "HS SAW");
  assert.equal(reading.unlisted, 0, "all 256 slots came back");

  // **The listing first, then the record.** A failure between the two must not leave a file handle
  // open while another request goes out, and the pair is what makes MISSING a claim about now.
  assert.equal(io.asked[0], StorageCode.List);
  assert.ok(io.asked.includes(StorageCode.Open));
  assert.ok(io.asked.includes(StorageCode.Close), "and the handle is released");
});

test("the listing gives names and occupancy, and says nothing about geometry", async () => {
  const io = device(new Uint8Array(0), { 0: "BASIC SINE", 46: "QUANT NOISE" });
  const store = await readStoreListing(io, new MessageIds(), 1_000);

  assert.equal(store.length, INDEX_ENTRIES);
  assert.deepEqual(store[0], { slot: 0, name: "BASIC SINE", occupied: true });
  assert.deepEqual(store[1], { slot: 1, occupied: false });
  assert.equal(store[46]?.name, "QUANT NOISE");
  // Nothing here carries a size: every slot reports the same 512 KiB extent, so a size on a row
  // would be a number that looks like information and is not.
  assert.ok(!("size" in (store[0] ?? {})));
});
