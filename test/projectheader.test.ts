/**
 * The project container's 31-byte header, field by field.
 *
 * This file exists because the header was read through the wrong frame for two months. The old
 * reading had little-endian fields at 0x10, 0x14 and 0x18 with eleven unidentified bytes after
 * them, and it returned the right numbers for 53 DN1 projects, all of which were in bank A with an
 * object version below 256. It is four big-endian words: content kind, object version, index, and
 * the uncompressed body length.
 *
 * The straddle is what makes a unit test insufficient here. A little-endian word at 0x14 reaches
 * into the index that follows it, so the two readings agree on every file where the bank byte is
 * zero, and a synthetic fixture written from either understanding agrees with itself. The device
 * had already produced the counter-example: `soundbanks_H_1_407B.bin`, read off a Digitone II,
 * whose object version is 2 and which the old frame reported as 117,440,514.
 *
 * So the sweep at the bottom runs over every container on disk, and it throws rather than skipping
 * when it cannot find them.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONTAINER_INDEX_OFFSET,
  CONTAINER_SLOT_OFFSET,
  CONTENT_KIND,
  COMPRESSED_FLAG_OFFSET,
  LENGTH_BIAS,
  containerIsCompressed,
  containerObjectVersion,
  contentKind,
  fileLengthFromHead,
  parsePayload,
} from "@noiseandmatter/dnx-core/project/container.js";
import { CONTENT_KIND_WAVETABLE } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { CONTENT_KIND_POOL } from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

/**
 * Every content kind a capture may legitimately hold.
 *
 * `CONTENT_KIND` is **Elektron's** three and stays that way. The custom firmware's two live in
 * their own modules by design, and they belong here because a capture of a `/waverider` or
 * `/wavepool` read is a container the device wrote: without them, the first such capture dropped
 * into the corpus fails this sweep for a file that is entirely correct. A pool vector put there
 * by hand is what found that.
 */
const KNOWN_KINDS = new Set<number>([
  ...Object.values(CONTENT_KIND),
  CONTENT_KIND_WAVETABLE,
  CONTENT_KIND_POOL,
]);

const skip = NO_CORPUS ? SKIP_REASON : false;

const HEADER = 31;
const TRAILER = 12;

/** A container built by hand, so the fixture does not come from the code that reads it. */
function container(options: {
  kind: number;
  objectVersion: number;
  bank: number;
  slot: number;
  declared: number;
  compressed: boolean;
  body: Uint8Array;
}): Uint8Array {
  const out = new Uint8Array(HEADER + options.body.length + TRAILER);
  out.set([0xac, 0x11, 0xd3, 0x03], 0);
  out.set([0x02, 0x00, 0x05, 0x00], 4);
  out[8] = 15;
  out.set([..."0050"].map((c) => c.charCodeAt(0)), 9);
  const be = (at: number, value: number) => {
    out[at] = (value >>> 24) & 0xff;
    out[at + 1] = (value >>> 16) & 0xff;
    out[at + 2] = (value >>> 8) & 0xff;
    out[at + 3] = value & 0xff;
  };
  be(0x0d, options.kind);
  be(0x11, options.objectVersion);
  be(CONTAINER_INDEX_OFFSET, options.bank * 256 + options.slot);
  be(0x19, options.declared);
  out[COMPRESSED_FLAG_OFFSET] = options.compressed ? 1 : 0;
  out[0x1e] = TRAILER;
  out.set(options.body, HEADER);
  out.set([0xaa, 0xa1, 0xda, 0xaa], out.length - 4);
  return out;
}

test("the four words, read back from a container built by hand", () => {
  const body = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff);
  const raw = container({
    kind: CONTENT_KIND.sound,
    objectVersion: 2,
    bank: 7,
    slot: 0,
    declared: 64,
    compressed: false,
    body,
  });

  assert.equal(contentKind(raw), CONTENT_KIND.sound);
  assert.equal(containerObjectVersion(raw), 2);
  assert.equal(containerIsCompressed(raw), false);
  assert.equal(raw[0x17], 7, "bank");
  assert.equal(raw[CONTAINER_SLOT_OFFSET], 0, "slot");

  // **The straddle, as arithmetic.** This is the shape the old frame got wrong: a non-zero bank
  // byte lands in the top byte of a little-endian word read at 0x14.
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  assert.equal(view.getUint32(0x14, true), 117_440_514, "what the old reading would return");
  assert.notEqual(view.getUint32(0x14, true), containerObjectVersion(raw));
});

test("a length from the head answers only for a raw body", () => {
  const body = new Uint8Array(64);

  // Raw: the declared length is the body, so the file length follows.
  const raw = container({
    kind: 1, objectVersion: 3, bank: 0, slot: 0, declared: 64, compressed: false, body,
  });
  assert.equal(fileLengthFromHead(raw), 64 + LENGTH_BIAS);

  /*
   * Compressed: the declared length is the *decompressed* size, and answering with it would give a
   * progress bar a total the transfer never reaches. A real `.dn2prj` declares 12,889,604 in a
   * 139,596-byte file, so the bar would finish at one percent.
   */
  const packed = container({
    kind: 1, objectVersion: 3, bank: 0, slot: 0, declared: 12_889_604, compressed: true, body,
  });
  assert.equal(fileLengthFromHead(packed), undefined);

  // And the old refusals still refuse.
  assert.equal(fileLengthFromHead(new Uint8Array(8)), undefined, "too short");
  assert.equal(fileLengthFromHead(new Uint8Array(64)), undefined, "no container magic");
});

