/**
 * `backupDevice`, run against a scripted +Drive rather than read as text.
 *
 * `backup.test.ts` checks what a backup file looks like. This checks what a backup **does** when
 * the drive misbehaves: one bad slot is recorded and skipped, a drive that stops answering ends
 * the run with what was read, the misses travel in the manifest, and a name with a backslash
 * cannot make a folder.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { type ConnectedDevice } from "@noiseandmatter/dnx-core/device/identify.js";
import { BackupError, backupDevice } from "@noiseandmatter/dnx-core/device/backup.js";

function push32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function listing(entries: { name: string; index: number }[]): Uint8Array {
  const parts: number[] = [1];
  push32(parts, 0);
  push32(parts, entries.length + 1);
  push32(parts, entries.length);
  for (const e of entries) {
    for (const ch of e.name) parts.push(ch.charCodeAt(0));
    parts.push(0, 0x00, 0x02);
    push32(parts, e.index);
    push32(parts, 1024);
    parts.push(0x00, 0x12, 1, 1);
  }
  return Uint8Array.from(parts);
}

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
 * A Digitone II +Drive. `projects` and `sounds` say what is listed. A path in `bad` refuses to
 * open, and once `deadAfter` files have been opened, nothing answers at all.
 */
function drive(options: {
  projects: { name: string; index: number }[];
  sounds?: { name: string; index: number }[];
  bad?: string[];
  deadAfter?: number;
}): ConnectedDevice & { opened: string[] } {
  const opened: string[] = [];
  const text = (body: Uint8Array): string => new TextDecoder().decode(body).replace(/\0.*$/s, "");
  let open = "";
  const api = {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      let reply: Uint8Array;
      if (code === StorageCode.List) {
        const path = text(body);
        reply = path === "/" ? listing([{ name: "projects", index: 0 }, { name: "soundbanks", index: 1 }])
          : path === "/projects" ? listing(options.projects)
          : path === "/soundbanks/A" ? listing(options.sounds ?? [])
          : listing([]);
      } else if (code === StorageCode.Open) {
        open = text(body);
        if (options.deadAfter !== undefined && opened.length >= options.deadAfter) {
          return Promise.reject(new Error("no reply"));
        }
        if (options.bad?.includes(open)) return Promise.reject(new Error(`cannot open ${open}`));
        opened.push(open);
        reply = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 8, 0, 1]);
      } else if (code === StorageCode.Read) {
        reply = chunk(new TextEncoder().encode(open));
      } else if (code === StorageCode.Close) {
        reply = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 0x81]);
      } else {
        return Promise.reject(new Error(`unexpected 0x${code.toString(16)}`));
      }
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body: reply, isResponse: true, terminated: true });
    },
  };
  return { productId: 0x15, name: "Elektron Digitone II", api, close: () => {}, opened } as unknown as ConnectedDevice & { opened: string[] };
}

const projects = (n: number): { name: string; index: number }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, index: i + 1 }));

test("one slot that fails is recorded in the manifest, and the rest is read", async () => {
  const device = drive({ projects: projects(3), bad: ["/projects/2"] });
  const { backup, failed } = await backupDevice(device, { ids: new MessageIds() });

  assert.deepEqual(backup.manifest.entries.map((e) => e.source), ["/projects/1", "/projects/3"]);
  assert.deepEqual(failed.map((f) => f.source), ["/projects/2"]);
  assert.deepEqual(backup.manifest.failed?.map((f) => [f.source, f.name]), [["/projects/2", "P2"]],
    "the miss must travel in the file, not only in a status line");
});

test("a drive that stops answering ends the run with what was read", async () => {
  // The cable comes out after the second file. Without a limit, each of the other 38 items cost
  // two timeouts on a real port, and nothing was saved until the last one.
  const device = drive({ projects: projects(40), deadAfter: 2 });
  const { backup, failed } = await backupDevice(device, { ids: new MessageIds() });

  assert.deepEqual(backup.manifest.entries.map((e) => e.name), ["P1", "P2"]);
  assert.equal(failed.length, 38, "every slot after the cut is recorded as not read");
  assert.match(failed[failed.length - 1]!.why, /the instrument stopped answering \(3 reads in a row failed\)/);
  assert.equal(device.opened.length, 2);
});

test("stopping records what was left as not read", async () => {
  let reads = 0;
  const device = drive({ projects: projects(5) });
  const { backup, failed } = await backupDevice(device, { ids: new MessageIds() }, {
    shouldStop: () => reads++ >= 2,
  });
  assert.equal(backup.manifest.entries.length, 2);
  assert.deepEqual(failed.map((f) => f.why), Array(3).fill("the backup was stopped before it was read"));
});

test("a name a folder separator would split stays one file name", async () => {
  const slash = String.fromCharCode(92); // a backslash
  const device = drive({ projects: [{ name: `A${slash}B`, index: 4 }], sounds: [{ name: `C/D${slash}E`, index: 1 }] });
  const { backup } = await backupDevice(device, { ids: new MessageIds() });
  assert.deepEqual(backup.manifest.entries.map((e) => e.file), ["projects/004 A-B.payload", "soundbanks/A/001 C-D-E.dn2snd"]);
});

test("an empty drive is refused, with nothing to save", async () => {
  await assert.rejects(backupDevice(drive({ projects: [] }), { ids: new MessageIds() }), BackupError);
});
