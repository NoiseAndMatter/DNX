/**
 * The 128-byte body that renames a slot, and the two refusals that would otherwise be silent.
 *
 * The transport is not mocked. What is tested is the file and the local refusals, which is where
 * the reasoning lives: the firmware's own refusals on this route answer `commit ok` and write
 * nothing, so anything DNX can catch before sending is the difference between a message and a
 * mystery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RENAME_LENGTH,
  buildRenameFile,
} from "@noiseandmatter/dnx-core/device/waveriderrename.js";
import { ENTRY, encodeEntryName } from "@noiseandmatter/dnx-core/waverider/entries.js";
import { ENTRY_BYTES } from "@noiseandmatter/dnx-core/waverider/layout.js";
import { CONTENT_KIND_WAVETABLE, STORE_FORMAT_VERSION } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { HEAD, HEADER_BYTES, TRAILER_BYTES } from "@noiseandmatter/dnx-core/project/container.js";

const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

const body = (file: Uint8Array): Uint8Array =>
  file.subarray(HEADER_BYTES, file.length - TRAILER_BYTES);

test("a rename is an entry with no table after it", () => {
  const file = buildRenameFile(7, "HS SAW");

  // **Exactly 128 bytes of body.** That length is what the firmware reads as a rename rather than
  // as a table, so it is the whole signal.
  assert.equal(file.length, HEADER_BYTES + ENTRY_BYTES + TRAILER_BYTES);
  assert.equal(be32(file, HEAD.bodyLength), ENTRY_BYTES);

  assert.equal(be32(file, HEAD.contentKind), CONTENT_KIND_WAVETABLE);
  assert.equal(be32(file, HEAD.objectVersion), STORE_FORMAT_VERSION);
  assert.equal(be32(file, HEAD.index), 7);
  assert.equal(file[HEAD.compressed], 0);
});

test("only the name is set, and everything around it is zero", () => {
  // The firmware reads bytes 32..95 and ignores the rest, so DNX sends nothing else. Sending a
  // copy of the stored entry would look more careful and would mean carrying a table hash this
  // code did not compute — the one input that passes every check and then writes nothing.
  const record = body(buildRenameFile(0, "GLASS BELL"));

  assert.deepEqual(
    [...record.subarray(ENTRY.name, ENTRY.name + ENTRY.nameBytes)],
    [...encodeEntryName("GLASS BELL")],
  );
  for (let at = 0; at < ENTRY.name; at++) assert.equal(record[at], 0, `byte ${at} before the name`);
  for (let at = ENTRY.name + ENTRY.nameBytes; at < ENTRY_BYTES; at++) {
    assert.equal(record[at], 0, `byte ${at} after the name`);
  }
});

test("a name of 64 characters is refused here, because the device would refuse it silently", () => {
  // The firmware looks for a NUL inside the 64 name bytes. A name that fills them has none, so
  // the write does nothing and the commit still answers ok. 63 is the limit.
  assert.equal(MAX_RENAME_LENGTH, 63);

  const justFits = "x".repeat(63);
  assert.ok(buildRenameFile(1, justFits).length > 0);

  assert.throws(
    () => buildRenameFile(1, "x".repeat(64)),
    (error: unknown) =>
      error instanceof WaveriderError && /written as nothing at all/.test(error.message),
  );
});

test("an empty name and a slot outside the store are refused", () => {
  assert.throws(() => buildRenameFile(1, ""), WaveriderError);
  assert.throws(() => buildRenameFile(256, "ok"), WaveriderError);
  assert.throws(() => buildRenameFile(-1, "ok"), WaveriderError);
});

test("a name is encoded the way the index encodes one, not a second way", () => {
  // `encodeEntryName` is shared with the index writer on purpose. A character the device cannot
  // show becomes `?`, visibly, rather than quietly disappearing.
  const record = body(buildRenameFile(3, "BD THÜMPØR"));
  const expected = encodeEntryName("BD THÜMPØR");
  assert.deepEqual([...record.subarray(ENTRY.name, ENTRY.name + ENTRY.nameBytes)], [...expected]);

  const wide = body(buildRenameFile(3, "A中B"));
  assert.equal(wide[ENTRY.name + 1], 0x3f, "a character outside Windows-1252 shows as ?");
});
