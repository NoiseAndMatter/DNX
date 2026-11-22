/**
 * Which folder may import which.
 *
 * The rules are in `src/review/layers.ts`, shared with the review map. This file walks every
 * source file through them and fails on a violation.
 *
 * **A ratchet.** The boundary was not drawn when the code was written, so it was not clean at
 * first. Every violation is listed in `KNOWN` by file and import. The test fails on a violation
 * that is not listed, and on a listed one that has gone, so the list can only shrink: whoever fixes
 * one deletes its line in the same change.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { CORE_PACKAGE, ROOT, code, repoPath, sourceFiles, specifiersOf } from "../src/review/importgraph.js";
import { PAGES, layerOf, violationsOf, type Layer } from "../src/review/layers.js";

const FILES = sourceFiles();

/**
 * Every violation today. Delete a line when its import goes; never add one.
 */
const KNOWN: string[] = [];

test("every folder imports only what its layer allows, apart from the listed violations", () => {
  const found = FILES.flatMap((file) => violationsOf(repoPath(file), specifiersOf(file), code(file)));

  const added = found.filter((v) => !KNOWN.includes(v));
  assert.deepEqual(added, [],
    "a new layer violation. Import from a layer this one may use (see RULES in src/review/layers.ts), or move the code:\n  " +
      added.join("\n  "));

  const fixed = KNOWN.filter((v) => !found.includes(v));
  assert.deepEqual(fixed, [],
    "fixed, so delete these from KNOWN in test/layers.test.ts:\n  " + fixed.join("\n  "));
});

test("every source file lands in a layer, and every layer has files", () => {
  // A path the classifier does not recognise would get no rules and pass unchecked. And a walk
  // that found no core files, or no pages, would pass the test above by finding nothing.
  const layers = FILES.map((file) => layerOf(repoPath(file)));
  assert.ok(!layers.includes("outside"), "a source file outside every layer");
  const counted = new Set(layers);
  for (const layer of ["core", "tooling", "node", "cli", "sheet", "web", ...PAGES.map((p) => `page:${p}`)]) {
    assert.ok(counted.has(layer as Layer), `no files found in layer ${layer}; the walk or the table is wrong`);
  }
});

test("the layer check would actually catch a violation", () => {
  /*
   * **A test can pass by finding nothing**, which is also what a broken detector produces. An
   * invented core file importing every forbidden thing, and a real browser module read as if it
   * were core, must each be caught. Once KNOWN is empty this is the only proof the check works.
   */
  const invented = violationsOf("packages/core/src/project/invented.ts", [
    "node:fs",
    "../../../../src/node/zip.js",
    "../../../../src/cli/args.js",
    "../../../../src/sheet/naming.js",
    "../../../../web/src/dom.js",
    "./machine.js",
  ], "export const title = document.title;");
  assert.deepEqual(invented, [
    "packages/core/src/project/invented.ts -> node:fs",
    "packages/core/src/project/invented.ts -> ../../../../src/node/zip.js",
    "packages/core/src/project/invented.ts -> ../../../../src/cli/args.js",
    "packages/core/src/project/invented.ts -> ../../../../src/sheet/naming.js",
    "packages/core/src/project/invented.ts -> ../../../../web/src/dom.js",
    "packages/core/src/project/invented.ts uses document",
  ]);

  const mount = join(ROOT, "web", "src", "analysis", "mount.ts");
  assert.ok(violationsOf("packages/core/src/analysis/mount.ts", [], code(mount)).length > 0,
    "mount.ts touches the document; read as core it must be flagged");

  assert.deepEqual(
    violationsOf("web/src/choosedevice.ts", ["./manager/main.js", "../../src/node/open.js"], ""),
    ["web/src/choosedevice.ts -> ./manager/main.js", "web/src/choosedevice.ts -> ../../src/node/open.js"],
    "a shared web module may not reach a page folder or src/node",
  );
  assert.deepEqual(
    violationsOf("web/src/probe/cards.ts", ["./format.js", `${CORE_PACKAGE}project/machine.js`], ""),
    [],
    "a page may import its own folder and core, and core by its package name is still core");
});
