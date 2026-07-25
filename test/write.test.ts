import assert from "node:assert/strict";
import { CORPUS } from "./corpus.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isCheckValid, readCheckField } from "../src/project/checksum.js";
import { parseProject } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { encodeBlockChain } from "../src/project/lz4encode.js";
import { buildPayload } from "../src/project/write.js";

const ROOT = CORPUS ?? "";

function projectFiles(): string[] {
  const out: string[] = [];
  for (const dir of [join(ROOT, "01_DN1", "01_Projects"), join(ROOT, "02_DN2", "01_Projects")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (/\.dn2?prj$/i.test(f)) out.push(join(dir, f));
    }
  }
  return out;
}

const files = projectFiles();

test("the LZ4 encoder round-trips synthetic data", () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    Uint8Array.of(1, 2, 3),
    new Uint8Array(100_000), // all zeros: pure run, worst case for match handling
    Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) & 0xff), // repeating cycle
    Uint8Array.from({ length: 70_000 }, (_, i) => (i % 977 === 0 ? 0xff : 0)), // sparse
  ];
  for (const raw of cases) {
    const chain = encodeBlockChain(raw);
    // decodeProjectImage expects a full payload, so wrap the chain in a minimal one.
    const payload = new Uint8Array(0x1f + chain.length + 12);
    payload.set(chain, 0x1f);
    assert.deepEqual(decodeProjectImage(payload).image, raw, `round-trip failed at ${raw.length}B`);
  }
});

test("real project images survive a decode/encode round-trip", { skip: files.length === 0 }, () => {
  for (const path of files) {
    const { payload } = parseProject(new Uint8Array(readFileSync(path)));
    const { image } = decodeProjectImage(payload.raw);

    const rebuilt = buildPayload(payload.raw, image);
    const reread = decodeProjectImage(rebuilt);

    assert.deepEqual(reread.image, image, `${path}: image changed across the round-trip`);
  }
});

test("rebuilt payloads carry a valid check field and length", { skip: files.length === 0 }, () => {
  for (const path of files) {
    const { payload } = parseProject(new Uint8Array(readFileSync(path)));
    const { image } = decodeProjectImage(payload.raw);
    const rebuilt = buildPayload(payload.raw, image);

    assert.ok(isCheckValid(rebuilt), `${path}: rebuilt check field does not verify`);

    const view = new DataView(rebuilt.buffer);
    assert.equal(
      view.getUint32(rebuilt.length - 8, false),
      rebuilt.length - 12 - 0x1f,
      `${path}: rebuilt length field is wrong`,
    );
    assert.deepEqual(
      [...rebuilt.subarray(rebuilt.length - 4)],
      [0xaa, 0xa1, 0xda, 0xaa],
      `${path}: footer magic missing`,
    );
    assert.deepEqual(
      [...rebuilt.subarray(0, 0x1f)],
      [...payload.raw.subarray(0, 0x1f)],
      `${path}: container header not preserved`,
    );
  }
});

test("a modified image produces a different, still-valid payload", { skip: files.length === 0 }, () => {
  const path = files[0]!;
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  const { image } = decodeProjectImage(payload.raw);

  const edited = Uint8Array.from(image);
  // Byte 12 of the image is the first character of the project name.
  edited[12] = edited[12] === 0x5a ? 0x59 : 0x5a;

  const rebuilt = buildPayload(payload.raw, edited);
  assert.ok(isCheckValid(rebuilt));
  assert.deepEqual(decodeProjectImage(rebuilt).image, edited);
  assert.notEqual(readCheckField(rebuilt), payload.checkField, "check field should change");
});
