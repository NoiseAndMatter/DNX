/**
 * The one write path, and the fence around it.
 *
 * Two kinds of test here, and the second kind is the point of the module.
 *
 * The behavioural ones check the sequence: backed up before sent, refused when the backup cannot be
 * taken, cancelled when the person says no, and reported as unverified when the device does not
 * hold what was sent. Each of those is a thing the manager did wrong until this existed — it wrote
 * with no copy, no question and no check, and said "3 patterns written" either way.
 *
 * The architectural one reads the source tree and fails if any module reaches a mutating primitive
 * without going through `safewrite.ts`. That is the half that survives the next feature: a permit
 * makes a bypass a compile error, and this makes a cast one somebody has to argue for in a diff.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildMessage, parseMessage } from "../src/sysex/container.js";
import { ProductId } from "../src/sysex/devices.js";
import { DN2_LAYOUT, kitRecord, patternRecord } from "../src/project/dn2image.js";
import { type DeviceIo } from "../src/device/deviceproject.js";
import { RESPONSE_SIZES } from "../src/device/readplan.js";
import { DN1_LAYOUT } from "../src/project/dn2image.js";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "../src/device/api.js";
import { type Entry, StorageCode } from "../src/device/storage.js";
import { type ApiTransport } from "../src/device/storagesession.js";
import { probeWrite } from "./probesource.js";
import {
  CONTAINER_BANK_OFFSET,
  CONTAINER_SLOT_OFFSET,
  WriteRefusal,
  compareStored,
  describeRecordWrite,
  recordWriteMessage,
  safeWriteFile,
  safeWriteRecords,
  type Backup,
  type FileWriteReview,
  type RecordWriteReview,
  type SafeFileWriteOptions,
} from "../src/device/safewrite.js";

const PATTERN_KIT = DN2_LAYOUT.patternSize + DN2_LAYOUT.kitSize;

/** A kit half that carries a real object header, so the record declares a storage version. */
function stampKit(bytes: Uint8Array, at: number, version = 3): void {
  bytes.set([0xbe, 0xef, 0xba, 0xce, 0, 0, 0, version], at);
}

function patternKit(fill: number, version = 3): Uint8Array {
  const bytes = new Uint8Array(PATTERN_KIT).fill(fill);
  stampKit(bytes, DN2_LAYOUT.patternSize, version);
  return bytes;
}

function image(fill: number): Uint8Array {
  const bytes = new Uint8Array(DN2_LAYOUT.imageSize).fill(fill);
  for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) {
    stampKit(bytes, DN2_LAYOUT.kitBase + slot * DN2_LAYOUT.kitSize);
  }
  return bytes;
}

/**
 * The patternKit a slot of an image holds.
 *
 * **Deliberately not `patternKitRecord`**, even though that is the function the write and the
 * verifier now share. This is what the stub device holds and what the backup is checked against, so
 * deriving it from the same code would let a bug in that assembly satisfy both sides of every
 * assertion below. Three lines is a cheap independent witness.
 */
function recordOf(img: Uint8Array, slot: number): Uint8Array {
  const out = new Uint8Array(PATTERN_KIT);
  out.set(patternRecord(img, slot, DN2_LAYOUT), 0);
  out.set(kitRecord(img, slot, DN2_LAYOUT), DN2_LAYOUT.patternSize);
  return out;
}

/**
 * A device that actually holds patterns.
 *
 * The existing `fakeDevice` answers every request from a formula, which is enough for a read and
 * not enough for a write: half of what is tested here is that the *second* read returns what the
 * write put there. `silent` makes one slot stop answering, which is the case the backup rule exists
 * for.
 */
function stubDevice(initial: Uint8Array, options: { silent?: number[]; corrupt?: number[] } = {}) {
  const held = new Map<number, Uint8Array>();
  for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) held.set(slot, recordOf(initial, slot));
  const sent: ReturnType<typeof parseMessage>[] = [];
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const deliver = (bytes: Uint8Array): void => {
    for (const listener of [...listeners]) listener(bytes);
  };

  const io: DeviceIo = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    send: (bytes) => {
      const message = parseMessage(bytes);
      sent.push(message);
      if (message.dumpType === 0x50) {
        // A write. Kept, unless this slot is one the test says the device mangles.
        const stored = Uint8Array.from(message.payload);
        if (options.corrupt?.includes(message.objNr)) stored[0] = (stored[0]! ^ 0xff) & 0xff;
        held.set(message.objNr, stored);
        return;
      }
      if (message.dumpType === 0x60) {
        if (options.silent?.includes(message.objNr)) return;
        deliver(
          buildMessage({
            productId: ProductId.DN2,
            dumpType: 0x50,
            objNr: message.objNr,
            payload: held.get(message.objNr)!,
          }),
        );
      }
    },
    wait: async () => {},
  };
  return { io, sent, held };
}

