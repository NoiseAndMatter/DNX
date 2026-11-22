/**
 * Run the test suite once with coverage on, and write the result as LCOV.
 *
 * The run is the same `node --test` as `npm test`, through `tsx`, with three additions:
 * `--experimental-test-coverage`, an LCOV reporter to `lcovPath`, and `--enable-source-maps`, without
 * which the line numbers are those of the compiled JavaScript (see `coverage.ts`). A dot reporter
 * goes to the terminal, so a failing test is still seen.
 *
 * The run takes the whole suite, so it takes minutes. It runs at below-normal priority, as every long
 * run on this machine does, so the desk stays usable while it goes. The review command lowers its
 * own priority to do that, and stays low until it exits.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { join } from "node:path";

/** Run every `test/*.test.ts` under coverage. Resolves with the exit code; the LCOV file is written either way. */
export function runTestsWithCoverage(root: string, lcovPath: string): Promise<number> {
  const tests = readdirSync(join(root, "test")).filter((name) => name.endsWith(".test.ts")).map((name) => join("test", name));
  // Lowered here, before the spawn, so the test processes Node starts inherit it from the first one.
  try {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not allowed on this system. The run still works, at normal priority.
  }
  const child = spawn(process.execPath, [
    "--enable-source-maps", "--import", "tsx", "--test",
    "--experimental-test-coverage",
    "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
    "--test-reporter=dot", "--test-reporter-destination=stdout",
    ...tests,
  ], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
