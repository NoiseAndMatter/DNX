/**
 * Writing a whole project to a +Drive slot — the parts that can be tested without an instrument.
 *
 * The transfer itself needs hardware. What can be pinned here is the thing most likely to be got
 * wrong by reasoning: **that a correct write is not reported as a failure**, because the payload
 * that comes back will not be the payload that went out.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, NO_CORPUS } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { buildPayload } from "@noiseandmatter/dnx-core/project/write.js";
import { FORM_FLAG_OFFSET, FORM_STORED, refuseRawForm } from "@noiseandmatter/dnx-core/device/storagewrite.js";
// The pure half, deliberately not reached through the module that imports Web MIDI.
import { firstDifference, projectPath } from "@noiseandmatter/dnx-core/project/driveslot.js";

test("a slot addresses the path the device resolves", () => {
  // `/projects/1` opens and `/projects/PRESETS` does not: the device turns the last segment into a
  // number. See `DriveProject.index`.
  assert.equal(projectPath(1), "/projects/1");
  assert.equal(projectPath(128), "/projects/128");
});

test("identical images report no difference", () => {
  const a = new Uint8Array(1000).fill(7);
  assert.equal(firstDifference(a, Uint8Array.from(a)), undefined);
});

test("a difference is reported at the byte it happens", () => {
  const a = new Uint8Array(100).fill(1);
  const b = Uint8Array.from(a);
  b[42] = 9;
  assert.equal(firstDifference(a, b), 42);
});

test("a length mismatch is a difference, not a crash", () => {
  assert.equal(firstDifference(new Uint8Array(10), new Uint8Array(8)), 8);
});

function dn2Projects(): string[] {
  if (NO_CORPUS) return [];
  const dir = join(CORPUS ?? "", "02_DN2", "01_Projects");
  if (!existsSync(dir)) throw new Error(`${dir} is not in the corpus`);
  const found = readdirSync(dir).filter((f) => /\.dn2prj$/i.test(f));
  if (found.length === 0) throw new Error(`${dir} holds no .dn2prj`);
  return found.map((f) => join(dir, f));
}

const files = dn2Projects();

/**
 * The reason verification compares images rather than bytes.
 *
 * `lz4encode.ts` states it: LZ4 is a deterministic format and not a deterministic encoding. A
 * rebuilt payload decodes to the same image and is very often a different length — sometimes larger
 * than Elektron's, sometimes smaller. A byte comparison of the read-back would therefore fail on a
 * **correct** write, which is the kind of false alarm that teaches people to ignore a check.
 */
test("a rebuilt payload differs in bytes and agrees in image", { skip: files.length === 0 }, () => {
  let differed = 0;
  let checked = 0;

  for (const path of files.slice(0, 8)) {
    const { payload } = parseProject(new Uint8Array(readFileSync(path)));
    const { image } = decodeProjectImage(payload.raw);
    const rebuilt = buildPayload(payload.raw, image);
    checked++;

    // The image is what must survive, and it does, exactly.
    assert.equal(firstDifference(decodeProjectImage(rebuilt).image, image), undefined, path);

    if (rebuilt.length !== payload.raw.length || firstDifference(rebuilt, payload.raw) !== undefined) {
      differed++;
    }
  }

  assert.ok(checked > 0, "no projects were checked");
  assert.ok(
    differed > 0,
    "every rebuilt payload matched Elektron's byte for byte. If that is genuinely true now, the " +
      "image comparison in driveproject.ts is more caution than it needs — but check before " +
      "relaxing it.",
  );
});

/**
 * The +Drive only accepts the stored form, and an export produces one.
 *
 * `buildPayload` copies the 31-byte container header verbatim, which is what carries the flag at
 * `+29`. If that ever stopped being true, every save to the +Drive would be refused by
 * `refuseRawForm` — correctly, but for a reason nobody would guess from the message.
 */
test("an edited project is still in the stored form", { skip: files.length === 0 }, () => {
  for (const path of files.slice(0, 5)) {
    const { payload } = parseProject(new Uint8Array(readFileSync(path)));
    const { image } = decodeProjectImage(payload.raw);
    const rebuilt = buildPayload(payload.raw, image);

    assert.equal(rebuilt[FORM_FLAG_OFFSET], FORM_STORED, `${path}: form flag lost`);
    assert.deepEqual(
      [...rebuilt.subarray(0, 31)],
      [...payload.raw.subarray(0, 31)],
      `${path}: the container header was not preserved`,
    );
    // And the guard agrees, which is what the write path will actually consult.
    assert.doesNotThrow(() => refuseRawForm(rebuilt, projectPath(12)));
  }
});