/** The hooks a test supplies, recording what it was asked and what it was handed. */
function hooks(answer = true) {
  const backups: Backup[] = [];
  const reviews: RecordWriteReview[] = [];
  const gated: string[] = [];
  return {
    backups,
    reviews,
    /** Every step that happened, in order, so "the gate ran first" is a thing a test can say. */
    gated,
    gate: (): void => void gated.push("gate"),
    onBackup: (backup: Backup): void => {
      gated.push("backup");
      backups.push(backup);
    },
    confirm: (review: RecordWriteReview): boolean => {
      gated.push("confirm");
      reviews.push(review);
      return answer;
    },
  };
}

/** A project where slot 3 has been edited, which is the smallest real write. */
function editedPair(): { before: Uint8Array; after: Uint8Array } {
  const before = image(0x11);
  const after = Uint8Array.from(before);
  after.set(new Uint8Array(DN2_LAYOUT.patternSize).fill(0x22), DN2_LAYOUT.headerSize + 3 * DN2_LAYOUT.patternSize);
  return { before, after };
}

const witness = (): Uint8Array => patternKit(0);

// --- the sequence ---------------------------------------------------------------------------------

test("the destination is read, backed up and confirmed before anything is sent", async () => {
  const { before, after } = editedPair();
  const { io, sent } = stubDevice(before);
  const h = hooks();

  const result = await safeWriteRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
    gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.written, 1);
  assert.equal(result.verified, true, `mismatches: ${JSON.stringify(result.mismatches)}`);

  // Order on the wire is the whole claim: a read, then the write, then a read. A backup taken
  // afterwards is not a backup.
  const kinds = sent.map((m) => m.dumpType);
  assert.deepEqual(kinds, [0x60, 0x50, 0x60], "read for backup, write, read to verify");

  assert.equal(h.backups.length, 1);
  assert.deepEqual(h.backups[0]!.slots, [3]);
  assert.equal(h.reviews.length, 1);
  assert.deepEqual(h.reviews[0]!.labels, ["A4"]);
});

test("the backup carries the bytes that were there before, replayable", async () => {
  const { before, after } = editedPair();
  const { io } = stubDevice(before);
  const h = hooks();

  await safeWriteRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
    gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });

  // Parsed rather than compared as a blob: the point of the backup is that it can be sent straight
  // back to the instrument, so it has to be a real message addressed to the real slot.
  const restored = parseMessage(h.backups[0]!.bytes);
  assert.equal(restored.dumpType, 0x50);
  assert.equal(restored.objNr, 3);
  assert.deepEqual([...restored.payload], [...recordOf(before, 3)], "the backup is the OLD bytes");
});

test("a slot that does not answer stops the write entirely", async () => {
  // The case the rule is written for. A device that has gone quiet is exactly when a copy matters,
  // and "we could not read it" must never be the reason a write proceeds unbacked.
  const { before, after } = editedPair();
  const { io, sent } = stubDevice(before, { silent: [3] });
  const h = hooks();

  await assert.rejects(
    () => safeWriteRecords({
      productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
      gate: h.gate, onBackup: h.onBackup, confirm: h.confirm, timeoutMs: 10,
    }),
    (error: unknown) => error instanceof WriteRefusal && /no backup for A4/.test(String(error)),
  );

  assert.equal(sent.filter((m) => m.dumpType === 0x50).length, 0, "nothing was written");
  assert.equal(h.backups.length, 0);
  assert.equal(h.reviews.length, 0, "and nobody was asked to agree to a write that cannot happen");
});

test("a backup hook that throws stops the write", async () => {
  const { before, after } = editedPair();
  const { io, sent } = stubDevice(before);

  await assert.rejects(
    () => safeWriteRecords({
      productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
      gate: () => {},
      onBackup: () => { throw new Error("disk full"); },
      confirm: () => true,
    }),
    /disk full/,
  );
  assert.equal(sent.filter((m) => m.dumpType === 0x50).length, 0);
});

test("saying no sends nothing, and takes no backup either", async () => {
  const { before, after } = editedPair();
  const { io, sent } = stubDevice(before);
  const h = hooks(false);

  const result = await safeWriteRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
    gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.written, 0);
  assert.equal(sent.filter((m) => m.dumpType === 0x50).length, 0);
  // Confirm runs before the backup, so a cancelled write does not leave a downloaded file behind.
  assert.equal(h.backups.length, 0);
});

test("a missing hook is refused rather than defaulted", async () => {
  const { before, after } = editedPair();
  const { io } = stubDevice(before);
  const bad = { productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness() };

  await assert.rejects(
    // A caller that forgot is the case this module exists for, so it cannot be a silent default.
    () => safeWriteRecords({ ...bad, gate: () => {}, confirm: () => true } as never),
    (error: unknown) => error instanceof WriteRefusal && /backup hook/.test(String(error)),
  );
  await assert.rejects(
    () => safeWriteRecords({ ...bad, gate: () => {}, onBackup: () => {} } as never),
    (error: unknown) => error instanceof WriteRefusal && /confirmation hook/.test(String(error)),
  );
  await assert.rejects(
    () => safeWriteRecords({ ...bad, onBackup: () => {}, confirm: () => true } as never),
    (error: unknown) => error instanceof WriteRefusal && /write gate/.test(String(error)),
  );
});

