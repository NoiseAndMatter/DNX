import assert from "node:assert/strict";
import { CORPUS } from "./corpus.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildMessage,
  isChecksumValid,
  isLengthValid,
  parseFile,
  rebuildMessage,
} from "../src/sysex/container.js";
import { DumpType, ProductId } from "../src/sysex/devices.js";

const EXAMPLES = CORPUS ?? "";

function syxFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...syxFilesUnder(path));
    else if (entry.name.toLowerCase().endsWith(".syx")) out.push(path);
  }
  return out;
}

test("buildMessage and parseMessage round-trip a synthetic payload", () => {
  const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
  const raw = buildMessage({
    productId: ProductId.DN1,
    dumpType: DumpType.SOUND,
    payload,
    objNr: 42,
  });
  const [msg] = parseFile(raw);
  assert.ok(msg);
  assert.equal(msg.productId, ProductId.DN1);
  assert.equal(msg.dumpType, DumpType.SOUND);
  assert.equal(msg.objNr, 42);
  assert.deepEqual(msg.payload, payload);
  assert.ok(isChecksumValid(msg));
  assert.ok(isLengthValid(msg));
});

test("the length field wraps at 14 bits for large dumps", () => {
  // A DN2 pattern is ~114 KB; its true length cannot fit in 14 bits.
  const raw = buildMessage({
    productId: ProductId.DN2,
    dumpType: DumpType.PATTERN_KIT,
    payload: new Uint8Array(99_840),
  });
  const [msg] = parseFile(raw);
  assert.ok(msg);
  assert.equal(raw.length, 114_118, "should reproduce the observed DN2 wire size");
  assert.ok(raw.length - 10 > 0x3fff, "true length must exceed the 14-bit field");
  assert.equal(msg.storedLength, (raw.length - 10) & 0x3fff);
  assert.ok(isLengthValid(msg));
});

const realFiles = syxFilesUnder(EXAMPLES);

test("real .syx files parse with valid checksum and length", { skip: realFiles.length === 0 }, () => {
  let messages = 0;
  for (const path of realFiles) {
    for (const msg of parseFile(new Uint8Array(readFileSync(path)))) {
      assert.ok(isChecksumValid(msg), `${path} msg ${msg.index}: checksum mismatch`);
      assert.ok(isLengthValid(msg), `${path} msg ${msg.index}: length mismatch`);
      messages++;
    }
  }
  assert.ok(messages > 0, "expected at least one message across the example files");
});

test("real .syx files re-encode byte-for-byte", { skip: realFiles.length === 0 }, () => {
  for (const path of realFiles) {
    const data = new Uint8Array(readFileSync(path));
    for (const msg of parseFile(data)) {
      const original = data.subarray(msg.fileOffset, msg.fileOffset + msg.byteLength);
      assert.deepEqual(rebuildMessage(msg), original, `${path} msg ${msg.index} is not byte-identical`);
    }
  }
});
