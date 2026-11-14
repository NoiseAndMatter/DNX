/**
 * The bytes of the `/samples` route, against the firmware's contract (`for-dnx-samples.md`).
 *
 * The expected bytes are written out from the contract's tables, not built with the code under
 * test. The emulator test (`samplesroutebridge.test.ts`) checks the same bytes against the firmware.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CONTENT_KIND_SAMPLE_PART,
  buildPart,
  parseIndex,
  parseInfo,
  partBytes,
  partCount,
  sha256Hex,
  storePathProblem,
} from "@noiseandmatter/dnx-core/sample/routerecords.js";
import { HEADER_BYTES, buildContainer } from "@noiseandmatter/dnx-core/project/container.js";

const ID = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

test("a part is a raw container of kind 0x53 with the part record first", () => {
  const bytes = Uint8Array.of(9, 8, 7);
  const part = buildPart({ part: 2, whole: 1_100_000, id: ID, path: "samples/drums/Kick 909", bytes });
  assert.equal(part[0x0d + 3], CONTENT_KIND_SAMPLE_PART);
  assert.equal(part[0x1d], 0, "byte +29 says raw");
  assert.equal(new DataView(part.buffer).getUint32(0x15), 2, "the index is the part number");
  const body = part.subarray(HEADER_BYTES);
  assert.equal(String.fromCharCode(...body.subarray(0, 4)), "DKPT");
  const view = new DataView(body.buffer, body.byteOffset);
  assert.equal(view.getUint32(4), 1);
  assert.equal(view.getUint32(8), 2);
  assert.equal(view.getUint32(12), 1_100_000);
  assert.deepEqual([...body.subarray(16, 48)], [...ID]);
  assert.equal(String.fromCharCode(...body.subarray(48, 48 + 22)), "samples/drums/Kick 909");
  assert.ok(body.subarray(48 + 22, 256).every((b) => b === 0), "the path ends with zeros to +256");
  assert.deepEqual([...body.subarray(256, 259)], [9, 8, 7]);
});

test("every part but the last carries one part size", () => {
  const file = new Uint8Array(1_100_000);
  assert.equal(partCount(file.length, 524_288), 3);
  assert.equal(partBytes(file, 0, 524_288).length, 524_288);
  assert.equal(partBytes(file, 2, 524_288).length, 1_100_000 - 2 * 524_288);
});

test("a store path is ASCII, at most 159 characters, under samples/", () => {
  assert.equal(storePathProblem("samples/drums/Kick 909"), undefined);
  assert.ok(storePathProblem("drums/Kick"));
  assert.ok(storePathProblem(`samples/${"a".repeat(152)}`));
  assert.equal(storePathProblem(`samples/${"a".repeat(151)}`), undefined);
  assert.ok(storePathProblem("samples/Café"));
  assert.ok(storePathProblem("samples//Kick"));
  assert.ok(storePathProblem("samples/../Kick"));
});

/** A record in the route's container, as the firmware sends it. */
function record(body: Uint8Array): Uint8Array {
  return buildContainer({ body, contentKind: 0x53, objectVersion: 1, index: 0, formatVersion: "0059" });
}

test("info reads field by field from the contract's table", () => {
  const body = new Uint8Array(96);
  const view = new DataView(body.buffer);
  body[0] = 1;
  body[1] = 1;
  view.setUint16(2, 7);
  view.setUint32(4, 524_288);
  view.setUint32(8, 19_000_000);
  view.setUint32(12, 18_000_000);
  view.setUint32(16, 67_108_864);
  view.setUint32(20, 1_100_000);
  view.setUint32(24, 2);
  view.setUint32(28, 0xdeadbeef);
  view.setInt32(32, -57);
  view.setUint32(36, 41);
  body.set(ID, 40);
  view.setUint32(72, 9);
  const info = parseInfo(record(body));
  assert.deepEqual(info, {
    version: 1, open: true, files: 7, partSize: 524_288, storeKiB: 19_000_000, freeKiB: 18_000_000,
    longest: 67_108_864, whole: 1_100_000, next: 2, sum: 0xdeadbeef, result: -57, handled: 41,
    id: Buffer.from(ID).toString("hex"), sequence: 9,
  });
});

test("the index gives each row's id, length and path", () => {
  const body = new Uint8Array(8 + 2 * 200);
  const view = new DataView(body.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 2);
  body.set(ID, 8);
  view.setUint32(8 + 32, 1234);
  body.set(Buffer.from("samples/Kick"), 8 + 36);
  body.fill(0xab, 208, 240);
  view.setUint32(208 + 32, 99);
  body.set(Buffer.from("samples/drums/Snare"), 208 + 36);
  const index = parseIndex(record(body));
  assert.equal(index.files, 2);
  assert.deepEqual(index.rows, [
    { id: Buffer.from(ID).toString("hex"), length: 1234, path: "samples/Kick" },
    { id: "ab".repeat(32), length: 99, path: "samples/drums/Snare" },
  ]);
});

test("the id is the SHA-256 of the whole file", async () => {
  const file = Uint8Array.of(1, 2, 3);
  assert.equal(await sha256Hex(file), createHash("sha256").update(file).digest("hex"));
});
