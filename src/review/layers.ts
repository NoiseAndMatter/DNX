/**
 * Which folder may import which: the layering of `docs/PRINCIPLES.md`, section 3, as code.
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
 * Two callers ask these rules: `test/layers.test.ts`, which fails the build on a new violation,
 * and the review map (`npm run review`), which draws each wrong-way import as a red arrow and
 * answers "what if this file moved?" by asking the same rules about a path that does not exist yet.
 */

import { join } from "node:path";
import { ROOT, browserGlobalsIn, isLocal, repoPath, resolveSpecifier } from "./importgraph.js";

/**
 * Research and hardware-test tooling: written to find out what a device does, and left behind in
 * DNX when core moved out.
 *
 * **Folders, not a list of files.** This was four paths named one at a time, which is a thing to
 * forget to add to and gave no answer to "where does a new probe module go". The two folders say
 * it: `research/` is what we build to ask the instrument a question, `hardwaretest/` is what we
 * build to check an answer on one.
 */
export const TOOLING = ["research", "hardwaretest"];

/** The pages. Each folder is private to its page. */
export const PAGES = ["expander", "landing", "library", "manager", "probe"];

export type Layer =
  | "core" | "tooling" | "node" | "cli" | "sheet" | "review" | "web" | `page:${string}` | "outside";

/** The layer a repository path belongs to. Paths use forward slashes, from the repository root. */
export function layerOf(path: string): Layer {
  if (path.startsWith("packages/core/src/")) return "core";
  const tool = /^src\/([^/]+)\//.exec(path);
  if (tool && TOOLING.includes(tool[1]!)) return "tooling";
  const own = /^src\/(node|cli|sheet|review)\//.exec(path);
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
 * `cli`, `sheet`, `review` or tooling lands in no layer at all, and the layer test fails on it.
 *
 * `review` reads this repository's own source and test output. It needs the filesystem, git and
 * the TypeScript compiler, and nothing that ships.
 */
export const RULES: Record<string, { layers: string[]; bare: string[] }> = {
  core: { layers: ["core"], bare: [] },
  tooling: { layers: ["core", "tooling", "sheet"], bare: [] },
  sheet: { layers: ["core", "sheet"], bare: [] },
  node: { layers: ["core", "node"], bare: ["node:"] },
  review: { layers: ["review"], bare: ["node:", "typescript"] },
  cli: { layers: ["core", "tooling", "sheet", "node", "review", "cli"], bare: ["node:"] },
  web: { layers: ["core", "tooling", "sheet", "web"], bare: [] },
};

/** The rules for one layer. A page gets the shared web rules plus its own folder. */
export function rulesFor(layer: Layer): { layers: string[]; bare: string[] } {
  if (layer.startsWith("page:")) return { layers: [...RULES.web!.layers, layer], bare: [] };
  return RULES[layer] ?? { layers: [], bare: [] };
}

/** Whether a file in layer `from` may import a local file in layer `to`. */
export function mayImport(from: Layer, to: Layer): boolean {
  return rulesFor(from).layers.includes(to);
}

/**
 * Every rule `path` breaks, given its imports and its comment-free source.
 *
 * Kept separate from any file walk so a test can feed it an invented file.
 */
export function violationsOf(path: string, specifiers: string[], source: string): string[] {
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