test("a write with no gate is refused, on both paths, before the transport is touched", async () => {
  /*
   * **The reason this is a required option and not an optional one.** The switch lives in the
   * browser, in `web/src/writeenable.ts`, and it cannot go to core: there is no `sessionStorage`
   * on an instrument's host and no toolbar on Android. Core therefore takes one — and an optional
   * one is the sort a second host forgets, with no symptom at all. Everything works; the arming
   * step simply is not there.
   *
   * TypeScript catches the omission for a caller it compiles. This catches it for one it does
   * not: a plain object, a JSON-shaped call across a bridge, a host written in another language.
   */
  const { before, after } = editedPair();
  const { io, sent } = stubDevice(before);

  await assert.rejects(
    () => safeWriteRecords({
      productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
      onBackup: () => {}, confirm: () => true,
    } as never),
    (error: unknown) => error instanceof WriteRefusal && /write gate/.test(String(error)),
  );
  assert.deepEqual(sent, [], "refused before a byte went anywhere");

  const drive = slot(payload(0x11));
  const { gate: _dropped, ...ungated } = fileWrite(drive);
  await assert.rejects(
    () => safeWriteFile(ungated as never),
    (error: unknown) => error instanceof WriteRefusal && /write gate/.test(String(error)),
  );
  assert.deepEqual(drive.log, [], "and the +Drive was not listed, read or opened");
});

test("the gate runs first, and a gate that throws stops everything", async () => {
  // First of the three, because a refusal after the question has wasted the question and a
  // refusal after the backup has already spent the time reading the slot.
  const { before, after } = editedPair();
  const { io, sent } = stubDevice(before);
  const h = hooks();

  await safeWriteRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
    gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });
  assert.equal(h.gated[0], "gate", `the order was ${h.gated.join(", ")}`);

  const second = stubDevice(before);
  await assert.rejects(
    () => safeWriteRecords({
      productId: ProductId.DN2, io: second.io, before, after, layout: DN2_LAYOUT,
      witness: witness(),
      // What `requireWriteEnabled` does when the switch is off. Its own message reaches the
      // person, unwrapped, because it is the one that says what to do about it.
      gate: () => { throw new Error("Writing to the instrument is switched off."); },
      onBackup: () => {}, confirm: () => true,
    }),
    /switched off/,
  );
  assert.deepEqual(second.sent, [], "nothing was read and nothing was written");
  void sent;
});

test("a device that stores something else is reported unverified, with the offset", async () => {
  const { before, after } = editedPair();
  const { io } = stubDevice(before, { corrupt: [3] });
  const h = hooks();

  const result = await safeWriteRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
    gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });

  assert.equal(result.written, 1, "the write itself completed");
  assert.equal(result.verified, false, "and it is still not a success");
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]!.label, "A4");
  assert.equal(result.mismatches[0]!.at, 0);

  // The report has to shout, and it has to name the backup — that is what the person needs next.
  const message = recordWriteMessage(result);
  assert.equal(message.level, "error");
  assert.match(message.text, /NOT verified/);
  assert.match(message.text, /prewrite/);
});

test("a slot changed on the device since the read is named, not silently replaced", async () => {
  // Someone has been playing while the project sat open in the manager. The write still goes — an
  // image diff cannot be rebased and pretending otherwise would be worse — but never quietly.
  const { before, after } = editedPair();
  const moved = Uint8Array.from(before);
  moved.set(new Uint8Array(DN2_LAYOUT.patternSize).fill(0x77), DN2_LAYOUT.headerSize + 3 * DN2_LAYOUT.patternSize);
  const { io } = stubDevice(moved);
  const h = hooks();

  const result = await safeWriteRecords({
    productId: ProductId.DN2, io, before, after, layout: DN2_LAYOUT, witness: witness(),
    gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });

  assert.deepEqual(result.moved, ["A4"]);
  assert.deepEqual(h.reviews[0]!.moved, ["A4"], "and the person was told before agreeing");
  assert.match(describeRecordWrite(h.reviews[0]!).join(" "), /changed on the device since/);
});

test("an unedited project asks nothing and sends nothing", async () => {
  const before = image(0x11);
  const { io, sent } = stubDevice(before);
  const h = hooks();

  const result = await safeWriteRecords({
    productId: ProductId.DN2, io, before, after: Uint8Array.from(before), layout: DN2_LAYOUT,
    witness: witness(), gate: h.gate, onBackup: h.onBackup, confirm: h.confirm,
  });

  assert.equal(result.written, 0);
  assert.equal(result.verified, true);
  assert.equal(sent.length, 0, "not even a backup read — there is no destination");
  assert.equal(h.reviews.length, 0, "and no dialog for a write that would do nothing");
});

