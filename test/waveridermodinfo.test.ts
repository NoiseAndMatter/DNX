/**
 * The capability record, and the two rules that make it readable by a DNX older than the firmware.
 *
 * **The record is built here from the spec's own table, at literal offsets**, not from the codec's
 * `INFO` map. A fixture taken from the module under test can only prove the module agrees with
 * itself — and this file's whole subject is agreement with somebody else's bytes.
 *
 * Spec: `dn2_firmware/docs/for-dnx-modinfo.md` rev 2.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITY,
  CONTENT_KIND_MODINFO,
  MODINFO_BYTES,
  MODINFO_VERSION,
  readModInfo,
  readModInfoFile,
} from "@noiseandmatter/dnx-core/waverider/modinfo.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";
import { buildContainer } from "@noiseandmatter/dnx-core/project/container.js";
import { FORMAT_VERSION } from "@noiseandmatter/dnx-core/waverider/slotfile.js";

const put16 = (b: Uint8Array, at: number, v: number): void => {
  b[at] = (v >> 8) & 0xff;
  b[at + 1] = v & 0xff;
};
const put32 = (b: Uint8Array, at: number, v: number): void => {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
};
const ascii = (b: Uint8Array, at: number, text: string): void => {
  for (let i = 0; i < text.length; i++) b[at + i] = text.charCodeAt(i);
};

interface Built {
  capabilities?: number;
  bytes?: number;
  version?: number;
  poolSlots?: number;
  mods?: { id: string; hash: number }[];
  modCount?: number;
  /** Leave the hash wrong on purpose. */
  breakHash?: boolean;
}

/** A record as the firmware fills one, written byte by byte from the spec's table. */
function record(over: Built = {}): Uint8Array {
  const bytes = over.bytes ?? MODINFO_BYTES;
  const b = new Uint8Array(bytes);
  ascii(b, 0, "DNMI");
  put16(b, 4, over.version ?? MODINFO_VERSION);
  put16(b, 6, bytes);
  put32(b, 8, over.capabilities ?? 0x37);
  put16(b, 12, over.poolSlots ?? 128);
  put16(b, 14, 2);
  put16(b, 16, 256);
  b[18] = 15;
  b[19] = 14;
  put32(b, 20, 0xdeadbeef);
  ascii(b, 24, "1.11");
  ascii(b, 32, "wr-modinfo");
  ascii(b, 56, "a97b3ca08f+");
  const mods = over.mods ?? [
    { id: "wrstore", hash: 0x11112222 },
    { id: "wrpool", hash: 0 },
  ];
  b[68] = over.modCount ?? mods.length;
  mods.forEach((mod, i) => {
    ascii(b, 72 + i * 16, mod.id);
    put32(b, 72 + i * 16 + 12, mod.hash);
  });
  put32(b, bytes - 4, xxHash32(b.subarray(0, bytes - 4)) ^ (over.breakHash === true ? 1 : 0));
  return b;
}

test("every field the spec names reads back", () => {
  const info = readModInfo(record());

  assert.equal(info.version, 1);
  assert.equal(info.bytes, 256);
  assert.equal(info.poolSlots, 128, "the grid is drawn from this, not from DNX's own constant");
  assert.equal(info.poolRecordVersion, 2);
  assert.equal(info.storeSlots, 256);
  assert.equal(info.poolNameChars, 15);
  assert.equal(info.shownNameChars, 14);
  assert.equal(info.imageId, 0xdeadbeef);
  assert.equal(info.os, "1.11");
  assert.equal(info.buildTag, "wr-modinfo");
  assert.equal(info.commit, "a97b3ca08f+", "a trailing + means uncommitted changes, so it is kept");

  // 0x37 is store | pool | rename | the retired bit | pool_cas | page.
  assert.deepEqual(info.can, {
    store: true,
    pool: true,
    rename: true,
    poolCas: true,
    page: true,
  });
  assert.equal(info.unknown, 0);
});

