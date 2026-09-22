/**
 * The import graph, read out of the source.
 *
 * Three tests ask questions of the same graph: `web.test.ts` (does a page reach Node?),
 * `analysis.test.ts` (do the charts stay pure?) and `layers.test.ts` (does each folder import only
 * what its layer allows?). They used to carry their own copies of the walk, with regexes that had
 * already drifted apart. The walk lives here once; each test still asks its own question of it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Import and export statements only. A looser pattern picks up prose in doc comments:
 * "distinguish copied from ..." reads as an import to a naive regex.
 */
const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm;

/** Every specifier a file imports or re-exports from, in source order. */
export function specifiersOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(IMPORT)].map((m) => m[1]!);
}

/**
 * The core package, which lives in this repository and is imported by name.
 *
 * `@noiseandmatter/dnx-core/project/dn1.js` is a workspace, not a dependency: the source is in
 * `packages/core/src`, and `package.json`'s `exports` maps `./*` onto it. The walks below follow
 * it like any other local module, because a graph that stopped at the package boundary would
 * answer "does this page reach Node?" with "I did not look".
 */
export const CORE_PACKAGE = "@noiseandmatter/dnx-core/";

/** Where that package's sources are, as a path under the repository root. */
export const CORE_ROOT = join(ROOT, "packages", "core", "src");

/**
 * The file a specifier names, as the `.ts` source rather than the compiled `.js`.
 *
 * Relative specifiers resolve against the importing file. The core package resolves against its
 * own source root, which is what makes it local rather than external.
 */
export function resolveSpecifier(from: string, specifier: string): string {
  if (specifier.startsWith(CORE_PACKAGE)) {
    return join(CORE_ROOT, specifier.slice(CORE_PACKAGE.length).replace(/\.js$/, ".ts"));
  }
  return join(dirname(from), specifier.replace(/\.js$/, ".ts"));
}

/** Whether a specifier names something inside this repository, by either spelling. */
export function isLocal(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith(CORE_PACKAGE);
}

/** A path relative to the repository root, with forward slashes on every platform. */
export function repoPath(file: string): string {
  return relative(ROOT, file).replaceAll("\\", "/");
}

/**
 * Everything reachable from `entry`, following relative imports.
 *
 * `files` holds the absolute path of every local module reached, the entry included. `external`
 * holds each bare specifier met on the way, as `file -> specifier`, because a bare specifier is
 * where the graph leaves the repository and is usually the thing being checked for.
 */
export function importGraph(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const queue = [entry];
  const external: string[] = [];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(file)) {
      if (isLocal(specifier)) queue.push(resolveSpecifier(file, specifier));
      else external.push(`${file} -> ${specifier}`);
    }
  }

  return { files: [...seen], external };
}

/** Source with comments removed, so prose about `document` is not read as a use of it. */
export function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/**
 * The browser globals a platform-free module must not touch.
 *
 * **The pattern is an access, not a word.** Matching the bare name flagged
 * `"5 notes in this window"`, a tooltip string in a module that touches nothing, and a chart's
 * whole subject is a *window* of steps, so the word is unavoidable in this vocabulary. A global is
 * only useful if something is read off it or constructed from it, so that is what is looked for.
 * Run over `code(file)`, never the raw source, because prose says `document` too.
 */
export const BROWSER_ONLY: [RegExp, string][] = [
  [/\bdocument\s*[.[]/, "document"],
  [/\bwindow\s*[.[]/, "window"],
  [/\blocalStorage\s*[.[]/, "localStorage"],
  [/\bnew\s+ResizeObserver\b/, "ResizeObserver"],
  [/\bHTML[A-Za-z]*Element\b/, "an HTML element type"],
  [/\bdocument\b\s*[),;]/, "document"],
];

/** The browser globals `source` uses, by name, once each. */
export function browserGlobalsIn(source: string): string[] {
  return [...new Set(BROWSER_ONLY.filter(([pattern]) => pattern.test(source)).map(([, api]) => api))];
}