// --- what the person is told ----------------------------------------------------------------------

test("the confirmation never leaves out what a write reaches", () => {
  const lines = describeRecordWrite({
    deviceName: "Digitone II",
    slots: [0, 3],
    labels: ["A1", "A4"],
    moved: [],
    untransmittable: ["the tail — the sound pool, project settings…"],
    bytes: 2 * PATTERN_KIT,
  }).join(" ");

  assert.match(lines, /2 patterns on the Digitone II will be overwritten: A1, A4/);
  // A write lands in the active project and is lost when another is loaded. Somebody who is not
  // told that loses the work by turning a knob.
  assert.match(lines, /SAVE PROJECT/);
  assert.match(lines, /NOT sent/);
  // And the last line is always the backup, so no dialog can imply it is optional.
  assert.match(lines, /copy of every destination pattern is saved first[^]*$/);
});

test("a verified write still says the project is not saved", () => {
  const message = recordWriteMessage({
    cancelled: false, written: 2, bytes: 1000, untransmittable: [], mismatches: [],
    verified: true, moved: [],
  });
  assert.equal(message.level, "ok");
  assert.match(message.text, /verified byte-for-byte/);
  assert.match(message.text, /SAVE PROJECT/);
});

// --- the +Drive comparison ------------------------------------------------------------------------

test("the slot index the device stamps itself is not a corruption", () => {
  // `/kits/A/1` written into `/kits/A/38` read back differing in exactly this byte. A comparison
  // that did not know would call every correct kit write a failure.
  const sent = new Uint8Array(64).fill(1);
  const back = Uint8Array.from(sent);
  back[CONTAINER_SLOT_OFFSET] = 37;
  assert.deepEqual(compareStored(sent, back), []);

  // Any other byte is a real difference, including one right beside it.
  back[CONTAINER_SLOT_OFFSET + 1] = 9;
  const found = compareStored(sent, back);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.at, CONTAINER_SLOT_OFFSET + 1);
});

test("a short read-back is a mismatch, not a partial match", () => {
  const found = compareStored(new Uint8Array(64), new Uint8Array(32));
  assert.equal(found.length, 1);
  assert.match(found[0]!.reason, /sent 64 bytes/);
});

// --- one fact, one home ---------------------------------------------------------------------------

test("a patternKit's size agrees with the two records it is made of", () => {
  // The fifth fact this codebase had written down twice, found because `readBackRecords` declared
  // `layout.patternSize` for a reply that is `patternSize + kitSize` — 89% of the timeout it needed.
  // It never bit because nothing called the function until the safe write path did.
  for (const [productId, layout] of [
    [ProductId.DN1, DN1_LAYOUT],
    [ProductId.DN2, DN2_LAYOUT],
  ] as const) {
    assert.equal(RESPONSE_SIZES[productId]!.patternKit, layout.patternSize + layout.kitSize);
  }
});

// --- the fence ------------------------------------------------------------------------------------

/**
 * Modules that may reach a mutating primitive, and why each is allowed.
 *
 * Written as the reason rather than as a list of paths: an exemption whose justification is not
 * beside it is an exemption nobody re-checks. Adding a path here should require writing a sentence
 * that survives being read out loud.
 */
const ALLOWED: Record<string, { paths: string[]; because: string }> = {
  writeChangedRecords: {
    paths: ["src/device/safewrite.ts"],
    because: "the safe path is the only caller; it backs up, asks and verifies around this",
  },
  writeStoredFile: {
    paths: ["src/device/safewrite.ts"],
    because: "same, for the +Drive",
  },
  // The probe's two builders. They *build* a message rather than send one, and the probe's own
  // write does the occupancy check, the confirmation, the backup and the read-back inline — all
  // five rules, since 2026-09-08. It is exempt because it writes **one captured record to an
  // arbitrary slot**, which is not an image diff and cannot go through `safeWriteRecords` at all.
  //
  // The backup was the one they lacked, and the tests at the bottom of this file are what keep it:
  // the destination is read fresh, the copy is offered after the question, and nothing goes out
  // before the copy exists. `writeBack` gained the same read on 2026-09-08, and with it the check
  // that its round trip is still the null one it calls itself.
  writeToSlot: {
    paths: ["web/src/probe/writeslot.ts"],
    because: "the probe writes one captured record to a chosen slot, which is not an image diff",
  },
  nullRoundTrip: {
    paths: ["web/src/probe/writeback.ts"],
    because: "the same, for a record sent back to the slot it came from",
  },
};

/** Where a permit may be minted. One in the shipped code, one for tests that need the primitives. */
const MAY_MINT = ["src/device/safewrite.ts", "test/permit.ts"];

