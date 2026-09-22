/**
 * No comma operator in source.
 *
 * ## The failure this exists to stop
 *
 * A card in the Insights panel was written as:
 *
 * ```
 * (dormant.length ? card("Trigs the sequencer never reaches", `…`) : "", "insights/dormant")
 * ```
 *
 * The closing bracket landed one argument early, so `"insights/dormant"` stopped being `card`'s
 * third argument and became the right-hand side of a **comma operator**. The whole parenthesised
 * expression evaluates to that string. The card was built, thrown away, and the literal
 * `insights/dormant` was written into the page instead — as a bare text node nobody notices.
 *
 * It type-checked, it lint-free'd, it built, and it shipped. It was found only because a reader
 * asked why a pattern with dormant trigs showed no dormant-trigs card, and the model and the page
 * disagreed for an hour before anybody read the punctuation.
 *
 * ## Why a blanket ban
 *
 * The comma operator has no use here that a statement would not say more plainly, and every
 * accidental one has this shape: **an expression is evaluated and silently discarded**. Banning it
 * outright costs nothing and turns a silent wrong answer into a failing test.
 *
 * `for (let i = 0, j = n; …)` is a declaration list, not the comma operator, and is unaffected.
 * `for (…; …; i++, j--)` is caught. One loop had that shape, in `analysis/model.ts`, and its second
 * counter was `at / hop` all along.
 *
 * The scan uses the TypeScript parser rather than a regex, because the thing being looked for is a
 * comma, and source is full of commas.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["packages/core/src", "src", "test", "web/src"];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
}

/** Every comma-operator expression in one file, as `path:line  source`. */
function sequences(path: string): string[] {
  const source = ts.createSourceFile(
    path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const text = node.getText(source).replace(/\s+/g, " ").slice(0, 90);
      found.push(`${relative(ROOT, path)}:${line + 1}  ${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("no expression is evaluated and thrown away by a comma operator", () => {
  const files: string[] = [];
  for (const dir of SCAN) walk(join(ROOT, dir), files);
  assert.ok(files.length > 100, `expected to scan the codebase, found ${files.length} files`);

  const found = files.flatMap(sequences);
  assert.deepEqual(found, [], `comma operator in:\n${found.join("\n")}`);
});
