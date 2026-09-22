/**
 * The +Drive library listing.
 *
 * Checked against a **real capture** rather than a synthetic listing, because the shape of an entry
 * is the thing most likely to be wrong and a fixture built from our own reader would agree with our
 * own reader by construction.
 *
 * `API_10msg_2355.syx` is a probe session on a Digitone II that includes a kit bank holding 14 saved
 * kits — which is exactly the interesting case: occupied and empty entries side by side, with
 * different permission masks.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";
import { decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { parseListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { BANKS } from "@noiseandmatter/dnx-core/project/naming.js";
import {
  BANK_SIZE,
  LIBRARY_ROOT,
  bankPath,
  describeBank,
  objectInStoredBody,
  slotPath,
} from "@noiseandmatter/dnx-core/device/library.js";
import {
  DN1_SOUND_SIZE,
  DN2_SOUND_SIZE,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
} from "@noiseandmatter/dnx-core/project/soundmap.js";
import { decodeTags } from "@noiseandmatter/dnx-core/project/tags.js";
import {
  HEAD_LENGTH_MINIMUM,
  LENGTH_BIAS,
  fileLengthFromHead,
  parsePayload,
} from "@noiseandmatter/dnx-core/project/container.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

test("paths are built the way the device addresses them", () => {
  assert.equal(bankPath("preset", "A"), "/soundbanks/A");
  assert.equal(bankPath("kit", "A"), "/kits/A");
  // The last segment is the index from a listing, never the name — the mistake that produced
  // `invalid project id` and was read three ways before being understood.
  assert.equal(slotPath("kit", "A", 1), "/kits/A/1");
  assert.equal(slotPath("preset", "H", 256), "/soundbanks/H/256");
});

test("the two collections have the sizes the instrument reported", () => {
  // Not guesses: /soundbanks/A listed 256 entries and /kits/A listed 128, both on hardware.
  assert.equal(BANK_SIZE.preset, 256);
  assert.equal(BANK_SIZE.kit, 128);
  assert.equal(BANKS.length, 8);
  assert.equal(2048, BANK_SIZE.preset * BANKS.length, "the manual's 2,048 presets");
  assert.equal(1024, BANK_SIZE.kit * BANKS.length);
  assert.equal(LIBRARY_ROOT.preset, "/soundbanks");
  assert.equal(LIBRARY_ROOT.kit, "/kits");
});

test("a captured kit bank decodes to occupied and empty entries", { skip }, () => {
  const bytes = new Uint8Array(
    readFileSync(join(CORPUS!, "..", "99_HardwareTest", "API_10msg_2355.syx")),
  );
  const msgs: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const s = bytes.indexOf(0xf0, at);
    if (s === -1) break;
    const e = bytes.indexOf(0xf7, s);
    if (e === -1) break;
    msgs.push(bytes.subarray(s, e + 1));
    at = e + 1;
  }
  // The last message of that session is the kit bank with 14 kits saved in it.
  const entries = parseListing(decodeMessage(msgs[msgs.length - 1]!).body).entries;

  assert.equal(entries.length, BANK_SIZE.kit, "a kit bank holds 128 slots");
  const occupied = entries.filter((e) => e.occupied);
  assert.equal(occupied.length, 14);
  assert.equal(occupied[0]!.name, "SOLID");

  // **Size does not distinguish them**, which is the trap this listing exists to document.
  assert.equal(new Set(entries.map((e) => e.size)).size, 1, "every slot lists the same size");
  assert.equal(occupied[0]!.size, 10_752);

  // Permissions do. An occupied kit reads as protected, so `writable` is not the inverse of empty.
  assert.equal(occupied[0]!.writable, false, "the device protects a saved kit");
  assert.equal(entries.find((e) => !e.occupied)!.writable, true);
});

test("a bank describes itself by what is in it, and says nothing when empty", () => {
  assert.equal(describeBank({ kind: "kit", bank: "A", path: "/kits/A", entries: [], used: 0 }), "A — empty");
  assert.match(
    describeBank({ kind: "kit", bank: "A", path: "/kits/A", entries: new Array(128).fill(0).map(() => ({} as never)), used: 14 }),
    /A — 14 of 128/,
  );
});

/**
 * A stored body is not always the object, and the prefix is found by its magic.
 *
 * These run on three files a real device produced — a DN2 stored preset, a DN1 stored preset, and
 * a DN2 sound dump of the same object form. **None of them was made by this code**, which is the
 * whole point: a synthetic 364-byte body would carry whatever prefix the writer of the test
 * believed in, and would agree with `objectInStoredBody` by construction.
 */
function hardwareTest(name: string): Uint8Array {
  // Built as a string the way `capture.test.ts` does. `CORPUS` is optional at the type level —
  // these tests are `{ skip }` without one, so the path is only ever formed when it exists.
  return new Uint8Array(readFileSync(join(`${CORPUS}`, "..", "99_HardwareTest", name)));
}