function sourceFiles(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
  };
  for (const root of roots) walk(join(import.meta.dirname, "..", root));
  return out;
}

/** Every name a file imports, from anywhere. Import statements only — prose is not a call. */
function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

test("the import reader sees the forms this codebase actually writes", () => {
  // The scan below is only as good as this, and a parser that quietly matched nothing would make
  // every future violation invisible while the test kept passing. So it is checked against the
  // shapes in the tree — multi-line, `type`-prefixed, aliased — before it is trusted.
  const source = [
    `import {`,
    `  type DeviceIo,`,
    `  writeChangedRecords,`,
    `} from "../../src/device/deviceproject.js";`,
    `import { writeStoredFile as raw } from "./storagewrite.js";`,
    `// import { nullRoundTrip } from "./dumpwrite.js";`,
  ].join("\n");

  const names = importedNames(source);
  assert.ok(names.includes("writeChangedRecords"), "a multi-line import was missed");
  assert.ok(names.includes("DeviceIo"), "a type-prefixed name was missed");
  assert.ok(names.includes("writeStoredFile"), "an aliased import was missed — the alias hid it");
});

test("nothing reaches a mutating primitive except the safe path", () => {
  const files = sourceFiles("src", "web/src");
  // A scan that finds nothing passes, and looks exactly like a scan that ran. Prove it read the
  // tree it was pointed at before believing its silence.
  assert.ok(files.length > 80, `only ${files.length} source files found — the scan is looking in the wrong place`);

  const offences: string[] = [];
  for (const file of files) {
    const rel = relative(join(import.meta.dirname, ".."), file).replaceAll("\\", "/");
    for (const name of importedNames(readFileSync(file, "utf8"))) {
      const rule = ALLOWED[name];
      if (rule && !rule.paths.includes(rel)) {
        offences.push(`${rel} imports ${name} — only ${rule.paths.join(", ")} may, because ${rule.because}`);
      }
    }
  }

  assert.deepEqual(offences, [], offences.join("\n"));
});

test("the primitives are still guarded, so the scan is testing something", () => {
  // The counterpart to the scan: it can only pass honestly if the names it looks for are the names
  // that actually mutate an instrument. If `writeChangedRecords` were renamed or its permit
  // dropped, the scan above would keep passing while protecting nothing.
  const safe = readFileSync(join(import.meta.dirname, "..", "src/device/safewrite.ts"), "utf8");
  for (const name of ["writeChangedRecords", "writeStoredFile"]) {
    assert.match(safe, new RegExp(`\\b${name}\\b`), `${name} is not called by the safe path any more`);
  }
  for (const [path, symbol] of [
    ["src/device/deviceproject.ts", "permit: WritePermit"],
    ["src/device/storagewrite.ts", "permit: WritePermit"],
  ] as const) {
    const source = readFileSync(join(import.meta.dirname, "..", path), "utf8");
    assert.match(source, new RegExp(symbol), `${path} no longer demands a permit`);
  }
});

/**
 * Comments removed, so a scan cannot be tripped by a module explaining itself.
 *
 * Crude on purpose — it is not a parser, and a `//` inside a string literal would confuse it. That
 * is fine for what it is used for: a false *positive* here fails a test somebody then reads, which
 * is the direction an approximation is allowed to be wrong in.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("only the two named places can mint a permit", () => {
  const files = [...sourceFiles("src", "web/src"), ...sourceFiles("test")];
  const minting: string[] = [];
  for (const file of files) {
    const rel = relative(join(import.meta.dirname, ".."), file).replaceAll("\\", "/");
    // This file has to contain the pattern in order to look for it, which no other file does.
    if (rel === "test/safewrite.test.ts") continue;
    if (/as unknown as WritePermit/.test(withoutComments(readFileSync(file, "utf8")))) {
      minting.push(rel);
    }
  }
  assert.deepEqual(minting.sort(), [...MAY_MINT].sort());
});

// --- the +Drive file path: overwriting, and what it costs ----------------------------------------
//
// The empty-slot rule used to stand in for a backup: nothing could be written anywhere occupied, so
// there was never anything to copy. Saving a project back over the slot it was opened from is the
// case that argument does not cover, so the rule now has an opening — and these are the tests that
// keep the opening the shape it was cut. **A backup is not optional on this path any more; it is
// what replaced the rule that made it unnecessary.**

/** The stored-form flag at `+29`, without which the write path refuses the payload outright. */
function payload(fill: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  bytes[29] = 0x01;
  return bytes;
}

/**
 * A +Drive slot that can be read and written, and remembers the order it was asked.
 *
 * `holds` is what a read returns — so a backup taken before the write gets the old contents and one
 * taken after would get the new, which is the difference these tests are looking for. The write
 * replaces it at the commit, exactly as the instrument does.
 */
