/**
 * The gate: three states, and the rule for a build whose capabilities cannot be read.
 *
 * The transport is scripted rather than mocked at the module boundary, so what is tested is the
 * decision made from replies in the device's own wire format — a root listing and a file read.
 *
 * **The states are the subject, not the plumbing.** A gate with two states turns a held port into
 * *stock firmware, no wavetables*, and somebody told that has no reason to look further. Each test
 * below is one way of being wrong that would look identical from the outside.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import {
  askWaveriderSupport,
  featuresFrom,
} from "@noiseandmatter/dnx-core/device/waveridersupport.js";
import {
  CAPABILITY,
  CONTENT_KIND_MODINFO,
  MODINFO_BYTES,
  MODINFO_VERSION,
} from "@noiseandmatter/dnx-core/waverider/modinfo.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";
import { buildContainer } from "@noiseandmatter/dnx-core/project/container.js";
import { FORMAT_VERSION } from "@noiseandmatter/dnx-core/waverider/slotfile.js";

const STOCK_ROOTS = ["projects", "soundbanks", "kits"];
const MODDED_ROOTS = [...STOCK_ROOTS, "waverider", "wavepool", "modinfo"];

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

/** A capability record, at the spec's literal offsets. See `waveridermodinfo.test.ts`. */
function recordFile(capabilities: number, poolSlots = 128): Uint8Array {
  const body = new Uint8Array(MODINFO_BYTES);
  body.set([0x44, 0x4e, 0x4d, 0x49]);
  put16(body, 4, MODINFO_VERSION);
  put16(body, 6, MODINFO_BYTES);
  put32(body, 8, capabilities);
  put16(body, 12, poolSlots);
  put16(body, 14, 2);
  put16(body, 16, 256);
  body[18] = 15;
  body[19] = 14;
  put32(body, 20, 0x0ddba11);
  put32(body, MODINFO_BYTES - 4, xxHash32(body.subarray(0, MODINFO_BYTES - 4)));

  return buildContainer({
    body,
    contentKind: CONTENT_KIND_MODINFO,
    objectVersion: MODINFO_VERSION,
    index: 0,
    formatVersion: FORMAT_VERSION,
  });
}

/** A root listing reply: directory entries carrying a child count, which is what roots carry. */
function rootListing(names: readonly string[]): Uint8Array {
  const out: number[] = [1];
  const push32 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  push32(0);
  push32(names.length + 1);
  push32(names.length);
  for (const name of names) {
    for (const ch of name) out.push(ch.charCodeAt(0));
    out.push(0, 0x01, 0x01);
    push32(128);
  }
  return Uint8Array.from(out);
}

/** A failed open or read: status `0`, then the device's own sentence. */
function refusal(sentence: string): Uint8Array {
  return Uint8Array.from([0, ...[...sentence].map((c) => c.charCodeAt(0))]);
}

interface Script {
  roots?: readonly string[];
  /** The listing fails instead of answering: a held port, a timeout. */
  listFails?: string;
  /** What a read of `/modinfo/0` does. A string is the device refusing in its own words. */
  info?: Uint8Array | string;
}

/** A device that answers exactly what the script says and records what it was asked. */
function device(script: Script): ApiTransport & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      asked.push(code);
      const reply = (bytes: Uint8Array): Promise<ApiFrame> =>
        Promise.resolve({
          msgId, respId: msgId, code: code | RESPONSE_BIT, body: bytes,
          isResponse: true, terminated: true,
        });

      switch (code) {
        case StorageCode.List:
          if (script.listFails !== undefined) return Promise.reject(new Error(script.listFails));
          return reply(rootListing(script.roots ?? MODDED_ROOTS));
        case StorageCode.Open:
          if (typeof script.info === "string") return reply(refusal(script.info));
          return reply(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 8, 0, 1));
        case StorageCode.Read: {
          const sequence = (body[4]! << 24) | (body[5]! << 16) | (body[6]! << 8) | body[7]!;
          const file = script.info instanceof Uint8Array ? script.info : new Uint8Array(0);
          // Sequence 0 draws the empty leading reply and 1 the file, which is the shape
          // `readStoredFile` expects. The whole record fits in one chunk.
          const data = sequence === 0 ? new Uint8Array(0) : file;
          const out = new Uint8Array(22 + data.length);
          out[0] = 1;
          put32(out, 1, 1);
          put32(out, 5, sequence === 0 ? 0 : 1);
          out[13] = sequence === 0 ? 0 : 1;
          put32(out, 18, data.length);
          out.set(data, 22);
          return reply(out);
        }
        default:
          return reply(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0));
      }
    },
  };
}

