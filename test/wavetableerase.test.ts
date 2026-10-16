/**
 * The erase's safety order, against a scripted +Drive, so it runs on every `npm test`.
 *
 * `wavetableerasebridge.test.ts` proves the erase on the firmware, and skips without the image.
 * This proves the order that makes the erase a two-way door: every table and every pool list is
 * handed to the backup hook **before** the question, a copy that fails stops the run, and a "no"
 * sends nothing. A refactor that moved the copying after the question, or swallowed a failed
 * copy, would pass every test that only checks the request bytes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { type Backup } from "@noiseandmatter/dnx-core/device/safewrite.js";
import { eraseWavetableStore } from "@noiseandmatter/dnx-core/device/wavetableerase.js";

const WRITES: readonly number[] = [StorageCode.WriteOpen, StorageCode.Write, StorageCode.WriteClose, StorageCode.Delete];

function push32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

/** A listing reply in the layout `parseListing` reads: file entries, occupied or not. */
function listing(entries: { name: string; index: number; occupied: boolean }[]): Uint8Array {
  const parts: number[] = [1];
  push32(parts, 0);
  push32(parts, entries.length + 1);
  push32(parts, entries.length);
  for (const e of entries) {
    for (const ch of e.name) parts.push(ch.charCodeAt(0));
    parts.push(0, 0x00, 0x02);
    push32(parts, e.index);
    push32(parts, 512);
    parts.push(0x00, 0x12, e.occupied ? 1 : 0, e.occupied ? 1 : 0);
  }
  return Uint8Array.from(parts);
}

/** One chunk carrying the whole file, flagged last. */
function chunk(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(22 + data.length);
  out.set([1, 0, 0, 0, 1], 0);
  out.set([0, 0, 0, 1], 5);
  out[13] = 1;
  const length: number[] = [];
  push32(length, data.length);
  out.set(length, 18);
  out.set(data, 22);
  return out;
}

/**
 * A +Drive with two tables (slots 3 and 9) and one pool list (project slot 5). Every file reads
 * back as a few bytes naming its own path, so a copy can be traced to what it copied.
 */
function drive(): ApiTransport & { sent: number[]; opened: string[] } {
  const sent: number[] = [];
  const opened: string[] = [];
  const text = (body: Uint8Array): string => new TextDecoder().decode(body).replace(/\0.*$/s, "");
  let open = "";
  return {
    sent,
    opened,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      sent.push(code);
      let reply: Uint8Array;
      if (code === StorageCode.List) {
        const path = text(body);
        reply = path === "/waverider"
          ? listing([{ name: "PAD", index: 3, occupied: true }, { name: "", index: 4, occupied: false }, { name: "SAW", index: 9, occupied: true }])
          : listing([{ name: "", index: 0, occupied: false }, { name: "5", index: 5, occupied: true }]);
      } else if (code === StorageCode.Open) {
        open = text(body);
        opened.push(open);
        reply = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 8, 0, 1]);
      } else if (code === StorageCode.Read) {
        reply = chunk(new TextEncoder().encode(open));
      } else if (code === StorageCode.Close) {
        reply = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 0x81]);
      } else {
        return Promise.reject(new Error(`the fake drive does not answer 0x${code.toString(16)}`));
      }
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body: reply, isResponse: true, terminated: true });
    },
  };
}

test("every table and every pool list is copied before the question, and a no sends nothing", async () => {
  const io = drive();
  const backups: Backup[] = [];
  let askedAfter = -1;

  const result = await eraseWavetableStore({
    transport: io,
    host: {
      ids: new MessageIds(),
      gate: () => {},
      confirm: async (review) => {
        askedAfter = backups.length;
        assert.deepEqual([review.tables, review.lists], [2, 1]);
        return false;
      },
    },
    onBackup: (backup) => { backups.push(backup); },
  });

  assert.deepEqual(backups.map((b) => b.name), ["waverider-3-PAD.bin", "waverider-9-SAW.bin", "wavepool-5.bin"]);
  assert.equal(new TextDecoder().decode(backups[2]!.bytes), "/wavepool/5", "the pool copy is the pool's bytes");
  assert.equal(askedAfter, 3, "the question comes after every copy");
  assert.equal(result.cancelled, true);
  assert.deepEqual(io.sent.filter((code) => WRITES.includes(code)), [], "a no sends nothing");
});

test("a copy that cannot be saved stops the run before the question", async () => {
  const io = drive();
  let asked = false;
  await assert.rejects(
    eraseWavetableStore({
      transport: io,
      host: { ids: new MessageIds(), gate: () => {}, confirm: async () => { asked = true; return true; } },
      onBackup: (backup) => {
        if (backup.name.startsWith("wavepool-")) throw new Error("the folder is gone");
      },
    }),
    /the folder is gone/,
  );
  assert.equal(asked, false, "nobody may be asked about an erase whose copies are incomplete");
  assert.deepEqual(io.sent.filter((code) => WRITES.includes(code)), []);
});

test("the WRITE switch is checked before the instrument is asked anything", async () => {
  const io = drive();
  await assert.rejects(
    eraseWavetableStore({
      transport: io,
      host: { ids: new MessageIds(), gate: () => { throw new Error("WRITE is off"); }, confirm: async () => true },
      onBackup: () => {},
    }),
    /WRITE is off/,
  );
  assert.deepEqual(io.sent, []);
});
