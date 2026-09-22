/**
 * The library on a Digitone 1.
 *
 * It connected to a Digitone II only, so a Digitone 1's presets could not be browsed or renamed. The
 * rename itself is tested on a Digitone 1 file in `presetrename.test.ts`. This checks the page's half
 * by reading its source, and the tag read on the same file.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { slotFacts } from "../web/src/library/slottags.js";
import { objectInStoredBody } from "@noiseandmatter/dnx-core/device/library.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { CORPUS } from "./corpus.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const library = readFileSync(join(ROOT, "web", "src", "library", "main.ts"), "utf8");
const manager = readFileSync(join(ROOT, "web", "src", "manager", "main.ts"), "utf8");

function body(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} has been renamed; this fence no longer guards anything`);
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end, `${name} has no closing brace at column 0`);
  return source.slice(start, start + end.index);
}

test("the library connects to either instrument, chosen the way the manager chooses", () => {
  assert.doesNotMatch(library, /want:\s*ProductId\.DN2/, "the library asks for a Digitone II only again");
  assert.doesNotMatch(library, /connect a Digitone II first/);
  for (const [name, source] of [["library", library], ["manager", manager]] as const) {
    assert.match(source, /from "\.\.\/choosedevice\.js"/, `the ${name} no longer uses the shared chooser`);
    assert.doesNotMatch(source, /async function chooseDevice\(/, `the ${name} has its own chooser again`);
  }
});

test("a Digitone 1 is not offered kits, and a new instrument starts from an empty cache", () => {
  /*
   * **The cache is keyed by collection and bank letter only**, and it compares listings to decide
   * what to read again. Without the clear, a Digitone connected after a Digitone II could be shown
   * the other instrument's tags against its own names.
   */
  const connect = body(library, "connect");
  assert.match(connect, /productId !== ProductId\.DN1/);
  assert.match(connect, /banks\.clear\(\)/);
});

test("the library's tag read turns machines off for a Digitone 1", () => {
  assert.match(library, /machines:\s*device\.productId !== ProductId\.DN1/);
});

const DN1 = CORPUS && join(CORPUS, "..", "99_HardwareTest", "soundbanks_A_1_dn1_stored_266B.bin");
const skip = !(DN1 && existsSync(DN1)) && "needs the stored Digitone 1 /soundbanks/A/1 in the private corpus";

test("a Digitone 1 preset shows its tags and no machine", { skip }, () => {
  /*
   * **+244 is a sound setting on a Digitone 1**, which has one FM engine and no machine byte. Across
   * the 1,364 presets of a Digitone 1 backup on 2026-09-15 it took 38 values, which the Digitone II
   * table names FM TONE, SWARMER, FM DRUM and MIDI. The tags at +8 are the same field on both.
   */
  const { object } = objectInStoredBody(decodeProjectImage(new Uint8Array(readFileSync(DN1!))).image);
  assert.deepEqual(slotFacts(object, false), { tags: ["EPIC"], machine: undefined });
  assert.equal(slotFacts(object, true).machine, "FM TONE", "the Digitone II reading, which is why it is off here");
});
