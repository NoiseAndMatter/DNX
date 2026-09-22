/**
 * Which folder may import which.
 *
 * `packages/core` is the platform-free core: the part a second host (Android, a CLI, a test) runs
 * unchanged, published as `@noiseandmatter/dnx-core`. That only works while core imports nothing
 * but core. `tsconfig.core.json` checks the globals it uses; this checks its imports, and the two
 * rules the web side keeps: a page's own folder belongs to that page, and nothing under `src/`
 * reaches into `web/`.
 *
 * **The package is imported by name and is still local.** `@noiseandmatter/dnx-core/...` is a
 * workspace whose source is in this repository, so it is classified as the core layer rather than
 * waved through as a bare specifier. Reading it as external would have turned every rule about
 * what may reach core into a rule about nothing.
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
import {
  CORE_PACKAGE, ROOT, browserGlobalsIn, code, isLocal, repoPath, resolveSpecifier, specifiersOf,
} from "./importgraph.js";

/**
 * Research and hardware-test tooling: written to find out what a device does, and left behind in
 * DNX when core moved out.
 *
 * **Folders, not a list of files.** This was four paths named one at a time, which is a thing to
 * forget to add to and gave no answer to "where does a new probe module go". The two folders say
 * it: `research/` is what we build to ask the instrument a question, `hardwaretest/` is what we
 * build to check an answer on one.
 */
const TOOLING = ["research", "hardwaretest"];

/** The pages. Each folder is private to its page. */
const PAGES = ["expander", "landing", "library", "manager", "probe"];

type Layer = "core" | "tooling" | "node" | "cli" | "sheet" | "web" | `page:${string}` | "outside";

function layerOf(path: string): Layer {
  if (path.startsWith("packages/core/src/")) return "core";
  const tool = /^src\/([^/]+)\//.exec(path);
  if (tool && TOOLING.includes(tool[1]!)) return "tooling";
  const own = /^src\/(node|cli|sheet)\//.exec(path);
  if (own) return own[1] as Layer;
  const page = /^web\/src\/([^/]+)\//.exec(path);
  if (page && PAGES.includes(page[1]!)) return `page:${page[1]!}`;
  if (path.startsWith("web/src/")) return "web";
  return "outside";
}

/**
 * What each layer may import: local layers, and bare specifiers by prefix.
 *
 * Everything under `packages/core/src` is core, which is the safe way round: a file has to be put
 * in the package deliberately to earn core's rules, and one that does not belong there is in the
 * wrong directory rather than missing from a list. A folder under `src/` that is not `node`,
 * `cli`, `sheet` or tooling now lands in no layer at all, and the test below fails on it.
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
    if (isLocal(specifier)) {
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

const FILES = [
  ...tsFiles(join(ROOT, "packages", "core", "src")),
  ...tsFiles(join(ROOT, "src")),
  ...tsFiles(join(ROOT, "web", "src")),
];

/**
 * Every violation today. Delete a line when its import goes; never add one.
 */
const KNOWN = [
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
