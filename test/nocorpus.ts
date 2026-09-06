/**
 * Run the suite as a fresh clone sees it: no corpus.
 *
 *   npm run test:nocorpus
 *
 * ## Why this is a script and not a test
 *
 * The corpus is the author's own music and is deliberately not in the repository, so **285 of the
 * 1,245 tests skip for anyone who clones it**. That is the run a contributor gets, and it is the
 * one nobody here ever performs — the corpus is always sitting next to the repo on this machine.
 *
 * The gap showed: one test in `soundmap.test.ts` reached the corpus through a local helper without
 * the `{ skip: NO_CORPUS }` its two siblings carried. A stranger cloning the repo got a failing
 * test and a stack trace out of `corpus.ts`, which reads as "this project is broken" rather than
 * "you have no corpus".
 *
 * **A static scan for the missing guard was tried first and abandoned.** Finding which tests reach
 * the corpus means resolving calls through local helpers, and doing that on text rather than a
 * syntax tree walked past the end of a test whenever a string held an unbalanced bracket. It
 * reported six tests that were fine. Running the thing is exact, takes 40 seconds, and needs no
 * parser.
 *
 * `DN_CORPUS` is pointed at a path that does not exist, which is what `resolveCorpus` treats as
 * "no corpus". Pointing it at an *empty* directory is a different case on purpose: a corpus that
 * exists but lacks a fixture is a broken setup, and `requireCorpusFile` says so rather than
 * skipping.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "--test", "test/*.test.ts"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DN_CORPUS: join(root, ".no-such-corpus") },
  },
);

if (result.status !== 0) {
  console.error(
    "\nThe suite does not pass without a corpus. Someone cloning this repository sees the failures " +
      "above.\nA test that needs corpus files must carry `{ skip: NO_CORPUS }` — including when it " +
      "reaches them\nthrough a helper.",
  );
}
process.exit(result.status ?? 1);
