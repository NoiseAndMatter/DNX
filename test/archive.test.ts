/**
 * The zip container DNX writes, pinned field by field before the two writers become one.
 *
 * A `.dnprj`, a `.dn2prj` and a `.dnx` are all zips, and they are opened by Elektron Transfer and
 * by the instruments' own tooling as well as by DNX. So the bytes are an external contract: the
 * container may be rewritten, and it may not change.
 *
 * ## Why this pins the container and not the compressed bytes
 *
 * Two writers produce the format today. `src/node/zip.ts` deflates with `node:zlib`'s
 * `deflateRawSync`; `web/src/zip.ts` deflates with `CompressionStream("deflate-raw")`. Deflate
 * output is not byte-stable across implementations — the same input compresses differently under a
 * different zlib build, a different level, or a browser's own encoder — so one committed file
 * cannot be the golden for both.
 *
 * What both writers *can* be held to is the container: every header field, the central directory,
 * the end record, and the arithmetic that ties them together. That is what `shapeOf` returns, with
 * the four numbers that move when the compressed length moves left out of it and checked instead
 * by `assertConsistent`. The byte golden below covers the Node writer alone, because `node:zlib` is
 * the one codec this test suite can reproduce.
 *
 * Measured 2026-09-20 on Node v24.19.0: the two writers happen to agree byte for byte, because
 * Node backs `CompressionStream` with the same zlib the sync call uses. That is a property of this
 * host, not of the format, so nothing here asserts it.
 *
 * ## What the corpus files say the container may be
 *
 * All 81 real projects (55 DN1, 26 DN2) hold exactly two entries, method 8, no extra field, no
 * comment and no data descriptor. Elektron's own writer sets "version needed" 10, the UTF-8 name
 * flag 0x0800 and a real modification time; DNX writes 20, no flags and a zero time, and both
 * Transfer and the instruments accept them. **That difference is the shipped behaviour and is
 * pinned here deliberately** — a later reader that started matching Elektron's fields would be
 * changing bytes that already work.
 *
 * To regenerate the byte golden after a deliberate change:
 *
 *   DNX_UPDATE_GOLDEN=1 npx tsx --test test/archive.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32 as zlibCrc32 } from "node:zlib";
import { buildZip as buildZipSync } from "../src/node/zip.js";
import { parseProject } from "../src/node/projectfile.js";
import { buildZip as buildZipAsync, crc32, readZip } from "../web/src/zip.js";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, SKIP_REASON, corpusFiles } from "./corpus.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "archive");
const GOLDEN = join(FIXTURES, "container.zip");
const UPDATE = process.env["DNX_UPDATE_GOLDEN"] === "1";

/**
 * Bytes that compress, without being a project.
 *
 * A fixed linear congruential generator rather than `Math.random`, so the golden file is the same
 * on every machine and every run. The runs of `0xac` give deflate real matches to find, so the
 * compressed length is not simply the input length plus a header.
 */
function sample(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x1234_5678;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    out[i] = i % 97 < 40 ? 0xac : (x >>> 16) & 0xff;
  }
  return out;
}

/** The two entries a project file holds, with a name that carries a space and no extension. */
const ENTRIES = [
  {
    name: "manifest.json",
    data: new TextEncoder().encode(
      JSON.stringify(
        {
          FormatVersion: "1.0",
          ProductType: ["24", "30"],
          Payload: "002 MORNING_JAM",
          FileType: "Project",
          FirmwareVersion: "1.43",
        },
        undefined,
        2,
      ),
    ),
  },
  { name: "002 MORNING_JAM", data: sample(40_000) },
];

const LOCAL_HEADER = 0x0403_4b50;
const CENTRAL_HEADER = 0x0201_4b50;
const END_OF_CENTRAL = 0x0605_4b50;

interface Local {
  versionNeeded: number;
  flags: number;
  method: number;
  modTime: number;
  modDate: number;
  crc: number;
  uncompressedSize: number;
  extraLength: number;
  name: string;
}

interface Central extends Local {
  versionMadeBy: number;
  commentLength: number;
  diskStart: number;
  internalAttributes: number;
  externalAttributes: number;
}

interface End {
  disk: number;
  centralDisk: number;
  countOnDisk: number;
  countTotal: number;
  centralSize: number;
  commentLength: number;
}

/**
 * Every field of the container, except the four that move with the compressed length.
 *
 * Compressed sizes and the offsets derived from them are left out so the same expectation covers a
 * writer whose deflate differs. `assertConsistent` checks those numbers against each other, which
 * is the only thing that can be checked about them without fixing the codec.
 */
