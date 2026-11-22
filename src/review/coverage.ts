/**
 * Line coverage from an LCOV file, and how much of one function it covers.
 *
 * Node writes LCOV with `--experimental-test-coverage --test-reporter=lcov`. Run under `tsx`, it
 * needs `--enable-source-maps` as well: without it the line numbers are those of the compiled
 * JavaScript, where the comments are gone, and every function lands on the wrong lines.
 *
 * Node reports a count for every line of a file that ran, comments and blank lines included. So a
 * function's coverage is asked of its statement lines only (`FunctionInfo.statementLines`), and a
 * file the tests never loaded has no record at all. That is "not run by the tests", which is not
 * the same as "0% covered", and the review map shows the two differently.
 */

import { isAbsolute, relative } from "node:path";
import type { FunctionInfo } from "./complexity.js";

/** Hit count per line, per file. Paths are from the repository root with forward slashes. */
export type LineHits = Map<string, Map<number, number>>;

/** Read LCOV text. `root` turns an absolute `SF:` path into a repository path. */
export function parseLcov(text: string, root: string): LineHits {
  const hits: LineHits = new Map();
  let current: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      const path = raw.slice(3);
      const key = (isAbsolute(path) ? relative(root, path) : path).replaceAll("\\", "/");
      current = hits.get(key) ?? new Map<number, number>();
      hits.set(key, current);
    } else if (raw.startsWith("DA:") && current) {
      const [line, count] = raw.slice(3).split(",").map(Number);
      if (line !== undefined && count !== undefined) {
        // A file can appear once per test process. A line ran if it ran in any of them.
        current.set(line, (current.get(line) ?? 0) + count);
      }
    } else if (raw === "end_of_record") {
      current = undefined;
    }
  }
  return hits;
}

/**
 * The share of a function's statement lines that ran, from 0 to 1, or `undefined` when the tests
 * never loaded its file. A function with no statements counts as covered: there is nothing in it
 * that could fail to run.
 */
export function functionCoverage(fn: FunctionInfo, fileHits: Map<number, number> | undefined): number | undefined {
  if (!fileHits) return undefined;
  if (fn.statementLines.length === 0) return 1;
  const ran = fn.statementLines.filter((line) => (fileHits.get(line) ?? 0) > 0).length;
  return ran / fn.statementLines.length;
}

/**
 * CRAP, Change Risk Anti-Patterns (Savoia and Evans, 2007): `c² × (1 − coverage)³ + c`, for a
 * function of complexity `c`.
 *
 * A fully covered function scores its complexity. An untested one scores `c² + c`, so complexity
 * with no tests is what drives it up. The usual line is 30: at full coverage a function goes over
 * it only above complexity 30, and with no coverage at all, complexity 6 already does (42).
 */
export function crapScore(complexity: number, coverage: number): number {
  return complexity * complexity * (1 - coverage) ** 3 + complexity;
}

/** Above this a function is shown in red. */
export const CRAP_LIMIT = 30;
