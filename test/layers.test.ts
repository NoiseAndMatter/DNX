/**
 * Which folder may import which.
 *
 * The folders of `src/` other than `node`, `cli` and `sheet` are the future platform-free core:
 * the part a second host (Android, a CLI, a test) runs unchanged. That only works while core
 * imports nothing but core. `tsconfig.core.json` checks the globals it uses; this checks its
 * imports, and the two rules the web side keeps: a page's own folder belongs to that page, and
 * nothing under `src/` reaches into `web/`.
 *
 * **A ratchet.** The boundary was not drawn when the code was written, so it is not clean today.
 * Every current violation is listed in `KNOWN` by file and import. The test fails on a violation
 * that is not listed, and on a listed one that has gone, so the list can only shrink: whoever fixes
 * one deletes its line in the same change.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, browserGlobalsIn, code, repoPath, resolveSpecifier, specifiersOf } from "./importgraph.js";

/** Research and hardware-test tooling that sits in core's folders but will not go with it. */
const TOOLING = [
  "src/librarian/hardwaretest.ts",
  "src/librarian/trackhardwaretest.ts",
  "src/device/usbcapture.ts",
  "src/device/apiprobe.ts",
];

/** The pages. Each folder is private to its page. */
const PAGES = ["expander", "landing", "library", "manager", "probe"];

type Layer = "core" | "tooling" | "node" | "cli" | "sheet" | "web" | `page:${string}` | "outside";

function layerOf(path: string): Layer {
  if (TOOLING.includes(path)) return "tooling";
  const own = /^src\/(node|cli|sheet)\//.exec(path);
  if (own) return own[1] as Layer;
  if (path.startsWith("src/")) return "core";
  const page = /^web\/src\/([^/]+)\//.exec(path);
  if (page && PAGES.includes(page[1]!)) return `page:${page[1]!}`;
  if (path.startsWith("web/src/")) return "web";
  return "outside";
}

/**
 * What each layer may import: local layers, and bare specifiers by prefix.
 *
 * A new folder under `src/` is core by default, which is the safe way round: it has to earn its
 * way out of the rules rather than into them.
 */
const RULES: Record<string, { layers: string[]; bare: string[] }> = {
  core: { layers: ["core"], bare: [] },
  tooling: { layers: ["core", "tooling", "sheet"], bare: [] },
  sheet: { layers: ["core", "sheet"], bare: [] },
  node: { layers: ["core", "node"], bare: ["node:"] },
  cli: { layers: ["core", "tooling", "sheet", "node", "cli"], bare: ["node:"] },
  web: { layers: ["core", "tooling", "sheet", "web"], bare: [] },
};

function rulesFor(layer: Layer): { layers: string[]; bare: string[] } {
  if (layer.startsWith("page:")) return { layers: [...RULES.web!.layers, layer], bare: [] };
  return RULES[layer]!;
}

/**
 * Every rule `path` breaks, given its imports and its comment-free source.
 *
 * Kept separate from the file walk so the known-positive test below can feed it an invented file.
 */
function violationsOf(path: string, specifiers: string[], source: string): string[] {
  const layer = layerOf(path);
  const allowed = rulesFor(layer);
  const found: string[] = [];

  for (const specifier of specifiers) {
    if (specifier.startsWith(".")) {
      const target = layerOf(repoPath(resolveSpecifier(join(ROOT, path), specifier)));
      if (!allowed.layers.includes(target)) found.push(`${path} -> ${specifier}`);
    } else if (!allowed.bare.some((prefix) => specifier.startsWith(prefix))) {
      found.push(`${path} -> ${specifier}`);
    }
  }

  // Core also runs where there is no document. `tsconfig.core.json` catches this at compile time;
  // this catches it in `npm test`, and names the file in the same list as the imports.
  if (layer === "core") {
    for (const api of browserGlobalsIn(source)) found.push(`${path} uses ${api}`);
  }

  return found;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const FILES = [...tsFiles(join(ROOT, "src")), ...tsFiles(join(ROOT, "web", "src"))];

/**
 * Every violation today. Delete a line when its import goes; never add one.
 */
const KNOWN = [
  // Core reaching into src/sheet for the naming helpers. Goes when naming.ts moves to
  // src/project/ (item 4 of the refactor plan).
  "src/device/capture.ts -> ../sheet/naming.js",
  "src/device/deviceproject.ts -> ../sheet/naming.js",
  "src/device/readplan.ts -> ../sheet/naming.js",
  "src/device/safewrite.ts -> ../sheet/naming.js",
  "src/expand/deviceexpand.ts -> ../sheet/naming.js",
  "src/expand/landing.ts -> ../sheet/naming.js",
  "src/expand/merge.ts -> ../sheet/naming.js",
  "src/librarian/rename.ts -> ../sheet/naming.js",
  "src/project/rebuild.ts -> ../sheet/naming.js",

  // A module every page shares, reaching into the landing page's folder.
  "web/src/settings.ts -> ./landing/seen.js",
];

test("every folder imports only what its layer allows, apart from the listed violations", () => {
  const found = FILES.flatMap((file) => violationsOf(repoPath(file), specifiersOf(file), code(file)));

  const added = found.filter((v) => !KNOWN.includes(v));
  assert.deepEqual(added, [],
    "a new layer violation. Import from a layer this one may use (see RULES), or move the code:\n  " +
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
  const invented = violationsOf("src/project/invented.ts", [
    "node:fs",
    "../node/zip.js",
    "../cli/args.js",
    "../sheet/naming.js",
    "../../web/src/dom.js",
    "./machine.js",
  ], "export const title = document.title;");
  assert.deepEqual(invented, [
    "src/project/invented.ts -> node:fs",
    "src/project/invented.ts -> ../node/zip.js",
    "src/project/invented.ts -> ../cli/args.js",
    "src/project/invented.ts -> ../sheet/naming.js",
    "src/project/invented.ts -> ../../web/src/dom.js",
    "src/project/invented.ts uses document",
  ]);

  const mount = join(ROOT, "web", "src", "analysis", "mount.ts");
  assert.ok(violationsOf("src/analysis/mount.ts", [], code(mount)).length > 0,
    "mount.ts touches the document; read as core it must be flagged");

  assert.deepEqual(
    violationsOf("web/src/choosedevice.ts", ["./manager/main.js", "../../src/node/open.js"], ""),
    ["web/src/choosedevice.ts -> ./manager/main.js", "web/src/choosedevice.ts -> ../../src/node/open.js"],
    "a shared web module may not reach a page folder or src/node",
  );
  assert.deepEqual(violationsOf("web/src/probe/cards.ts", ["./format.js", "../../../src/project/machine.js"], ""), [],
    "a page may import its own folder and core");
});
