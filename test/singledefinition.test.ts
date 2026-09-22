/**
 * One home for each constant.
 *
 * `dn2image.ts` records what happens otherwise: the DN2 kit offsets had six homes, two of them
 * disagreed, and nothing said so. The same shape was found again across `src/` and `web/src/`: bank
 * letters in four files, the number 128 under five names, the sound name's offset in two files, the
 * kit name's size in two, the pattern bank size under two names, and the container's slot offset as
 * a constant in one module and a bare `0x18` in another.
 *
 * Each now has one definition and every other file imports it. This test keeps it that way. A name
 * in `HOMES` may be declared only in its home file. A name in `RETIRED` was a second name for
 * something that already had one, and may not come back.
 *
 * The scan uses the TypeScript parser, so a destructured alias such as
 * `const { nameSize: KIT_NAME_SIZE } = spec.kit` counts as a declaration, and a re-export
 * (`export { X }`) or an import does not.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { ROOT, repoPath } from "./importgraph.js";

/** Each name, and the one file allowed to declare it. */
const HOMES: Record<string, string> = {
  BANKS: "packages/core/src/project/naming.ts",
  PATTERNS_PER_BANK: "packages/core/src/project/naming.ts",
  SOUND_NAME_OFFSET: "packages/core/src/project/soundmap.ts",
  SOUND_NAME_SIZE: "packages/core/src/project/soundmap.ts",
  POOL_SOUND_COUNT: "packages/core/src/project/soundmap.ts",
  KIT_NAME_SIZE: "packages/core/src/project/spec.ts",
  CONTAINER_SLOT_OFFSET: "packages/core/src/project/container.ts",
  // The +Drive library's bank sizes (256 presets, 128 kits). A pattern bank is `PATTERNS_PER_BANK`.
  BANK_SIZE: "packages/core/src/device/library.ts",
};

/** Second names for a number that has a home. The pattern count is `ImageLayout.patternCount`. */
const RETIRED: Record<string, string> = {
  PATTERN_COUNT: "DN1_LAYOUT.patternCount or DN2_LAYOUT.patternCount",
  DN1_PATTERN_COUNT: "DN1_LAYOUT.patternCount",
  DN2_PATTERN_COUNT: "DN2_LAYOUT.patternCount",
  POOL_SLOTS: "POOL_SOUND_COUNT",
};

const WATCHED = new Set([...Object.keys(HOMES), ...Object.keys(RETIRED)]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Every watched name `source` declares, anywhere in the file. */
function declaredIn(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const note = (name: ts.Node | undefined): void => {
    if (name && ts.isIdentifier(name) && WATCHED.has(name.text)) found.push(name.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) note(node.name);
    else if (
      ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)
    ) {
      note(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const FILES = [
  ...tsFiles(join(ROOT, "packages", "core", "src")),
  ...tsFiles(join(ROOT, "src")),
  ...tsFiles(join(ROOT, "web", "src")),
];

/** name -> the files that declare it. */
function declarations(): Map<string, string[]> {
  const where = new Map<string, string[]>();
  for (const file of FILES) {
    for (const name of new Set(declaredIn(file, readFileSync(file, "utf8")))) {
      where.set(name, [...(where.get(name) ?? []), repoPath(file)]);
    }
  }
  return where;
}

test("each shared constant is declared in its home and nowhere else", () => {
  const where = declarations();
  for (const [name, home] of Object.entries(HOMES)) {
    assert.deepEqual(where.get(name), [home],
      `${name} belongs in ${home} alone; import it from there`);
  }
});

test("a retired second name does not come back", () => {
  const where = declarations();
  for (const [name, instead] of Object.entries(RETIRED)) {
    assert.deepEqual(where.get(name) ?? [], [], `${name} was retired; use ${instead}`);
  }
});

test("the scan would actually catch a second home", () => {
  // A scan that finds nothing passes both tests above. An invented file with each kind of
  // declaration must be seen, and an import or re-export must not.
  assert.deepEqual(
    declaredIn("invented.ts", [
      "export const BANKS = 'ABCDEFGH';",
      "const { nameSize: KIT_NAME_SIZE } = spec.kit;",
      "function f() { let PATTERN_COUNT = 128; return PATTERN_COUNT; }",
      "import { SOUND_NAME_OFFSET } from './soundmap.js';",
      "export { POOL_SOUND_COUNT } from './soundmap.js';",
    ].join("\n")),
    ["BANKS", "KIT_NAME_SIZE", "PATTERN_COUNT"],
  );
});
