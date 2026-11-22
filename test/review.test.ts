/**
 * The review map's measurements: complexity, coverage, CRAP, and the model's red and amber flags.
 *
 * Every expected value here is worked out by hand from the input, not taken from a run of the code.
 * A count that came from the counter would only prove the counter agrees with itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { functionsOf } from "../src/review/complexity.js";
import { crapScore, functionCoverage, parseLcov } from "../src/review/coverage.js";
import { buildModel, type SourceFacts } from "../src/review/model.js";

const SAMPLE = [
  "export function pick(a: number, b?: number): number {", // 1
  "  if (a > 0 && b !== undefined) return b;", //            2   if +1, && +1
  "  const list = [a].map((x) => x > 1 ? x : 0);", //        3   the arrow is its own function
  "  return b ?? a;", //                                     4   ?? +1
  "}", //                                                    5
  "class Box {", //                                          6
  "  open(n: number): void {", //                            7
  "    for (const i of [n]) {", //                           8   for-of +1
  "      switch (i) { case 1: break; case 2: break; default: break; }", // 9  two cases +2
  "    }", //                                                10
  "  }", //                                                  11
  "}", //                                                    12
].join("\n");

test("complexity counts each fork once, and a nested function on its own", () => {
  const found = functionsOf("sample.ts", SAMPLE);
  assert.deepEqual(found.map((fn) => [fn.name, fn.line, fn.complexity]), [
    ["pick", 1, 4], //                                1 + if + && + ??
    ["(anonymous, line 3)", 3, 2], //                 1 + ?:
    ["Box.open", 7, 4], //                            1 + for-of + case 1 + case 2
  ]);
  // pick's statements: the if (2), its return (2), the const (3), the return (4). The arrow's
  // expression is the arrow's line, not pick's.
  assert.deepEqual(found[0]!.statementLines, [2, 3, 4]);
});

test("coverage is asked of statement lines, and a file that never ran has none", () => {
  const lcov = [
    "SF:src\\a.ts", "DA:1,0", "DA:2,3", "DA:3,0", "DA:4,1", "end_of_record",
    // The same file from a second test process: line 3 ran there.
    "SF:src\\a.ts", "DA:3,2", "end_of_record",
  ].join("\n");
  const hits = parseLcov(lcov, "/repo");
  const fn = { name: "f", line: 1, endLine: 5, complexity: 2, statementLines: [2, 3, 4] };
  assert.equal(functionCoverage(fn, hits.get("src/a.ts")), 1);
  assert.equal(functionCoverage({ ...fn, statementLines: [1, 2] }, hits.get("src/a.ts")), 0.5);
  assert.equal(functionCoverage(fn, hits.get("src/b.ts")), undefined);
});

test("CRAP is c squared times uncovered cubed, plus c", () => {
  assert.equal(crapScore(5, 0), 30); //    25 + 5
  assert.equal(crapScore(6, 0), 42); //    36 + 6
  assert.equal(crapScore(10, 1), 10); //   covered: only the complexity
  assert.equal(crapScore(10, 0.5), 22.5); // 100 x 0.125 + 10
});

const fn = (name: string, complexity: number, statementLines: number[]) =>
  ({ name, line: statementLines[0] ?? 1, endLine: 99, complexity, statementLines });

const FILES: SourceFacts[] = [
  { path: "web/src/manager/main.ts", local: ["web/src/dom.ts", "packages/core/src/project/read.ts"], bare: [], browserGlobals: ["document"], functions: [] },
  { path: "web/src/dom.ts", local: [], bare: [], browserGlobals: ["document"], functions: [] },
  { path: "packages/core/src/project/read.ts", local: [], bare: [], browserGlobals: [], functions: [fn("read", 6, [2, 3])] },
  { path: "packages/core/src/expand/plan.ts", local: ["packages/core/src/project/read.ts"], bare: ["node:fs"], browserGlobals: [], functions: [] },
];

test("the model flags a wrong-way import, a forbidden global and a function over the CRAP limit", () => {
  const model = buildModel({
    files: FILES,
    hits: new Map([["packages/core/src/project/read.ts", new Map([[2, 0], [3, 0]])]]),
    churn: new Map([["web/src/dom.ts", 4]]),
    changed: new Set(["web/src/dom.ts"]),
    moves: new Map(),
  });

  const plan = model.files.find((file) => file.path === "packages/core/src/expand/plan.ts")!;
  assert.deepEqual(plan.problems, ["imports node:fs, which core may not use"]);

  // read: complexity 6, nothing ran, so 36 + 6 = 42, over 30.
  const read = model.files.find((file) => file.path === "packages/core/src/project/read.ts")!;
  assert.equal(read.functions[0]!.crap, 42);
  assert.equal(read.functions[0]!.red, true);

  // The page's files never ran under the tests: not run, so no score rather than a bad one.
  const main = model.files.find((file) => file.path === "web/src/manager/main.ts")!;
  assert.equal(main.ran, false);

  assert.equal(model.summary.changedFiles, 1);
  assert.equal(model.components.find((c) => c.id === "web/src")!.churn, 4);
  assert.equal(model.summary.wrongImports, 1);
  assert.equal(model.summary.redFunctions, 1);
});

test("instability: a folder that only uses others is 1, one that is only used is 0", () => {
  const model = buildModel({ files: FILES, hits: undefined, churn: new Map(), changed: new Set(), moves: new Map() });
  const of = (id: string) => model.components.find((c) => c.id === id)!;
  // manager uses web/src and core/project, and nobody uses it: Ce 2, Ca 0.
  assert.equal(of("web/src/manager").instability, 1);
  // core/project is used by manager and core/expand, and uses nothing: Ca 2, Ce 0.
  assert.equal(of("packages/core/src/project").instability, 0);
  // Every arrow here points from less stable to more stable, so nothing is amber.
  assert.equal(model.edges.some((edge) => edge.unstable), false);
});

test("a what-if move is judged at its new path and leaves the coverage of the old one", () => {
  // Move the shared DOM helper into core: core's rules now apply to it, and to who imports it.
  const model = buildModel({
    files: FILES,
    hits: undefined,
    churn: new Map(),
    changed: new Set(),
    moves: new Map([["web/src/dom.ts", "packages/core/src/dom.ts"]]),
  });
  const moved = model.files.find((file) => file.path === "packages/core/src/dom.ts")!;
  assert.equal(moved.was, "web/src/dom.ts");
  assert.equal(moved.layer, "core");
  assert.deepEqual(moved.problems, ["uses document, which core may not"]);
  // The page may import core, so its arrow to the moved file is not wrong.
  assert.equal(model.edges.find((edge) => edge.to === "packages/core/src")!.wrong, false);
});
