/**
 * The corpus helpers themselves.
 *
 * Small, and the reason they exist is not: seven tests were guarding a *named fixture* with
 * `if (!existsSync(path)) return;` **after** `{ skip: NO_CORPUS }` had already passed. That is a
 * test which reports green having asserted nothing, and a suite that can do that is worth less than
 * its line count suggests.
 *
 * These check that the replacement guard is not itself vacuous — because a guard that never fires
 * is the same bug one level up, and this file would be the last place anyone thought to look.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_CORPUS, SKIP_REASON, requireCorpusFile, requireCorpusFiles, DN1_PROJECTS } from "./corpus.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

test("a fixture that is not there throws, and names itself", { skip }, () => {
  assert.throws(
    () => requireCorpusFile(DN1_PROJECTS, "NO SUCH PROJECT.dnprj"),
    (error: Error) => {
      assert.match(error.message, /NO SUCH PROJECT\.dnprj/, "the message has to name the missing file");
      // The sentence matters as much as the throw: whoever hits this needs to know that adding the
      // file and deleting the test are both fine, and that leaving it green is not.
      assert.match(error.message, /asserts nothing without it/);
      return true;
    },
  );
});

test("a fixture that is there is returned rather than merely allowed", { skip }, () => {
  const path = requireCorpusFile(DN1_PROJECTS, "002 MORNING_JAM.dnprj");
  assert.match(path, /002 MORNING_JAM\.dnprj$/);
});

test("an empty listing throws, because a loop over nothing succeeds", { skip }, () => {
  assert.throws(() => requireCorpusFiles(DN1_PROJECTS, ".nosuchextension"), /would iterate over nothing/);
  assert.ok(requireCorpusFiles(DN1_PROJECTS, ".dnprj").length > 0);
});