test("a mod with no code hash is absent rather than zero", () => {
  const info = readModInfo(record());

  assert.equal(info.modCount, 2);
  assert.deepEqual(info.mods, [{ id: "wrstore", codeHash: 0x11112222 }, { id: "wrpool" }]);
});

test("a mod count larger than the record has room for reads what fits", () => {
  // The firmware refuses more than eleven at build time. A reader that trusted the count would
  // walk into the reserved bytes and report mods made of zeros.
  const info = readModInfo(record({ modCount: 40 }));
  assert.equal(info.modCount, 40, "what the record claims is reported");
  assert.equal(info.mods.length, 2, "and only the mods that are actually there come back");
});

test("unknown capability bits are reported and never acted on", () => {
  // The opposite of the pool record's rule: a capability set grows by design, so an older DNX
  // meeting newer firmware loses features rather than refusing the device.
  const info = readModInfo(record({ capabilities: CAPABILITY.store | CAPABILITY.pool | 0x4000 }));

  assert.equal(info.can.store, true);
  assert.equal(info.can.pool, true);
  assert.equal(info.can.rename, false);
  assert.equal(info.unknown, 0x4000);
});

test("a longer record reads, with its hash at the end rather than at 252", () => {
  /*
   * The record grows by appending, so the hash moves with the length. A reader taking it from a
   * constant would read a longer record's payload as its hash and call a healthy record corrupt.
   * The appended bytes here are deliberately not zero, which is what makes that failure visible.
   */
  const long = record({ bytes: 512 });
  long.fill(0xa5, 256, 508);
  put32(long, 508, xxHash32(long.subarray(0, 508)));

  const info = readModInfo(long);
  assert.equal(info.bytes, 512);
  assert.equal(info.poolSlots, 128, "the fields it knows still read");
});

test("the refusals: not a record, the wrong length, a hash that does not match", () => {
  const notOurs = record();
  notOurs[0] = 0x44 ^ 0xff;
  assert.throws(() => readModInfo(notOurs), (e: unknown) =>
    e instanceof WaveriderError && /DNMI/.test(e.message));

  // A record declaring a length other than the one that arrived is not a record this reader can
  // place the hash in, so it is refused rather than read at the length that happens to be there.
  const lying = record();
  put16(lying, 6, 512);
  assert.throws(() => readModInfo(lying), (e: unknown) =>
    e instanceof WaveriderError && /512 bytes and 256 arrived/.test(e.message));

  assert.throws(() => readModInfo(record({ breakHash: true })), (e: unknown) =>
    e instanceof WaveriderError && /hash/.test(e.message));

  assert.throws(() => readModInfo(record().subarray(0, 40)), WaveriderError);
});

/** What a read of `/modinfo/0` returns: the record in a transfer container. */
function file(over: Built = {}, kind = CONTENT_KIND_MODINFO, version = MODINFO_VERSION): Uint8Array {
  return buildContainer({
    body: record(over),
    contentKind: kind,
    objectVersion: version,
    index: 0,
    formatVersion: FORMAT_VERSION,
  });
}

test("the file reads through its container, and both version fields must agree", () => {
  const info = readModInfoFile(file());
  assert.equal(info.imageId, 0xdeadbeef);

  // The same check the pool record makes on its two version fields: they describe one thing, and a
  // record where they differ is one whose reading depends on which field a reader consulted.
  assert.throws(
    () => readModInfoFile(file({ version: 2 })),
    (e: unknown) => e instanceof WaveriderError && /version 1 and the record says 2/.test(e.message),
  );
});

test("a container that is not a mod-info record is refused by kind", () => {
  // 0x50 is a pool record. Reading one as capabilities would produce a capability word out of
  // somebody's entry list.
  assert.throws(
    () => readModInfoFile(file({}, 0x50)),
    (e: unknown) => e instanceof WaveriderError && /content kind 0x50/.test(e.message),
  );
});