const HEADER = 31;
const TRAILER = 12;

test("a Digitone II stored preset carries five bytes in front of its sound", { skip }, () => {
  const file = hardwareTest("soundbanks_H_1_407B.bin");
  assert.equal(file.length, 407, "31 header + 364 body + 12 trailer");

  const body = file.subarray(HEADER, file.length - TRAILER);
  assert.equal(body.length, 364);

  const { object, prefix } = objectInStoredBody(body);
  assert.equal(prefix.length, 5, "364 - 359");
  assert.equal(object.length, DN2_SOUND_SIZE, "and what is left is exactly a sound object");
  assert.deepEqual([...object.subarray(0, 4)], [0xbe, 0xef, 0xba, 0xce]);

  // **The anchors are the evidence, not the arithmetic.** Five bytes could be taken off anything
  // and leave 359; that the name then reads as the slot's own listed name, and the tag word decodes
  // to something a bass drum would be tagged, is what says the shift is right.
  const name = new TextDecoder("latin1")
    .decode(object.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE))
    .replace(/\0.*$/, "");
  assert.equal(name, "BD 1 BR", "the name /soundbanks/H/1 lists");
  assert.deepEqual(decodeTags(u32be(object, 8)), ["KICK", "HARD"]);
});

test("a Digitone 1 stored preset has no prefix at all", { skip }, () => {
  // The control. If `objectInStoredBody` shifted by five unconditionally — or keyed off a length
  // instead of the magic — this is the case that would break, and it is a case that already works
  // in the shipped librarian.
  const file = hardwareTest("soundbank_A1_345B_e48ff54e.bin");
  const body = file.subarray(HEADER, file.length - TRAILER);
  assert.equal(body.length, DN1_SOUND_SIZE, "302: a DN1 body is its object exactly");

  const { object, prefix } = objectInStoredBody(body);
  assert.equal(prefix.length, 0);
  assert.equal(object.length, DN1_SOUND_SIZE);
  assert.deepEqual([...object.subarray(0, 4)], [0xbe, 0xef, 0xba, 0xce]);
});

test("a body with no magic anywhere is handed back unshifted", () => {
  // Pattern and settings records legitimately carry no `BEEFBACE`. Shifting one by a coincidental
  // four-byte run would be far worse than doing nothing.
  const body = new Uint8Array(64).fill(0x11);
  const { object, prefix } = objectInStoredBody(body);
  assert.equal(prefix.length, 0);
  assert.equal(object.length, 64);
});

function u32be(a: Uint8Array, at: number): number {
  return ((a[at]! << 24) | (a[at + 1]! << 16) | (a[at + 2]! << 8) | a[at + 3]!) >>> 0;
}

/**
 * The container header declares how long the file will be.
 *
 * This is what lets a +Drive read report a percentage rather than only bytes arriving. It looked
 * impossible at first: `parsePayload` reads `storedLength` from `raw.length - 8`, so the length
 * appears to be a fact only available once the file is complete. **The same number is also at
 * header offset 25**, which is inside the first chunk.
 *
 * Checked here against the trailer on files a device produced, four hundred times apart in size —
 * because a header field that merely *looked* like a length would give a bar that quietly lied.
 */
test("a stored file's header declares the same length as its trailer", { skip }, () => {
  for (const name of ["soundbanks_H_1_407B.bin", "kits_A_1_10795B.bin"]) {
    const file = hardwareTest(name);

    const fromHead = fileLengthFromHead(file);
    assert.equal(fromHead, file.length, `${name}: the header should predict the whole file`);

    // And it agrees with the trailer, which is where everything else reads it from.
    const fromTrailer = parsePayload(file).storedLength + LENGTH_BIAS;
    assert.equal(fromHead, fromTrailer, `${name}: header and trailer must not disagree`);
  }
});

test("the length is readable from the first chunk alone", { skip }, () => {
  // The whole point: a 2,048-byte first chunk has to answer for a 12.9 MB project.
  const file = hardwareTest("kits_A_1_10795B.bin");
  assert.equal(fileLengthFromHead(file.subarray(0, 2048)), file.length);
  // And from the least that could possibly work.
  assert.equal(fileLengthFromHead(file.subarray(0, HEAD_LENGTH_MINIMUM)), file.length);
});

test("too little, or not a container, answers nothing rather than guessing", () => {
  // Used for a progress bar, so a wrong number is worse than none — a bar that overshoots its own
  // total says the thing it exists to say, wrongly.
  assert.equal(fileLengthFromHead(new Uint8Array(HEAD_LENGTH_MINIMUM - 1)), undefined);
  assert.equal(fileLengthFromHead(new Uint8Array(64)), undefined, "no container magic");
});