const ask = (script: Script) =>
  askWaveriderSupport({ transport: device(script), ids: new MessageIds(), timeoutMs: 1_000 });

test("a modded build with a record: supported, and every capability named", () => {
  const all =
    CAPABILITY.store | CAPABILITY.pool | CAPABILITY.rename | CAPABILITY.poolCas | CAPABILITY.page;

  return ask({ info: recordFile(all) }).then((support) => {
    assert.equal(support.state, "supported");
    if (support.state !== "supported") return;

    assert.equal(support.info?.imageId, 0x0ddba11);
    assert.deepEqual(support.features, {
      tab: true,
      pool: true,
      rename: true,
      secondWriter: true,
      conflictReported: true,
      warnConcurrentUndetectable: false,
      capabilitiesKnown: true,
      poolSlots: 128,
      nameChars: { pool: 15, shown: 14 },
    });
  });
});

test("stock firmware: not supported, corroborated by its own sentence", async () => {
  const support = await ask({
    roots: STOCK_ROOTS,
    info: "Error: Could not resolve path",
  });

  assert.equal(support.state, "unsupported");
  if (support.state !== "unsupported") return;
  assert.equal(support.corroborated, true);
  assert.match(support.why, /not waverider/);
});

test("the listing is the signal, so an unrecognised sentence still means not supported", async () => {
  // The string is English text from firmware that changes under us. A build that answered
  // "no such directory" would be read as *could not ask* if the sentence were the signal.
  const support = await ask({ roots: STOCK_ROOTS, info: "Error: nope" });

  assert.equal(support.state, "unsupported");
  if (support.state !== "unsupported") return;
  assert.equal(support.corroborated, false, "the sentence was not stock's, and it is only evidence");
});

test("a held port is 'could not ask', never 'not supported'", async () => {
  const support = await ask({ listFails: "no reply in 1000 ms" });

  assert.equal(support.state, "unknown");
  assert.match(support.why, /not known/);
  assert.match(support.why, /no reply/, "and the device's own reason is carried");
});

test("the primary signal failing stops the questions", async () => {
  const io = device({ listFails: "no reply" });
  await askWaveriderSupport({ transport: io, ids: new MessageIds(), timeoutMs: 1_000 });

  // A read of `/modinfo/0` here could only produce a second failure, and two failures are not a
  // finding. One message, and it was the listing.
  assert.deepEqual(io.asked, [StorageCode.List]);
});

test("a Waverider build older than the record: supported, capabilities unknown", async () => {
  // Every build in the field predates `/modinfo`, and reading those as unsupported would hide the
  // view on the only instrument there is. The listing is self-consistent: the store is there and
  // the record is not.
  const support = await ask({ roots: ["projects", "waverider", "wavepool"] });

  assert.equal(support.state, "supported");
  if (support.state !== "supported") return;
  assert.equal(support.info, undefined);
  assert.deepEqual(support.features, {
    tab: true,
    pool: true,
    rename: false,
    secondWriter: true,
    conflictReported: false,
    warnConcurrentUndetectable: true,
    capabilitiesKnown: false,
  });
});

test("the listing offering the record while the read fails is a contradiction", async () => {
  // Not resolved either way. The two answers disagree, and picking one would be a guess about
  // which to believe on an instrument somebody is about to write to.
  const support = await ask({ info: "Error: Could not resolve path" });

  assert.equal(support.state, "unknown");
  assert.match(support.why, /disagree/);
});