function slot(
  holds: Uint8Array,
): ApiTransport & { log: number[]; holds: Uint8Array; opens: Uint8Array[] } {
  const state = { log: [] as number[], holds, opens: [] as Uint8Array[] };
  let staged: number[] = [];
  return {
    ...state,
    get log(): number[] { return state.log; },
    get holds(): Uint8Array { return state.holds; },
    // The open request verbatim, because the stored-form flag is a byte of it and nothing else
    // observable says which of the two files the device was asked for.
    get opens(): Uint8Array[] { return state.opens; },
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      state.log.push(code);
      if (code === StorageCode.Open) state.opens.push(body);
      const reply = (b: number[]): ApiFrame => ({
        msgId, respId: msgId, code: code | RESPONSE_BIT, body: Uint8Array.from(b), isResponse: true, terminated: true,
      });
      switch (code) {
        case StorageCode.Open: return Promise.resolve(reply([1, 0, 0, 0, 1, 0, 0, 8, 0, 1]));
        case StorageCode.Read: {
          // Sequence 0 draws the empty leading reply and sequence 1 the file, which is the shape
          // `readStoredFile` expects — the whole slot fits in one chunk at 64 bytes.
          const seq = ((body[4] ?? 0) << 24) | ((body[5] ?? 0) << 16) | ((body[6] ?? 0) << 8) | (body[7] ?? 0);
          if (seq === 0) {
            return Promise.resolve(reply([1, 0, 0, 0, 1, 0x40, 0x12, 0xc3, 0x44, 0x41, 0xbc, 0xff,
              0x90, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
          }
          const data = [...state.holds];
          return Promise.resolve(reply([
            1, 0, 0, 0, 1, ...u32be(1), 0, 0, 3, 0xe8, 1, 0, 0, 0, 0, ...u32be(data.length), ...data,
          ]));
        }
        case StorageCode.Close: return Promise.resolve(reply([1, 0, 0, 0, 1, 0, 0, 0, 0x81]));
        case StorageCode.WriteOpen: staged = []; return Promise.resolve(reply([1, 0, 0, 0, 7]));
        case StorageCode.Write:
          staged.push(...body.subarray(16));
          return Promise.resolve(reply([1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 1, 0]));
        case StorageCode.WriteClose:
          state.holds = Uint8Array.from(staged);
          return Promise.resolve(reply([1, 0, 0, 0, 7, 0, 0, 1, 0]));
        default: return Promise.reject(new Error(`unexpected 0x${code.toString(16)}`));
      }
    },
  };
}

function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function occupied(over: Partial<Entry> = {}): Entry {
  return { name: "MORNING_JAM", kind: "file", index: 5, occupied: true, writable: true, ...over };
}

function fileWrite(io: ApiTransport, over: Partial<SafeFileWriteOptions> = {}): SafeFileWriteOptions {
  return {
    gate: () => {},
    transport: io,
    path: "/projects/6",
    name: "SONGWORK",
    bytes: payload(0x22),
    target: occupied(),
    confirm: () => true,
    ...over,
  };
}

test("an empty slot still takes no backup — nothing there to copy", async () => {
  const io = slot(new Uint8Array());
  let asked = 0;
  const result = await safeWriteFile(
    fileWrite(io, { target: occupied({ occupied: false, name: "" }), onBackup: () => void asked++ }),
  );

  assert.equal(asked, 0, "an onBackup passed for an empty slot is ignored, not called for form's sake");
  assert.equal(result.committed, true);
});

test("overwriting without a backup hook is refused before anything is sent", async () => {
  // The pairing, as behaviour. `refuseUnlessEmpty` was the reason this path could skip the backup;
  // the moment a caller can get past it, the backup is the thing standing where the rule stood.
  const io = slot(payload(0x11));
  await assert.rejects(
    safeWriteFile(fileWrite(io, { overwrite: true })),
    (error: Error) => error instanceof WriteRefusal && /without a backup hook/.test(error.message),
  );
  assert.deepEqual(io.log, [], "refused before the transport was touched at all");
});

test("the copy is named after the clock it was handed, not the one on the wall", async () => {
  /*
   * The backup's name carried the real time, so the one output of a write that proves it took a
   * copy was the one output no test could assert on. The clock is an option now, the way the
   * record write beside this has always had one. See `test/determinism.test.ts` for the rule.
   */
  const io = slot(payload(0x11));
  const backups: Backup[] = [];
  await safeWriteFile(fileWrite(io, {
    overwrite: true,
    onBackup: (b) => void backups.push(b),
    now: () => new Date("2026-09-22T10:11:12Z"),
  }));

  assert.equal(backups[0]!.name, "MORNING_JAM-before-2026-09-22T10-11-12.payload");
});

test("the backup holds what was in the slot, and is taken before the first byte goes out", async () => {
  const io = slot(payload(0x11));
  const backups: Backup[] = [];
  const result = await safeWriteFile(
    fileWrite(io, { overwrite: true, onBackup: (b) => void backups.push(b) }),
  );

  assert.equal(backups.length, 1);
  assert.deepEqual([...backups[0]!.bytes], [...payload(0x11)], "the old contents, not the new");

  // **The form, which the first hardware run got wrong.** `readStoredFile` defaults to raw, so a
  // backup taken without asking is a 12.9 MB image that `refuseRawForm` rejects on the way back —
  // unrestorable, and the only thing standing where the empty-slot rule used to. The flag is the
  // last byte of the open request.
  const open = io.opens[0];
  assert.ok(open, "the backup opened the file");
  assert.equal(open.at(-1), 0x01, "the backup asks for STORED_FORM, not the raw image");
  assert.deepEqual(backups[0]!.slots, [5]);
  assert.match(backups[0]!.name, /^MORNING_JAM-before-/, "named after what it is a copy of");

  /*
   * **The name has to be honest about what the bytes are.** These are the file's payload; a
   * `.dn2prj` is that payload inside a zip beside a manifest. It was named `.dn2prj` until
   * 2026-09-08, when the copy taken before a real overwrite of `/projects/17` turned out to open
   * in nothing — 293,332 bytes starting `ac11d303`, the Elektron object magic, where a project
   * file starts `PK`. The confirmation calls that copy the only undo there is.
   *
   * Wrapping it into a real project file needs the instrument's firmware, which the library does
   * not have; the caller that does is the one that wraps. `kind` is how it knows this is a file
   * payload rather than the pattern path's SysEx.
   */
  assert.equal(backups[0]!.kind, "storedFile");
  assert.doesNotMatch(backups[0]!.name, /\.dn2prj$/, "a payload must not be named as a project file");
  assert.match(backups[0]!.name, /\.payload$/);

  // The ordering that matters: the read that took the copy finished before the write opened. Only
  // the first Close counts — the verifying read afterwards opens and closes the file again.
  const opened = io.log.indexOf(StorageCode.WriteOpen);
  assert.ok(io.log.indexOf(StorageCode.Close) < opened, "backed up before the write opened");
  assert.equal(result.committed, true);
  assert.deepEqual([...io.holds], [...payload(0x22)], "and the slot now holds the new project");
});

test("a backup that cannot be saved stops the write", async () => {
  // The record path's rule, and for the same reason: a browser that blocked the download leaves the
  // person with no copy, and this is the one path where that copy is the only one.
  const io = slot(payload(0x11));
  await assert.rejects(
    safeWriteFile(fileWrite(io, {
      overwrite: true,
      onBackup: () => { throw new Error("download blocked"); },
    })),
    /download blocked/,
  );
  assert.deepEqual([...io.holds], [...payload(0x11)], "the slot is untouched");
  assert.equal(io.log.includes(StorageCode.WriteOpen), false);
});

test("the confirmation is told what is being destroyed, not just where it is going", async () => {
  // "Save to slot 5" and "replace MORNING_JAM in slot 5" are different questions. A hook that is
  // handed the same review for both cannot ask the second one.
  const reviews: FileWriteReview[] = [];
  await safeWriteFile(fileWrite(slot(payload(0x11)), {
    overwrite: true,
    onBackup: () => {},
    confirm: (review) => { reviews.push(review); return true; },
  }));
  assert.equal(reviews[0]?.replacing, "MORNING_JAM");

  reviews.length = 0;
  await safeWriteFile(fileWrite(slot(new Uint8Array()), {
    target: occupied({ occupied: false, name: "" }),
    confirm: (review) => { reviews.push(review); return true; },
  }));
  assert.equal(reviews[0]?.replacing, undefined, "an empty slot replaces nothing, and says so");
});

test("saying no to an overwrite costs nothing — no backup, no write", async () => {
  const io = slot(payload(0x11));
  let asked = 0;
  const result = await safeWriteFile(fileWrite(io, {
    overwrite: true,
    onBackup: () => void asked++,
    confirm: () => false,
  }));

  assert.equal(result.cancelled, true);
  assert.equal(asked, 0, "a backup downloaded for a write nobody made is litter");
  assert.deepEqual(io.log, [], "and nothing reached the device");
});

test("the two bytes the instrument writes for itself are not reported as corruption", () => {
  /*
   * **Measured on a Digitone II, 2026-09-07.** `/soundbanks/A/1` written into `/soundbanks/H/129`
   * read back differing in two bytes of 334: `+23` carried `7` for bank H and `+24` carried `128`
   * for slot 129, both zero-based, both written by the instrument.
   *
   * The earlier kit experiment wrote `/kits/A/1` into `/kits/A/38` — one bank, so the bank byte
   * never moved and `+24` looked like the only stamp. **A test that varies one coordinate cannot
   * tell you about the other.**
   *
   * Anything else differing is the device not storing what was sent, and has to still be reported.
   */
  const sent = new Uint8Array(64);
  const read = new Uint8Array(64);
  read[CONTAINER_BANK_OFFSET] = 7;
  read[CONTAINER_SLOT_OFFSET] = 128;
  assert.deepEqual(compareStored(sent, read), [], "the instrument's own stamps are not corruption");

  read[40] = 1;
  const found = compareStored(sent, read);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.at, 40, "a real difference is still named, and named first");
});

test("every read of a file the writer touches asks for the stored form", () => {
  /*
   * **A fix applied to one of two calls is half a fix.**
   *
   * `safeWriteFile` reads a file twice: once to back the destination up, once to verify the write.
   * Both compare against `bytes`, which `refuseRawForm` guarantees is the stored payload. The
   * backup read was corrected on 2026-08-15 and the verify read was not, so `verified` was false
   * for every file write that had ever run — a 10,795-byte image compared against a 3,481-byte
   * payload, returning `compareStored`'s length mismatch.
   *
   * Nothing failed loudly. A tool that reports a write as unverified reads as a cautious tool, and
   * the note explaining the first fix sat forty lines above the call that still needed it.
   *
   * Read out of the source because both calls need a device. The property is that no
   * `readStoredFile` inside this module defaults its form.
   */
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "device", "safewrite.ts"), "utf8");

  const calls = [...source.matchAll(/readStoredFile\(([\s\S]*?)\n  \}\);/g)];
  assert.ok(calls.length >= 2, `found ${calls.length} readStoredFile calls; expected the backup and the verify`);
  for (const [index, call] of calls.entries()) {
    assert.match(call[0]!, /form:\s*STORED_FORM/,
      `readStoredFile call ${index + 1} defaults to the raw image and compares it against a stored payload`);
  }
});

