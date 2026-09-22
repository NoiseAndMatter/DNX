/**
 * What the probe reads out of bytes, before anything is drawn.
 *
 * `describeChunkChecksums` is the strongest piece of evidence this page produces about the +Drive's
 * checksum field — it is the thing that says whether `driveChecksum` holds at chunk granularity, and
 * therefore whether a writer can compute the value for any chunking it likes. It lived 1,800 lines
 * into a module that cannot be imported without a browser, so **it had only ever been run against
 * bytes a device happened to send**, and only when somebody was sitting in front of one.
 *
 * The case worth designing for is the **partial** match. Agreement on all chunks and disagreement on
 * all chunks are both easy to read; a few disagreeing would mean the boundaries are not where we
 * think they are, and that is the outcome a summary would round away.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_RECORD_SIZES,
  describeChunkChecksums,
  hex2,
  hex8,
  looksLikeZip,
} from "../web/src/probe/format.js";
import { driveChecksum } from "@noiseandmatter/dnx-core/device/storage.js";
import { type StoredFile } from "@noiseandmatter/dnx-core/device/storagesession.js";

/** A read, built the way the device sends one: chunks of a stated size, each with its own sum. */
function read(chunks: Uint8Array[], over: Partial<StoredFile> = {}): StoredFile {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return {
    bytes,
    chunks: chunks.length,
    closed: true,
    chunkChecksums: chunks.map(driveChecksum),
    chunkLengths: chunks.map((c) => c.length),
    retries: 0,
    ...over,
  };
}

/** `n` bytes of a repeating pattern, so two chunks of the same length are not the same bytes. */
const filled = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

/* ---- the formatters, which exist once now ---------------------------------------------- */

test("a byte and a 32-bit field pad to their full width", () => {
  // The reason these are shared: a value printed 8 wide in one row and 6 wide in the next reads as
  // two different values. `hex2` was declared twice in this folder and `hex8` sat in a module that
  // writes innerHTML.
  assert.equal(hex2(0), "00");
  assert.equal(hex2(0xf), "0f");
  assert.equal(hex2(0xff), "ff");
  assert.equal(hex8(0), "00000000");
  assert.equal(hex8(0xdeadbeef), "deadbeef");
  assert.equal(hex8(1), "00000001");
});

/* ---- the shape of a payload ------------------------------------------------------------ */

test("a project read is recognised by its PK header, and a short buffer is not", () => {
  assert.equal(looksLikeZip(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(looksLikeZip(Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04])), false);
  // Four bytes or fewer is not enough to be a container, whatever it starts with. A truncated read
  // that happens to begin `PK` must not be reported as a project file.
  assert.equal(looksLikeZip(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), false);
  assert.equal(looksLikeZip(new Uint8Array()), false);
});

test("the record sizes we can name are the ones every identification has come from", () => {
  // Recorded rather than derived, and asserted so a mistyped digit cannot silently stop a payload
  // being recognised. 99,840 is the one that matters most: it is how a pattern+kit is known.
  assert.equal(KNOWN_RECORD_SIZES["a DN2 patternKit"], 99_840);
  assert.equal(KNOWN_RECORD_SIZES["a DN2 kit"], 10_752);
  assert.equal(KNOWN_RECORD_SIZES["a DN2 sound"], 359);
  assert.equal(KNOWN_RECORD_SIZES["DN2 project settings"], 512);
});

/* ---- marking our own homework ---------------------------------------------------------- */

test("every chunk agreeing is reported as agreement, and says nothing about writing", () => {
  const rows = describeChunkChecksums(read([filled(2048, 1), filled(2048, 2), filled(699, 3)]));
  const agrees = rows.find(([k]) => k === "driveChecksum agrees")![1];
  assert.match(agrees, /^all 3 —/);
  /*
   * **The caveat is load-bearing, so it is asserted.** A write declaring these same per-chunk
   * values was refused, and so was one declaring the whole file's. A reader who takes "the checksum
   * algorithm is right" as "so we can write" has taken exactly the wrong thing from this row.
   */
  assert.match(agrees, /Reads and writes do not use this field the same way/);
});

test("the slices are walked with the recorded lengths, not the total divided by the count", () => {
  /*
   * **The fault this function was rewritten for.** 10,795 bytes in 6 chunks is five of 2,048 and a
   * remainder — never six of 1,800. Re-slicing by `ceil(total / chunks)` got 0 of 6 and looked
   * exactly like a broken algorithm.
   *
   * Uneven on purpose: with equal chunks this test would pass either way, which is what let the
   * mistake survive.
   */
  const rows = describeChunkChecksums(read([filled(2048, 1), filled(2048, 2), filled(555, 3)]));
  assert.equal(rows.find(([k]) => k === "Chunk sizes")![1], "2048, 2048, 555");
  assert.match(rows.find(([k]) => k === "driveChecksum agrees")![1], /^all 3 —/);
});

test("a partial match is reported as a count and names the chunks, never as a verdict", () => {
  /*
   * The outcome the whole check exists to catch: it would mean the boundaries are not where we
   * think. Reporting it as a bare "disagrees" would hide *how many* and *which*, which is the only
   * part that tells you where to look.
   */
  const file = read([filled(2048, 1), filled(2048, 2), filled(300, 3)]);
  file.chunkChecksums[1] = 0xdeadbeef;
  const agrees = describeChunkChecksums(file).find(([k]) => k === "driveChecksum agrees")![1];
  assert.match(agrees, /^2 of 3\./);
  assert.match(agrees, /#1 device deadbeef vs ours [0-9a-f]{8}/);
  assert.doesNotMatch(agrees, /^all /);
});

test("only the first three mismatches are listed, so a wholly wrong read stays readable", () => {
  const file = read(Array.from({ length: 6 }, (_, i) => filled(64, i)));
  file.chunkChecksums = file.chunkChecksums.map(() => 0);
  const agrees = describeChunkChecksums(file).find(([k]) => k === "driveChecksum agrees")![1];
  assert.match(agrees, /^0 of 6\./);
  assert.equal((agrees.match(/#\d device/g) ?? []).length, 3);
});

test("a read that reported no checksums produces no rows at all", () => {
  /*
   * Not a row saying "none". There is a difference between a device that disagreed and a device
   * that was never asked, and a card claiming a checksum result for a read that carried none would
   * be the page inventing evidence.
   */
  assert.deepEqual(describeChunkChecksums(read([], { chunkChecksums: [], chunkLengths: [] })), []);
});

test("a single-chunk read still checks that one chunk", () => {
  // The only shape ever captured for a write, so it is the shape most likely to be assumed correct.
  const rows = describeChunkChecksums(read([filled(359, 9)]));
  assert.equal(rows.find(([k]) => k === "Chunk sizes")![1], "359");
  assert.match(rows.find(([k]) => k === "driveChecksum agrees")![1], /^all 1 —/);
});

test("more than four checksums are elided in the summary row but all are still checked", () => {
  const file = read(Array.from({ length: 7 }, (_, i) => filled(128, i)));
  const rows = describeChunkChecksums(file);
  const listed = rows.find(([k]) => k === "Chunk checksums")![1];
  assert.match(listed, /^7, /);
  assert.match(listed, /…$/, "the row summarises rather than printing seven 8-digit values");
  assert.match(rows.find(([k]) => k === "driveChecksum agrees")![1], /^all 7 —/,
    "the elision is in the printing only; every chunk is compared");
});
