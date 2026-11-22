/**
 * The review map's model: the repository as components, files and functions, with what is wrong
 * with each.
 *
 * A **component** is a folder. It is the unit the diagram draws as a box, and the unit the
 * stability rule below is asked of, because a single file is too small to have a role in the
 * architecture and a layer is too big to show where a dependency goes.
 *
 * Three things are flagged:
 *
 * - **Red, wrong-way import:** a file imports a layer its own layer may not use (`layers.ts`). The
 *   layer test fails on these, so on `main` there are none. A what-if move can make some.
 * - **Red, CRAP over the limit:** a function both complex and not run by the tests (`coverage.ts`).
 * - **Amber, unstable dependency:** a component depends on one that is less stable than itself.
 *   Stability is Robert C. Martin's instability, `I = Ce / (Ca + Ce)`: `Ce` is how many components
 *   it uses, `Ca` how many use it. A component many others use and that uses little (`I` near 0)
 *   is hard to change without breaking its users, so it should only lean on things at least as
 *   stable. This is advice, not a rule: amber asks a reviewer to look, it fails nothing.
 *
 * **What-if moves.** `moves` maps a file's path to a path it does not have yet. The model is then
 * built as if the file were there: its layer, its component, and every rule are asked of the new
 * path, and nothing on disk changes. This is how the agent attached to the review answers "what if
 * this went into core?" before any code moves.
 */

import { posix } from "node:path";
import type { FunctionInfo } from "./complexity.js";
import { CRAP_LIMIT, crapScore, functionCoverage, type LineHits } from "./coverage.js";
import { layerOf, mayImport, rulesFor, type Layer } from "./layers.js";

/** One file as read from disk: what it imports and what it contains. */
export interface SourceFacts {
  path: string;
  /** Local imports as repository paths, and bare specifiers as written. */
  local: string[];
  bare: string[];
  /** Browser globals the file reads. Only a fault in core. */
  browserGlobals: string[];
  functions: FunctionInfo[];
}

export interface ModelInput {
  files: SourceFacts[];
  /** Line coverage, or `undefined` when the tests were not run. */
  hits: LineHits | undefined;
  churn: Map<string, number>;
  changed: Set<string>;
  moves: Map<string, string>;
}

export interface FunctionView {
  name: string;
  line: number;
  complexity: number;
  /** 0 to 1, or `null` when the file never ran under the tests. */
  coverage: number | null;
  crap: number | null;
  red: boolean;
}

export interface FileView {
  path: string;
  /** The path on disk when a what-if move put this file somewhere else. */
  was: string | null;
  component: string;
  layer: Layer;
  changed: boolean;
  churn: number;
  ran: boolean | null;
  functions: FunctionView[];
  /** Wrong-way imports and forbidden globals, one line each. */
  problems: string[];
}

export interface ComponentView {
  id: string;
  layer: Layer;
  files: string[];
  ca: number;
  ce: number;
  instability: number;
  churn: number;
  changed: boolean;
  red: boolean;
  amber: boolean;
}

export interface EdgeView {
  from: string;
  to: string;
  /** File-level imports behind this arrow, `from-file -> to-file`. */
  imports: string[];
  wrong: boolean;
  unstable: boolean;
}

export interface Model {
  coverage: boolean;
  crapLimit: number;
  moves: [string, string][];
  components: ComponentView[];
  files: FileView[];
  edges: EdgeView[];
  summary: { red: number; amber: number; changedFiles: number; redFunctions: number; wrongImports: number };
}

/** The component of a repository path: its folder. */
export function componentOf(path: string): string {
  return posix.dirname(path);
}

export function buildModel(input: ModelInput): Model {
  const where = (path: string): string => input.moves.get(path) ?? path;

  const files: FileView[] = input.files.map((facts) => {
    const path = where(facts.path);
    const layer = layerOf(path);
    const fileHits = input.hits?.get(facts.path);
    const ran = input.hits ? fileHits !== undefined : null;
    const functions = facts.functions.map((fn): FunctionView => {
      const coverage = input.hits ? functionCoverage(fn, fileHits) ?? null : null;
      const crap = coverage === null ? null : crapScore(fn.complexity, coverage);
      return { name: fn.name, line: fn.line, complexity: fn.complexity, coverage, crap, red: crap !== null && crap > CRAP_LIMIT };
    });

    const problems: string[] = [];
    for (const target of facts.local) {
      const to = where(target);
      if (!mayImport(layer, layerOf(to))) problems.push(`imports ${to} (${layerOf(to)}), which ${layer} may not use`);
    }
    for (const specifier of facts.bare) {
      if (!rulesFor(layer).bare.some((prefix) => specifier.startsWith(prefix))) {
        problems.push(`imports ${specifier}, which ${layer} may not use`);
      }
    }
    if (layer === "core") for (const api of facts.browserGlobals) problems.push(`uses ${api}, which core may not`);

    return {
      path,
      was: path === facts.path ? null : facts.path,
      component: componentOf(path),
      layer,
      changed: input.changed.has(facts.path),
      churn: input.churn.get(facts.path) ?? 0,
      ran,
      functions,
      problems,
    };
  });

  // Arrows between components, from file imports.
  const byPath = new Map(input.files.map((facts) => [where(facts.path), facts]));
  const edgeMap = new Map<string, EdgeView>();
  for (const file of files) {
    const facts = byPath.get(file.path)!;
    for (const target of facts.local) {
      const to = where(target);
      const toComponent = componentOf(to);
      if (toComponent === file.component) continue;
      const key = `${file.component}\u0000${toComponent}`;
      const edge = edgeMap.get(key) ?? { from: file.component, to: toComponent, imports: [], wrong: false, unstable: false };
      edge.imports.push(`${file.path} -> ${to}`);
      if (!mayImport(file.layer, layerOf(to))) edge.wrong = true;
      edgeMap.set(key, edge);
    }
  }
  const edges = [...edgeMap.values()];

  const ids = [...new Set(files.map((file) => file.component))].sort();
  const ca = new Map(ids.map((id) => [id, new Set<string>()]));
  const ce = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    ce.get(edge.from)?.add(edge.to);
    ca.get(edge.to)?.add(edge.from);
  }
  const instability = (id: string): number => {
    const out = ce.get(id)?.size ?? 0;
    const into = ca.get(id)?.size ?? 0;
    return out + into === 0 ? 0 : out / (out + into);
  };
  for (const edge of edges) edge.unstable = instability(edge.from) < instability(edge.to);

  const components: ComponentView[] = ids.map((id) => {
    const own = files.filter((file) => file.component === id);
    return {
      id,
      layer: own[0]!.layer,
      files: own.map((file) => file.path).sort(),
      ca: ca.get(id)!.size,
      ce: ce.get(id)!.size,
      instability: instability(id),
      churn: own.reduce((sum, file) => sum + file.churn, 0),
      changed: own.some((file) => file.changed),
      red: own.some((file) => file.problems.length > 0 || file.functions.some((fn) => fn.red))
        || edges.some((edge) => edge.from === id && edge.wrong),
      amber: edges.some((edge) => edge.from === id && edge.unstable),
    };
  });

  return {
    coverage: input.hits !== undefined,
    crapLimit: CRAP_LIMIT,
    moves: [...input.moves],
    components,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    edges,
    summary: {
      red: components.filter((component) => component.red).length,
      amber: components.filter((component) => component.amber).length,
      changedFiles: files.filter((file) => file.changed).length,
      redFunctions: files.reduce((sum, file) => sum + file.functions.filter((fn) => fn.red).length, 0),
      wrongImports: files.reduce((sum, file) => sum + file.problems.length, 0),
    },
  };
}