/*
 * The probe's two writes, read out of their own source by `probesource.ts`.
 *
 * They are exempt from `safeWriteRecords` for the reason recorded beside the exemption above, so
 * nothing structural makes them follow its sequence. This is what does.
 */

for (const name of ["writeToChosenSlot", "writeBack"]) {
  test(`the probe's ${name} copies what it overwrites before it sends anything`, () => {
    /*
     * **The fifth safe-write rule, on the one page exempt from the other four.**
     *
     * `writeToChosenSlot` carried the occupancy check, the confirmation and the read-back inline
     * and no backup at all: the destination's contents came from `splitCapture()`, so a slot nobody
     * had happened to read was overwritten with nothing kept, under a confirmation that said so out
     * loud (*"not in the capture — unknown"*). `writeBack` had the narrower version of the same
     * hole: it promised the bytes were identical to what the device just sent, which stops being
     * true the moment somebody turns a knob between the read and the write.
     *
     * The order is the part that is easy to get subtly wrong, so it is the part pinned here: the
     * destination is read before the question is asked, the file is offered after the answer, and
     * **nothing is sent until the copy exists**. `safeWriteFile` settled that order for the reason
     * quoted beside it there — a backup downloaded for a write somebody then cancels is rude, and a
     * write that began before the copy was taken is worse.
     */
    const body = probeWrite(name);
    const at = (needle: string): number => {
      const index = body.indexOf(needle);
      assert.ok(index > 0, `${name} no longer contains ${needle}`);
      return index;
    };

    const read = at("await awaitPatternKit(");
    const ask = at("await askConfirm(");
    const copy = at("saveBytesTo(backup.bytes");
    const send = at("output.send(");

    assert.ok(read < ask, "the destination must be read before the person is asked about it");
    assert.ok(ask < copy, "a file downloaded for a write somebody then cancels is rude");
    assert.ok(copy < send, "the write began before the copy was taken");
    assert.ok(body.includes("buildRecordBackup("),
      "the copy must be the same replayable .syx the safe path writes, not a bespoke one");
  });
}

test("the probe's slot write judges occupancy from the device, not from the capture", () => {
  /*
   * The specific shape of the state that had no backup: `messages.find(m => … m.objNr ===
   * destination)`. Kept as its own assertion because it is the mistake somebody would reintroduce
   * while making the page feel faster.
   */
  assert.doesNotMatch(probeWrite("writeToChosenSlot"), /objNr === destination/,
    "the destination is being looked up in the capture again, which is the state that had no copy");
});

test("the null round trip checks that it is still null", () => {
  /*
   * `writeBack`'s own property, and the interesting half of its fix. The copy matters, but a null
   * round trip that turns out not to be null is a **result**, and this page exists to record
   * results — so the drift is compared and shown whatever the person then decides.
   */
  const body = probeWrite("writeBack");
  assert.ok(body.includes("driftSince("),
    "writeBack no longer compares the capture against what the slot holds now");
  // Read out of the confirmation itself rather than the whole function, so that prose recording
  // what the old wording claimed does not satisfy or fail the check.
  const ask = body.indexOf("await askConfirm(");
  const confirmation = body.slice(ask, body.indexOf("}))", ask));
  assert.match(confirmation, /drift\.same/,
    "the question no longer depends on whether the slot still holds what was captured");
});