/** `99_HardwareTest` sits beside the corpus, as in `library.test.ts`. */
function hardwareTest(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(`${CORPUS}`, "..", "99_HardwareTest", name)));
}

test("the device's own files, where the old frame was wrong", { skip }, () => {
  /*
   * **The regression, and it is a device's bytes rather than ours.** `/soundbanks/H/1` read off a
   * Digitone II: object version 2, bank 7, slot 0. The old little-endian read at 0x14 answered
   * 117,440,514 for this file and nobody noticed, because nothing displayed it and every other
   * sample was in bank A.
   */
  const bankH = hardwareTest("soundbanks_H_1_407B.bin");
  assert.equal(containerObjectVersion(bankH), 2);
  assert.equal(contentKind(bankH), CONTENT_KIND.sound);
  assert.equal(bankH[0x17], 7, "bank H, zero-based");
  assert.equal(bankH[CONTAINER_SLOT_OFFSET], 0, "slot 1, zero-based");
  // 1,792 is bank x 256 + slot, not a flat index: a flat one would be 896 at 128 slots a bank.
  const index = new DataView(bankH.buffer, bankH.byteOffset, bankH.byteLength)
    .getUint32(CONTAINER_INDEX_OFFSET, false);
  assert.equal(index, 7 * 256, "two coordinates in one word");

  // A kit, which is the third content kind and the slot stamp measured on 2026-08-13.
  const kit = hardwareTest("kits_A_38_10795B.bin");
  assert.equal(contentKind(kit), CONTENT_KIND.kit);
  assert.equal(kit[CONTAINER_SLOT_OFFSET], 37, "slot 38, zero-based");
  assert.equal(containerIsCompressed(kit), false, "a device read is raw");
  assert.equal(fileLengthFromHead(kit), kit.length);
});

/** Every plain container under a directory: device reads and uncompressed payloads. */
function rawContainers(dir: string): { path: string; raw: Uint8Array }[] {
  const out: { path: string; raw: Uint8Array }[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...rawContainers(path));
      continue;
    }
    if (!/\.(bin|work)$/i.test(entry.name)) continue;
    const raw = new Uint8Array(readFileSync(path));
    if (raw.length > LENGTH_BIAS && raw[0] === 0xac && raw[1] === 0x11 && raw[2] === 0xd3 && raw[3] === 0x03) {
      out.push({ path, raw });
    }
  }
  return out;
}

test("the header's constants hold over every container the device wrote", { skip }, () => {
  const files = rawContainers(join(`${CORPUS}`, "..", "99_HardwareTest"))
    .concat(rawContainers(`${CORPUS}`));

  // A sweep that finds nothing passes, which is the worst way for this to fail.
  assert.ok(files.length >= 10, `only ${files.length} containers found — the sweep checks nothing`);

  const kinds = new Set<number>();
  for (const { path, raw } of files) {
    const where = path.slice(path.lastIndexOf("\\") + 1);
    const kind = contentKind(raw)!;
    kinds.add(kind);
    assert.ok(
      KNOWN_KINDS.has(kind),
      `${where}: content kind ${kind} is not one of ${[...KNOWN_KINDS].join(", ")}`,
    );
    assert.deepEqual([...raw.subarray(4, 8)], [0x02, 0x00, 0x05, 0x00], `${where}: 0x04`);
    assert.equal(raw[0x1e], TRAILER, `${where}: 0x1E is the trailer's length`);

    /*
     * **A raw body is exactly as long as the header declares.** This is the relationship that
     * makes `fileLengthFromHead` work, and the reason it has to refuse a compressed body: there,
     * the same field is the decompressed size.
     *
     * One file on disk breaks it: `PRESETS_TEST.dnprj`, which DNX wrote before `write.ts` learned
     * to stamp the compression flag, so it holds an LZ4 chain behind a 0. It is a ZIP and so never
     * reaches this sweep, and it is worth naming because a corpus scan that trusts the flag will
     * meet it.
     */
    const declared = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0x19, false);
    const body = raw.length - LENGTH_BIAS;
    if (containerIsCompressed(raw)) {
      assert.ok(body < declared, `${where}: a compressed body must be shorter than ${declared}`);
    } else {
      assert.equal(declared, body, `${where}: a raw body is the declared length`);
      assert.equal(fileLengthFromHead(raw), raw.length, `${where}: and so predicts the file`);
    }

    // The trailer says the same number, from the other end.
    assert.equal(parsePayload(raw).storedLength, body, `${where}: trailer length`);
  }

  // The sweep is only worth running if it saw more than one kind of file.
  assert.ok(kinds.size >= 2, `every container found was kind ${[...kinds]} — too narrow to mean much`);
});