test("a record that will not parse is also a contradiction, not a feature set", async () => {
  const broken = recordFile(CAPABILITY.store);
  broken[broken.length - 20] = (broken[broken.length - 20] ?? 0) ^ 0xff;

  const support = await ask({ info: broken });
  assert.equal(support.state, "unknown");
  assert.match(support.why, /hash/);
});

test("no store root but the record reads: refused rather than resolved", async () => {
  const support = await ask({ roots: STOCK_ROOTS, info: recordFile(CAPABILITY.store) });

  assert.equal(support.state, "unknown");
  assert.match(support.why, /nothing should produce/);
});

test("the rule for each unknown, stated one at a time", () => {
  const unknown = featuresFrom(["waverider", "wavepool"]);

  // Rename unknown: a feature is lost and nothing breaks.
  assert.equal(unknown.rename, false);
  // The page flag unknown must NOT mean "no second writer" — that build has the instrument's own
  // wavetable page, and taking silence for absence fails in the case the flag exists for.
  assert.equal(unknown.secondWriter, true);
  // The compare-and-swap unknown means assuming the firmware does not refuse a stale write, so
  // the warning comes before the write rather than the news after it.
  assert.equal(unknown.conflictReported, false);
  assert.equal(unknown.warnConcurrentUndetectable, true);
  // No default for the grid: 127 and 128 are both builds that exist.
  assert.equal(unknown.poolSlots, undefined);
  assert.equal(unknown.nameChars, undefined);

  // And the store alone, with no pool route, is the store list without a pool pane.
  const storeOnly = featuresFrom(["waverider"]);
  assert.equal(storeOnly.tab, true);
  assert.equal(storeOnly.pool, false);
});

test("a feature needs both its bit and its route", () => {
  // The record is filled from the same defines the routes use, so these agree on every build that
  // exists. Where they would not, a pool pane whose route is absent fails when somebody uses it.
  const noRoute = featuresFrom(["waverider"], {
    version: 1, bytes: 256, capabilities: 0x3f, unknown: 0,
    can: { store: true, pool: true, rename: true, poolCas: true, page: true, playable: false },
    poolSlots: 128, poolRecordVersion: 2, storeSlots: 256,
    poolNameChars: 15, shownNameChars: 14, imageId: 1,
    os: "1.11", buildTag: "t", commit: "c", modCount: 0, mods: [],
  });

  assert.equal(noRoute.pool, false, "the bit is set and the route is not listed");
  assert.equal(noRoute.tab, true);
});

test("the playable bounds pass through, and their absence is a rule rather than a gap", () => {
  const base = {
    version: 1, bytes: 256, unknown: 0,
    poolSlots: 128, poolRecordVersion: 2, storeSlots: 256,
    poolNameChars: 15, shownNameChars: 14, imageId: 1,
    os: "1.11", buildTag: "t", commit: "c", modCount: 0, mods: [],
  };
  const can = { store: true, pool: true, rename: true, poolCas: true, page: true };
  const roots = ["waverider", "wavepool"];

  const reported = featuresFrom(roots, {
    ...base,
    capabilities: 0x77,
    can: { ...can, playable: true },
    playable: { maxWaves: 64, minPoints: 64, maxPoints: 4_096, pointsPowerOfTwo: true },
  });
  assert.deepEqual(reported.playable, {
    maxWaves: 64,
    minPoints: 64,
    maxPoints: 4_096,
    pointsPowerOfTwo: true,
  });

  // **Undefined means 16 x 512, which `unplayableReason` applies.** Unlike `poolSlots` there is an
  // honest default here, because the spec names it, so nothing downstream has to resolve this.
  const notReported = featuresFrom(roots, {
    ...base,
    capabilities: 0x37,
    can: { ...can, playable: false },
  });
  assert.equal(notReported.playable, undefined);
  assert.equal(notReported.capabilitiesKnown, true, "the build answered; it answered 16 x 512");

  // And a build with no record at all. The same undefined, with `capabilitiesKnown` false beside
  // it, which is how a page tells "this build plays that pair" from "nobody said".
  const noRecord = featuresFrom(roots);
  assert.equal(noRecord.playable, undefined);
  assert.equal(noRecord.capabilitiesKnown, false);
});