function shapeOf(file: Uint8Array): { locals: Local[]; centrals: Central[]; end: End } {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const text = (at: number, length: number) => new TextDecoder().decode(file.subarray(at, at + length));

  const locals: Local[] = [];
  let at = 0;
  while (at + 30 <= file.length && view.getUint32(at, true) === LOCAL_HEADER) {
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    locals.push({
      versionNeeded: view.getUint16(at + 4, true),
      flags: view.getUint16(at + 6, true),
      method: view.getUint16(at + 8, true),
      modTime: view.getUint16(at + 10, true),
      modDate: view.getUint16(at + 12, true),
      crc: view.getUint32(at + 14, true),
      uncompressedSize: view.getUint32(at + 22, true),
      extraLength,
      name: text(at + 30, nameLength),
    });
    at += 30 + nameLength + extraLength + view.getUint32(at + 18, true);
  }

  const centrals: Central[] = [];
  while (at + 46 <= file.length && view.getUint32(at, true) === CENTRAL_HEADER) {
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    centrals.push({
      versionMadeBy: view.getUint16(at + 4, true),
      versionNeeded: view.getUint16(at + 6, true),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      modTime: view.getUint16(at + 12, true),
      modDate: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      uncompressedSize: view.getUint32(at + 24, true),
      extraLength,
      commentLength,
      diskStart: view.getUint16(at + 34, true),
      internalAttributes: view.getUint16(at + 36, true),
      externalAttributes: view.getUint32(at + 38, true),
      name: text(at + 46, nameLength),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }

  assert.equal(view.getUint32(at, true), END_OF_CENTRAL, "no end-of-central-directory record");
  const end: End = {
    disk: view.getUint16(at + 4, true),
    centralDisk: view.getUint16(at + 6, true),
    countOnDisk: view.getUint16(at + 8, true),
    countTotal: view.getUint16(at + 10, true),
    centralSize: view.getUint32(at + 12, true),
    commentLength: view.getUint16(at + 20, true),
  };

  return { locals, centrals, end };
}

/** The sizes and offsets `shapeOf` drops, checked against each other rather than against a number. */
function assertConsistent(file: Uint8Array, label: string): void {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);

  const localAt: number[] = [];
  const compressed: number[] = [];
  let at = 0;
  while (at + 30 <= file.length && view.getUint32(at, true) === LOCAL_HEADER) {
    localAt.push(at);
    compressed.push(view.getUint32(at + 18, true));
    at += 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + view.getUint32(at + 18, true);
  }

  const centralStart = at;
  let index = 0;
  while (at + 46 <= file.length && view.getUint32(at, true) === CENTRAL_HEADER) {
    assert.equal(view.getUint32(at + 42, true), localAt[index],
      `${label}: central entry ${index} points at the wrong local header`);
    assert.equal(view.getUint32(at + 20, true), compressed[index],
      `${label}: central entry ${index} records a different compressed size from its local header`);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    index += 1;
  }

  assert.equal(index, localAt.length, `${label}: the central directory and the entries disagree in count`);
  assert.equal(view.getUint32(at + 16, true), centralStart, `${label}: the end record points elsewhere`);
  assert.equal(view.getUint32(at + 12, true), at - centralStart, `${label}: the central directory size is wrong`);
  assert.equal(at + 22, file.length, `${label}: bytes after the end record, or the file is short`);
}

/**
 * The container, written out.
 *
 * `crc` is a literal rather than a call to `crc32`, so the writer cannot satisfy this by being
 * wrong in the same way twice. Both values are the standard CRC-32 of the entry data.
 */
const CONTAINER = {
  locals: [
    {
      versionNeeded: 20, flags: 0, method: 8, modTime: 0, modDate: 0,
      crc: 0x2d45_ebf5, uncompressedSize: 157, extraLength: 0, name: "manifest.json",
    },
    {
      versionNeeded: 20, flags: 0, method: 8, modTime: 0, modDate: 0,
      crc: 0x0fc9_1a9a, uncompressedSize: 40_000, extraLength: 0, name: "002 MORNING_JAM",
    },
  ],
  centrals: [
    {
      versionMadeBy: 20, versionNeeded: 20, flags: 0, method: 8, modTime: 0, modDate: 0,
      crc: 0x2d45_ebf5, uncompressedSize: 157, extraLength: 0, commentLength: 0, diskStart: 0,
      internalAttributes: 0, externalAttributes: 0, name: "manifest.json",
    },
    {
      versionMadeBy: 20, versionNeeded: 20, flags: 0, method: 8, modTime: 0, modDate: 0,
      crc: 0x0fc9_1a9a, uncompressedSize: 40_000, extraLength: 0, commentLength: 0, diskStart: 0,
      internalAttributes: 0, externalAttributes: 0, name: "002 MORNING_JAM",
    },
  ],
  end: { disk: 0, centralDisk: 0, countOnDisk: 2, countTotal: 2, centralSize: 120, commentLength: 0 },
};

test("the Node writer builds the container DNX has always written", () => {
  const built = buildZipSync(ENTRIES);
  assertConsistent(built, "node");
  assert.deepEqual(shapeOf(built), CONTAINER);
});

test("the browser writer builds the same container", async () => {
  const built = await buildZipAsync(ENTRIES);
  assertConsistent(built, "browser");
  assert.deepEqual(shapeOf(built), CONTAINER,
    "the two writers must agree on every field of the container; only the deflated bytes may differ");
});

test("the Node writer's bytes are unchanged", () => {
  // The byte golden covers one writer, because `node:zlib` is the one codec every run of this
  // suite has. It catches a change of compression level or strategy, which the field-by-field
  // check above cannot see.
  const built = buildZipSync(ENTRIES);
  if (UPDATE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(GOLDEN, built);
  }
  assert.ok(existsSync(GOLDEN), `${GOLDEN} is missing; regenerate with DNX_UPDATE_GOLDEN=1`);
  assert.deepEqual(built, new Uint8Array(readFileSync(GOLDEN)),
    "the Node writer's output changed. If that was deliberate, regenerate with DNX_UPDATE_GOLDEN=1 " +
      "and say in the commit why bytes Elektron Transfer reads are moving.");
});

test("crc32 is the standard one, and agrees with zlib on every entry", () => {
  // "123456789" has a documented CRC-32 of 0xCBF43926. The zlib comparison is the useful half:
  // the Node writer takes its checksum from zlib and the browser writer computes its own, and a
  // file whose two checksums disagreed would be rejected by one reader and not the other.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf4_3926);
  for (const entry of ENTRIES) assert.equal(crc32(entry.data), zlibCrc32(entry.data) >>> 0, entry.name);
});

test("both readers read both writers", async () => {
  for (const [label, built] of [
    ["node", buildZipSync(ENTRIES)],
    ["browser", await buildZipAsync(ENTRIES)],
  ] as [string, Uint8Array][]) {
    const read = await readZip(built);
    assert.deepEqual([...read.keys()], ENTRIES.map((e) => e.name), `${label}: entry names or order changed`);
    for (const entry of ENTRIES) assert.deepEqual(read.get(entry.name), entry.data, `${label}: ${entry.name}`);
  }
});

/**
 * Every real project, through the reader and back out again.
 *
 * Synthetic entries cannot prove much about a format nobody here invented. These are 81 files
 * written by Elektron's own tooling over several firmware versions, and they are the only evidence
 * that the reader handles what actually arrives rather than what DNX itself produces.
 *
 * The rebuild is checked at the payload, not at the file: re-zipping a project never reproduces
 * Elektron's bytes, because their writer sets a modification time and a different "version needed"
 * and compresses differently. Checked on all 81 on 2026-09-20 — none matched, and none should.
 */
const PROJECTS = [
  ...corpusFiles(DN1_PROJECTS, ".dnprj"),
  ...corpusFiles(DN2_PROJECTS, ".dn2prj"),
];

test("every corpus project reads, and survives a rebuild", { skip: NO_CORPUS && SKIP_REASON }, async () => {
  assert.ok(PROJECTS.length >= 80, `only ${PROJECTS.length} corpus projects found; this test would prove little`);

  for (const path of PROJECTS) {
    const original = new Uint8Array(readFileSync(path));
    const entries = await readZip(original);
    const library = parseProject(original);

    assert.deepEqual([...entries.keys()], ["manifest.json", library.manifest.Payload],
      `${path}: a project file holds the manifest and then the payload, in that order`);
    assert.deepEqual(entries.get(library.manifest.Payload), library.payload.raw,
      `${path}: the two readers disagree about the payload`);

    const parts = [...entries].map(([name, data]) => ({ name, data }));
    for (const [label, rebuilt] of [
      ["node", buildZipSync(parts)],
      ["browser", await buildZipAsync(parts)],
    ] as [string, Uint8Array][]) {
      assertConsistent(rebuilt, `${label}: ${path}`);
      assert.deepEqual(parseProject(rebuilt).payload.raw, library.payload.raw,
        `${label}: ${path}: the payload changed through a rebuild`);
      assert.deepEqual(await readZip(rebuilt), entries, `${label}: ${path}: an entry changed through a rebuild`);
    }
  }
});
