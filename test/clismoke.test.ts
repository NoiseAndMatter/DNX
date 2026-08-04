/**
 * Every command-line entry point, actually run.
 *
 * ## Why this exists before the refactor that needed it
 *
 * Eleven commands had no test of any kind. They are the only way most of this codebase is used, and
 * their argument parsing was nine copies of the same closure — so a shared version would have been
 * a change to eleven untested entry points at once. The audit said to ship that with a smoke
 * script; this is it, and it was written first so the refactor had something to be checked against.
 *
 * ## What it does and does not claim
 *
 * It launches each command as a real subprocess and checks it behaves at the boundary: that running
 * it with no arguments prints usage and exits non-zero rather than crashing, and that the ones with
 * a safe read-only mode produce output when pointed at a real project.
 *
 * **It does not check what they compute.** That is the rest of the suite's job, on the libraries
 * these commands are thin wrappers around. What is unique to a command is exactly the part covered
 * here: does it start, does it parse, does it say something useful when it cannot.
 *
 * Subprocesses are slow, so the read-only runs are limited to the commands where a wrong answer
 * would be invisible from the outside.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NO_CORPUS, SKIP_REASON, requireCorpusFile, DN1_PROJECTS } from "./corpus.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every entry point under `src/cli/`, except the server, which does not exit. */
const COMMANDS = [
  "convert", "copy", "diff", "extractblank", "extractblankproject", "hardwaretest",
  "inspect", "plan", "project", "rearrange", "rebuild", "rename", "sheet", "tags",
  "track", "trackhwtest", "usbcap",
];

function run(command: string, args: string[] = []): { code: number; out: string; err: string } {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli", `${command}.ts`), ...args],
    { encoding: "utf8", cwd: ROOT, timeout: 120_000 },
  );
  return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

for (const command of COMMANDS) {
  test(`${command} explains itself instead of crashing`, { timeout: 120_000 }, () => {
    const { code, out, err } = run(command);
    const said = `${out}${err}`;

    // A stack trace is the failure this catches: a command that throws on missing arguments has
    // told the user nothing they can act on, and it is the first thing anyone types.
    assert.doesNotMatch(said, /^\s+at .*\(/m, `${command} threw rather than explaining:\n${said}`);
    assert.notEqual(code, 0, `${command} with no arguments should not report success`);
    assert.match(
      said,
      /usage|Usage|--\w/,
      `${command} should say how it is used, but printed:\n${said}`,
    );
  });
}

const skip = NO_CORPUS ? SKIP_REASON : false;

test("the read-only commands produce output for a real project", { skip, timeout: 120_000 }, () => {
  const project = requireCorpusFile(DN1_PROJECTS, "001 PRESETS.dnprj");

  for (const [command, args] of [
    ["project", ["--project", project]],
    ["plan", ["--project", project]],
    ["tags", ["--project", project]],
  ] as [string, string[]][]) {
    const { code, out, err } = run(command, args);
    assert.equal(code, 0, `${command} failed on a real project:\n${err}`);
    assert.ok(out.trim().length > 0, `${command} produced nothing`);
  }
});

test("a flag given without its value gets the usage text, not a file called --out", { timeout: 120_000 }, () => {
  // The bug that was in all nine copies of `arg`: `indexOf("--project") + 1` is the *next flag*,
  // so the command tried to open a file named after an option and failed with ENOENT — which says
  // nothing about the argument actually being missing.
  const { out, err } = run("convert", ["--from", "--expand"]);
  const said = `${out}${err}`;
  assert.doesNotMatch(said, /ENOENT|no such file/i, `it tried to open the flag as a path:\n${said}`);
  assert.match(said, /usage|Usage|--\w/, `it should have printed usage, but said:\n${said}`);
});
