/**
 * The argument parser every command shares.
 *
 * Pure, because `cliArgs` takes the array rather than reading `process.argv` — which is the whole
 * reason it can be tested at all. Nine copies of this logic existed and none of them was ever
 * exercised except by running a command and looking at the output.
 *
 * `test/clismoke.test.ts` covers the other half: that the commands actually start.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cliArgs } from "../src/cli/args.js";

test("a value is the token after its flag", () => {
  const { arg } = cliArgs(["--project", "MY JAM.dnprj", "--out", "build"]);
  assert.equal(arg("project"), "MY JAM.dnprj");
  assert.equal(arg("out"), "build");
  assert.equal(arg("missing"), undefined);
});

test("a flag standing where a value should be is not a value", () => {
  // The defect that was in all nine copies. `indexOf("--from") + 1` is `"--expand"`, so the command
  // opened a file named after an option and died with `ENOENT: open '--expand'` — which tells you
  // nothing about the argument you actually left out.
  const { arg } = cliArgs(["--from", "--expand"]);
  assert.equal(arg("from"), undefined, "a missing value must read as missing, so usage is printed");
});

test("a flag at the very end has no value rather than crashing", () => {
  assert.equal(cliArgs(["--out"]).arg("out"), undefined);
});

test("flags are present or absent, and nothing else", () => {
  const { flag } = cliArgs(["--expand", "--dry-run"]);
  assert.equal(flag("expand"), true);
  assert.equal(flag("dry-run"), true);
  assert.equal(flag("rules"), false);
});

test("a list takes every value up to the next flag", () => {
  // `--keep A1 A4` — the shape a few commands were scanning for by hand.
  const { list } = cliArgs(["--keep", "A1", "A4", "--out", "build"]);
  assert.deepEqual(list("keep"), ["A1", "A4"]);
  assert.deepEqual(list("out"), ["build"]);
  assert.deepEqual(list("absent"), []);
});

test("a list that runs to the end of the arguments still terminates", () => {
  assert.deepEqual(cliArgs(["--keep", "A1", "A4"]).list("keep"), ["A1", "A4"]);
});

test("a flag immediately followed by another yields an empty list, not the next flag", () => {
  assert.deepEqual(cliArgs(["--keep", "--out", "build"]).list("keep"), []);
});

test("the raw arguments are still available for the commands that parse positionally", () => {
  // `inspect` and `diff` read positions rather than named options, and forcing them through a
  // named-argument reader would have been a worse fit than letting them see the array.
  const argv = ["a.dnprj", "b.dnprj", "--verbose"];
  assert.deepEqual([...cliArgs(argv).argv], argv);
});

test("the first occurrence wins when a flag is repeated", () => {
  // Not a decision anyone made — it is what `indexOf` does, and every copy did the same. Pinned so
  // that if it ever needs to become last-wins, it changes deliberately rather than by accident.
  assert.equal(cliArgs(["--out", "first", "--out", "second"]).arg("out"), "first");
});
