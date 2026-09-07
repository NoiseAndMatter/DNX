/**
 * No control characters in source.
 *
 * ## The failure this exists to stop
 *
 * A regex written as `/\b(\w+)\b/` inside a generating script loses its backslashes when the script
 * treats `\b` as an escape. What lands in the file is the **backspace character**, `0x08`, and the
 * regex quietly matches nothing. It prints identically to the intended form in a terminal, in a
 * diff, and in a code review.
 *
 * This happened three times in one session. Twice the regex was inside a test, so the test passed
 * by finding nothing: `docstatus.test.ts` reported "only 0 offset claims found", and
 * `settings.test.ts` reported a key as uncleared when the clear list covered it. Half an hour went
 * into the second one before anybody looked at the bytes.
 *
 * A search for the character finds it in a second. Nobody thinks to search for it.
 *
 * The class below is written as `\u` escapes on purpose, so this file cannot contain the thing it
 * forbids.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["src", "test", "web/src", "docs"];
const SUFFIXES = [".ts", ".js", ".md", ".css", ".html"];

/** Tab, newline and carriage return are ordinary. The rest below `0x20`, plus DEL, are mistakes. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SUFFIXES.some((s) => entry.name.endsWith(s))) out.push(path);
  }
}

test("no source file carries a stray control character", () => {
  const files: string[] = [];
  for (const dir of SCAN) walk(join(ROOT, dir), files);
  assert.ok(files.length > 150, `only ${files.length} files found; the scan is in the wrong place`);

  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!CONTROL.test(src)) continue;
    const line = src.split(/\r?\n/).findIndex((l) => CONTROL.test(l)) + 1;
    const code = src.match(CONTROL)![0]!.charCodeAt(0).toString(16).padStart(2, "0");
    offenders.push(`${relative(ROOT, file)}:${line} carries 0x${code}`);
  }

  assert.deepEqual(offenders, [],
    "a control character in source prints as nothing and breaks the regex holding it");
});
