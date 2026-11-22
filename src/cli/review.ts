/**
 * Draw the review map: the repository as a layered diagram, with what a reviewer should look at
 * marked red or amber. See `docs/review-map.md`.
 *
 *   npm run review                              run the tests with coverage, then draw
 *   npm run review -- --base FETCH_HEAD         mark what differs from another base (default origin/main)
 *   npm run review -- --lcov out/review/coverage.lcov
 *                                               reuse the coverage of an earlier run
 *   npm run review -- --no-tests                skip the tests: no CRAP scores, much faster
 *   npm run review -- --move src/node/zip.ts=packages/core/src/archive/zip.ts
 *                                               what if this file lived there? Several pairs may
 *                                               follow one --move.
 *   npm run review -- --days 30                 the churn window (default 90 days)
 *
 * It writes `out/review/index.html` (open it in a browser) and `out/review/model.json` (what the
 * agent reads to answer questions about the map). Nothing in the source changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factsOf } from "../review/facts.js";
import { changedFiles, churn } from "../review/history.js";
import { ROOT, sourceFiles } from "../review/importgraph.js";
import { parseLcov } from "../review/coverage.js";
import { buildModel } from "../review/model.js";
import { renderPage } from "../review/page.js";
import { runTestsWithCoverage } from "../review/testrun.js";
import { cliArgs, fail } from "./args.js";

const args = cliArgs();
const out = join(ROOT, args.arg("out") ?? join("out", "review"));
const base = args.arg("base") ?? "origin/main";
const days = Number(args.arg("days") ?? 90);
if (!Number.isFinite(days) || days <= 0) fail("--days takes a number of days above 0");

const moves = new Map<string, string>();
for (const pair of args.list("move")) {
  const [from, to] = pair.split("=");
  if (!from || !to) fail(`--move takes old=new, not ${pair}`);
  if (!existsSync(join(ROOT, from))) fail(`--move: there is no ${from}`);
  moves.set(from.replaceAll("\\", "/"), to.replaceAll("\\", "/"));
}

mkdirSync(out, { recursive: true });

let lcov: string | undefined;
if (args.flag("no-tests")) {
  lcov = undefined;
} else if (args.arg("lcov")) {
  lcov = readFileSync(join(ROOT, args.arg("lcov")!), "utf8");
} else {
  const target = join(out, "coverage.lcov");
  console.log("Running the tests with coverage. This takes a few minutes.");
  const code = await runTestsWithCoverage(ROOT, target);
  if (code !== 0) console.warn(`\nThe tests exited with ${code}. The map uses the coverage they wrote anyway.`);
  lcov = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (lcov === undefined) console.warn("No coverage was written, so the map has no CRAP scores.");
}

let changed: Set<string>;
try {
  changed = changedFiles(ROOT, base);
} catch {
  console.warn(`Could not compare with ${base}, so nothing is marked as changed. Fetch it, or pass --base.`);
  changed = new Set();
}

const model = buildModel({
  files: sourceFiles().map(factsOf),
  hits: lcov === undefined ? undefined : parseLcov(lcov, ROOT),
  churn: churn(ROOT, days),
  changed,
  moves,
});

writeFileSync(join(out, "model.json"), JSON.stringify(model, null, 1));
writeFileSync(join(out, "index.html"), renderPage(model, moves.size ? "DNX review map: what-if" : "DNX review map"));

const s = model.summary;
console.log(`\nReview map: ${model.components.length} folders, ${model.files.length} files.`);
console.log(`  red: ${s.red} folders, ${s.redFunctions} functions over CRAP ${model.crapLimit}, ${s.wrongImports} wrong-way imports`);
console.log(`  amber: ${s.amber} folders depend on a less stable folder`);
console.log(`  changed since ${base}: ${s.changedFiles} files`);
console.log(`\nOpen ${join(out, "index.html")}`);
