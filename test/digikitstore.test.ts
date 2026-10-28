/**
 * The DNX side of the digikit store store client: the transport and the vendored converter.
 *
 * The protocol itself runs against digikit's emulator, from `scripts/digikit-emu-store.mjs`, because
 * only the runtime can answer it. Here the WAV is built by hand and the expected header comes from
 * digikit's format note, not from the converter.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SysexPort } from "@noiseandmatter/dnx-core/device/port.js";
import { dkTransport, hexSha256, loadConverter, prepareWav } from "@noiseandmatter/dnx-core/sample/digikitstore.js";

function fakePort(): SysexPort & { deliver(bytes: number[]): void; sent: Uint8Array[] } {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const sent: Uint8Array[] = [];
  return {
    sent,
    send: (bytes) => void sent.push(bytes),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    deliver: (bytes) => listeners.forEach((l) => l(Uint8Array.from(bytes))),
    close: () => listeners.clear(),
  };
}

const DK = [0xf0, 0x7d, 0x64, 0x6b, 0x01];

test("the transport passes digikit messages and ignores every other one", async () => {
  const port = fakePort();
  const t = dkTransport(port);
  port.deliver([0xf0, 0x00, 0x20, 0x3c, 0x10, 0xf7]);
  port.deliver([...DK, 0x41, 0x05, 0x00, 0xf7]);
  assert.deepEqual([...(await t.recv(100))!], [...DK, 0x41, 0x05, 0x00, 0xf7]);
  assert.equal(await t.recv(20), null, "the Elektron message was dropped");
  t.close();
});

test("a message that arrives while recv waits goes to that wait", async () => {
  const port = fakePort();
  const t = dkTransport(port);
  const pending = t.recv(1000);
  port.deliver([...DK, 0x42, 0x01, 0x00, 0xf7]);
  assert.equal((await pending)![5], 0x42);
  t.close();
  port.deliver([...DK, 0x42, 0x02, 0x00, 0xf7]);
  assert.equal(await t.recv(20), null, "close drops the listener");
});

/** A 48 kHz stereo 16-bit WAV of `frames` frames, every sample `value`. */
function wav(frames: number, value: number): Uint8Array {
  const data = frames * 4;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  v.setUint32(4, 36 + data, true);
  b.set([..."WAVEfmt "].map((c) => c.charCodeAt(0)), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 48_000, true);
  v.setUint32(28, 192_000, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  b.set([..."data"].map((c) => c.charCodeAt(0)), 36);
  v.setUint32(40, data, true);
  for (let i = 0; i < frames * 2; i++) v.setInt16(44 + 2 * i, value, true);
  return b;
}

test("the converter writes the DT2 native file: 64-byte header, BE PCM, 16-byte zero trailer", async () => {
  const converter = await loadConverter(readFileSync("web/vendor/dksample.wasm"));
  const f = prepareWav(converter, "tone.wav", wav(4800, 0x1234));
  assert.equal(f.name, "tone");
  assert.equal(f.stored.length, 0x40 + 19_200 + 16);
  const v = new DataView(f.stored.buffer, f.stored.byteOffset, f.stored.length);
  assert.equal(f.stored[1], 1, "stereo flag");
  assert.equal(v.getUint32(4), 19_200, "PCM length");
  assert.equal(v.getUint32(8), 48_000, "rate");
  assert.equal(f.stored[0x14], 0x7f);
  assert.deepEqual([...f.stored.subarray(0x40, 0x44)], [0x12, 0x34, 0x12, 0x34], "big-endian PCM, interleaved");
  assert.ok(f.stored.subarray(-16).every((b) => b === 0), "zero trailer");
  assert.equal((await hexSha256(f.stored)).length, 64);
});
