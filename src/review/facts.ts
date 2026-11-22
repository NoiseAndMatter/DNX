/**
 * Read one source file into the facts the model is built from: its imports, the browser globals
 * it touches, and its functions.
 */

import { readFileSync } from "node:fs";
import { functionsOf } from "./complexity.js";
import { browserGlobalsIn, code, isLocal, repoPath, resolveSpecifier, specifiersOf } from "./importgraph.js";
import type { SourceFacts } from "./model.js";

/** The facts of the file at absolute path `file`. */
export function factsOf(file: string): SourceFacts {
  const specifiers = specifiersOf(file);
  return {
    path: repoPath(file),
    local: specifiers.filter(isLocal).map((specifier) => repoPath(resolveSpecifier(file, specifier))),
    bare: specifiers.filter((specifier) => !isLocal(specifier)),
    browserGlobals: browserGlobalsIn(code(file)),
    functions: functionsOf(file, readFileSync(file, "utf8")),
  };
}
