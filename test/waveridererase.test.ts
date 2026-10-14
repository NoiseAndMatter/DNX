/**
 * The erase request's bytes, and the capability that decides whether the control exists.
 *
 * **The one message in DNX where getting a field wrong destroys everything it addresses.** The
 * firmware checks the hash and the two counts and refuses silently if any of them is off, so a
 * wrong byte here is not a crash — it is a button that appears to do nothing, which somebody then
 * presses again. These assert the layout against the contract in
 * `dn2_firmware/docs/for-dnx-waverider-erase.md` rather than against our own builder.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ERASE,
  ERASE_MAGIC,
  ERASE_SLOT,
  ERASE_VERSION,
  buildEraseRequest,
} from "@noiseandmatter/dnx-core/waverider/erasefile.js";
import { CONTENT_KIND_POOL, POOL_FORMAT_VERSION } from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { HEAD, HEADER_BYTES } from "@noiseandmatter/dnx-core/project/container.js";

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** The 512-byte record inside the container. */
const body = (file: Uint8Array): Uint8Array => file.subarray(HEADER_BYTES, HEADER_BYTES + 512);

test("the request is a pool-shaped container addressed to 129", () => {
  const file = buildEraseRequest({ tables: 83, lists: 4 });

  // It travels as a pool list does, because the route is the same. 31 + 512 + 12.
  assert.equal(file.length, 555);
  assert.equal(be32(file, HEAD.contentKind), CONTENT_KIND_POOL);
  assert.equal(be32(file, HEAD.objectVersion), POOL_FORMAT_VERSION);
  assert.equal(ERASE_SLOT, 129, "`/wavepool` lists 0..128; the control is the one past the end");
  assert.equal(be32(file, HEAD.index), ERASE_SLOT);
});

test("the body is WRER, version 1, and the two counts the user was shown", () => {
  const file = buildEraseRequest({ tables: 83, lists: 4 });
  const record = body(file);

  assert.deepEqual([...record.subarray(ERASE.magic, ERASE.magic + 4)], [...ERASE_MAGIC]);
  assert.deepEqual([...ERASE_MAGIC], [0x57, 0x52, 0x45, 0x52], "WRER");
  assert.equal(be16(record, ERASE.version), ERASE_VERSION);
  assert.equal(be16(record, ERASE.reserved), 0);
  assert.equal(be32(record, ERASE.tables), 83);
  assert.equal(be32(record, ERASE.lists), 4);

  // Everything between the counts and the hash is zero, which the firmware checks.
  for (let at = 16; at < ERASE.hash; at++) {
    assert.equal(record[at], 0, `byte ${at} is reserved and must be zero`);
  }
});

test("the hash covers bytes 0..507 and is computed, never passed", () => {
  const file = buildEraseRequest({ tables: 1, lists: 2 });
  const record = body(file);
  assert.equal(be32(record, ERASE.hash), xxHash32(record.subarray(0, ERASE.hash)));

  // And it moves with the counts: two requests that differ only in a count must not share a hash,
  // or the firmware's check of them would be checking nothing.
  const other = body(buildEraseRequest({ tables: 2, lists: 2 }));
  assert.notEqual(be32(record, ERASE.hash), be32(other, ERASE.hash));
});

test("zero and zero is a legal request, because it finishes an interrupted erase", () => {
  /*
   * A power loss between the metadata write and the TRIM leaves the store reading empty with
   * unreferenced bytes behind it. The counts are then 0 and 0, and repeating the request is how
   * the TRIM completes. Refusing it here would strand exactly the instrument that needs it.
   */
  const file = buildEraseRequest({ tables: 0, lists: 0 });
  assert.equal(file.length, 555);
  assert.equal(be32(body(file), ERASE.tables), 0);
  assert.equal(be32(body(file), ERASE.lists), 0);
});

test("a count that is not a count is refused rather than sent", () => {
  for (const bad of [-1, 1.5, Number.NaN, 2 ** 32]) {
    assert.throws(() => buildEraseRequest({ tables: bad, lists: 0 }), WaveriderError, `tables ${bad}`);
    assert.throws(() => buildEraseRequest({ tables: 0, lists: bad }), WaveriderError, `lists ${bad}`);
  }
});
