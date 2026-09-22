import assert from "node:assert/strict";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseProject } from "../src/node/projectfile.js";
import {
  CHECK_REGION_START,
  CHECK_REGION_TRAILER,
  checkRegion,
  computeCheckField,
  crc32ZeroInit,
  isCheckValid,
  readCheckField,
  stampCheckField,
} from "@noiseandmatter/dnx-core/project/checksum.js";

const EXAMPLES = CORPUS ?? "";

/** Every reference project on disk: 53 DN1 .dnprj files plus 1 DN2 .dn2prj file. */
function projectFilesUnder(dir: string): string[] {
  if (NO_CORPUS) return [];
  if (!existsSync(dir)) throw new Error(`${dir} is not in the corpus — nothing would be checked`);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...projectFilesUnder(path));
    else if (/\.dn2?prj$/i.test(entry.name)) out.push(path);
  }
  return out;
}

const PROJECT_FILES = projectFilesUnder(EXAMPLES);

test("every reference project's stored check field is reproduced", { skip: NO_CORPUS && SKIP_REASON }, () => {
  assert.ok(PROJECT_FILES.length > 0, `no project files found under ${EXAMPLES}`);
  assert.ok(
    PROJECT_FILES.length >= 54,
    `expected at least the 54 known reference projects, found ${PROJECT_FILES.length}`,
  );

  const failures: string[] = [];
  for (const path of PROJECT_FILES) {
    const { payload } = parseProject(readFileSync(path));
    const computed = computeCheckField(payload.raw);
    if (computed !== payload.checkField) {
      failures.push(
        `${path}: stored ${payload.checkField.toString(16).padStart(8, "0")}, ` +
          `computed ${computed.toString(16).padStart(8, "0")}`,
      );
    }
  }
  assert.deepEqual(failures, [], `${failures.length}/${PROJECT_FILES.length} projects mismatched`);
});

test("the check region is exactly the run of bytes the length field measures", () => {
  for (const path of PROJECT_FILES) {
    const { payload } = parseProject(readFileSync(path));
    assert.equal(
      checkRegion(payload.raw).length,
      payload.storedLength,
      `${path}: check region length does not equal the stored length field`,
    );
  }
});

test("a known payload hashes to its documented value", { skip: NO_CORPUS && SKIP_REASON }, () => {
  // 002 MORNING_JAM.dnprj: 37431-byte payload, check field B50ABE5E, length field 37388.
  const path = PROJECT_FILES.find((p) => p.includes("MORNING_JAM.dnprj"));
  assert.ok(path, "002 MORNING_JAM.dnprj not found");
  const { payload } = parseProject(readFileSync(path));
  assert.equal(payload.raw.length, 37431);
  assert.equal(payload.storedLength, 37388);
  assert.equal(readCheckField(payload.raw), 0xb50abe5e);
  assert.equal(computeCheckField(payload.raw), 0xb50abe5e);
  assert.ok(isCheckValid(payload.raw));
});

test("bytes inside the check region matter and bytes before it do not", { skip: NO_CORPUS && SKIP_REASON }, () => {
  const path = PROJECT_FILES[0];
  assert.ok(path);
  const { payload } = parseProject(readFileSync(path));

  const inside = Uint8Array.from(payload.raw);
  inside[CHECK_REGION_START + 1] = (inside[CHECK_REGION_START + 1]! ^ 0xff) & 0xff;
  assert.ok(!isCheckValid(inside), "flipping a byte inside the region should invalidate the check");

  // The project slot at 0x18 sits ahead of 0x1F, so it is deliberately not covered.
  const before = Uint8Array.from(payload.raw);
  before[0x18] = (before[0x18]! ^ 0xff) & 0xff;
  assert.ok(isCheckValid(before), "the region must start at 0x1F, after the project slot");

  // The length field and footer magic trail the check field and are not covered either.
  const after = Uint8Array.from(payload.raw);
  const lengthFieldAt = after.length - CHECK_REGION_TRAILER + 4;
  after[lengthFieldAt] = (after[lengthFieldAt]! ^ 0xff) & 0xff;
  assert.ok(isCheckValid(after), "the region must end immediately before the check field");
});

test("stampCheckField makes an edited payload valid again", { skip: NO_CORPUS && SKIP_REASON }, () => {
  const path = PROJECT_FILES[0];
  assert.ok(path);
  const { payload } = parseProject(readFileSync(path));

  const edited = Uint8Array.from(payload.raw);
  edited[0x40] = (edited[0x40]! ^ 0x5a) & 0xff;
  assert.ok(!isCheckValid(edited));

  const stamped = stampCheckField(edited);
  assert.ok(isCheckValid(edited));
  assert.equal(readCheckField(edited), stamped);
  assert.notEqual(stamped, payload.checkField);
});

test("a run of zero bytes leaves the zero-initialised register untouched", { skip: NO_CORPUS && SKIP_REASON }, () => {
  // This is why starting at 0x1F and starting at 0x20 agree on every known file: byte
  // 0x1F is always 0x00, and a zero byte is a no-op for a register still holding zero.
  const allZero = new Uint8Array(CHECK_REGION_START + CHECK_REGION_TRAILER + 64);
  assert.equal(computeCheckField(allZero), 0xffffffff);

  const path = PROJECT_FILES[0];
  assert.ok(path);
  const { payload } = parseProject(readFileSync(path));
  assert.equal(payload.raw[CHECK_REGION_START], 0x00);
  assert.equal(crc32ZeroInit(checkRegion(payload.raw).subarray(1)), payload.checkField);
});
