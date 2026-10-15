/**
 * Writing into a pattern record whose fields sit at other offsets is refused, everywhere it
 * could happen.
 *
 * Four writers put bytes at the authored offsets: the expander's conversion, the pattern merge,
 * the clear that a move or a delete leaves behind, and the track operations. Each one checked
 * only the image size, or nothing, so a Digitone II version-2 record (the factory PRESETS
 * project, a project from older firmware) took version-3 bytes 4 bytes per track off.
 *
 * Version 4, which OS 1.11 writes into every project it touches, keeps version 3's layout and
 * stays allowed: refusing it would refuse every current Digitone II.
 *
 * The versions are set on a real project's records by hand. The guard reads only the version
 * word, so this is the input it meets, and it needs no version-2 file in the corpus.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, corpusPath } from "./corpus.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN1_LAYOUT, DN2_LAYOUT, kitRecord, patternRecord } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { DN1_DEVICE, DN2_DEVICE } from "@noiseandmatter/dnx-core/librarian/device.js";
import { applyRearrange, planRearrange } from "@noiseandmatter/dnx-core/librarian/rearrange.js";
import { planTrackMove } from "@noiseandmatter/dnx-core/librarian/trackmove.js";
import { clear, swap } from "@noiseandmatter/dnx-core/librarian/shuffle.js";
import { ConversionError, convertProject } from "@noiseandmatter/dnx-core/expand/convert.js";
import { MergeRefused, planPatternMerge } from "@noiseandmatter/dnx-core/expand/merge.js";

const DN1_FILE = "002 MORNING_JAM.dnprj";
const DN2_FILE = "MORNING_JAM.dn2prj";

function have(dir: string, name: string): boolean {
  return !NO_CORPUS && existsSync(join(corpusPath(dir), name));
}
const skip = !have(DN1_PROJECTS, DN1_FILE) || !have(DN2_PROJECTS, DN2_FILE);

function image(dir: string, name: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(join(corpusPath(dir), name))));
  return decodeProjectImage(payload.raw).image;
}

/** A copy of `img` with pattern `index` claiming storage `version`. Version word at offset 0. */
function withVersion(img: Uint8Array, layout: typeof DN2_LAYOUT, index: number, version: number): Uint8Array {
  const out = Uint8Array.from(img);
  const record = patternRecord(out, index, layout);
  new DataView(record.buffer, record.byteOffset, 4).setUint32(0, version, false);
  return out;
}

const blocked = (findings: readonly { severity: string; message: string }[]): boolean =>
  findings.some((f) => f.severity === "blocker" && /keeps its fields at other offsets/.test(f.message));

test("a clear refuses a version-2 slot and allows version 4", { skip }, () => {
  const dn2 = image(DN2_PROJECTS, DN2_FILE);
  assert.equal(blocked(planRearrange(withVersion(dn2, DN2_LAYOUT, 5, 2), clear(5)).findings), true);
  assert.throws(() => applyRearrange(withVersion(dn2, DN2_LAYOUT, 5, 2), clear(5), { confirmOverwrite: true }));
  assert.equal(blocked(planRearrange(withVersion(dn2, DN2_LAYOUT, 5, 4), clear(5)).findings), false);
});

test("a Digitone 1 clear stamps the blank with the version of the slot it replaces", { skip }, () => {
  // OS 1.43 writes version 11; the captured blank is version 10. Same bytes, one version word.
  const dn1 = withVersion(image(DN1_PROJECTS, DN1_FILE), DN1_LAYOUT, 5, 11);
  const kit = kitRecord(dn1, 5, DN1_LAYOUT);
  new DataView(kit.buffer, kit.byteOffset, 4).setUint32(0, 11, false);

  const { image: out } = applyRearrange(dn1, clear(5), { confirmOverwrite: true });
  const word = (r: Uint8Array): number => new DataView(r.buffer, r.byteOffset, 4).getUint32(0, false);
  assert.equal(word(patternRecord(out, 5, DN1_LAYOUT)), 11, "the cleared pattern must keep version 11");
  assert.equal(word(kitRecord(out, 5, DN1_LAYOUT)), 11, "the cleared kit must keep version 11");
  assert.equal(DN1_DEVICE.summarise(out, 5).occupied, false);
});

test("track operations refuse a version-2 pattern and allow version 4", { skip }, () => {
  const dn2 = image(DN2_PROJECTS, DN2_FILE);
  const v2 = planTrackMove(withVersion(dn2, DN2_LAYOUT, 0, 2), DN2_DEVICE, 0, swap(0, 1));
  assert.equal(v2.ok, false);
  assert.equal(blocked(v2.findings), true);
  const v4 = planTrackMove(withVersion(dn2, DN2_LAYOUT, 0, 4), DN2_DEVICE, 0, swap(0, 1));
  assert.equal(blocked(v4.findings), false);
});

test("the expander refuses a destination with version-2 patterns and allows version 4", { skip }, () => {
  const dn1 = image(DN1_PROJECTS, DN1_FILE);
  const dn2 = image(DN2_PROJECTS, DN2_FILE);
  assert.throws(
    () => convertProject(dn1, withVersion(dn2, DN2_LAYOUT, 7, 2)),
    (error: unknown) => error instanceof ConversionError && /pattern A8 is storage version 2/.test(error.message),
  );
  assert.doesNotThrow(() => convertProject(dn1, withVersion(dn2, DN2_LAYOUT, 7, 4)));
});

test("a merge refuses a version-2 source pattern or landing slot", { skip }, () => {
  const dn2 = image(DN2_PROJECTS, DN2_FILE);
  const merge = (source: Uint8Array, destination: Uint8Array) => () =>
    planPatternMerge({ source, destination, patterns: [0], landing: 100, confirmOverwrite: true });

  assert.throws(merge(withVersion(dn2, DN2_LAYOUT, 0, 2), dn2),
    (error: unknown) => error instanceof MergeRefused && /Source pattern A1 is storage version 2/.test(error.message));
  assert.throws(merge(dn2, withVersion(dn2, DN2_LAYOUT, 100, 2)),
    (error: unknown) => error instanceof MergeRefused && /Destination slot G5 is storage version 2/.test(error.message));
  assert.doesNotThrow(merge(withVersion(dn2, DN2_LAYOUT, 0, 4), withVersion(dn2, DN2_LAYOUT, 100, 4)));
});
