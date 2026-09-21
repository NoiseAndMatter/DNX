/**
 * Core reads no clock and no dice it was not handed.
 *
 * ## Why this is a rule and not a preference
 *
 * The platform-free part of `src/` is about to run on a second host, and two of its outputs are
 * not functions of their inputs: the identity stamped into a new project, and the timestamps in a
 * backup manifest and in the name of the copy taken before an overwrite. Wherever those are read
 * off a global, three things follow. A test cannot assert on the output. Two runs over the same
 * bytes differ, so a diff cannot tell a real change from the hour. And a host whose clock or
 * randomness is not the one we assumed has no way to say so.
 *
 * The rule is not "never use them" — a default has to come from somewhere, and every host has
 * `Math.random` and `Date`. It is **the global may only appear as the default of a seam**: a
 * parameter, or an option resolved with `??`. That is the shape the codebase already used in
 * `naming.ts`, `capture.ts`, `dumpreader.ts` and the record half of `safewrite.ts`; this makes it
 * the rule and closes the three places that had not got there.
 *
 * ## What it does not cover
 *
 * Elapsed time. `dumpreader.ts` and the timing helpers measure how long a device took, and a
 * measurement that a caller can fake is a measurement of nothing. Those read `Date.now` through
 * an injected `now` already, which this happens to accept for the same reason it accepts the
 * others: it arrives as an option.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, code, repoPath } from "./importgraph.js";
import { mintProjectId } from "../src/project/dn2image.js";

/** Folders of `src/` that are not core, so not bound by this. See `layers.test.ts`. */
const NOT_CORE = ["node", "cli", "sheet", "research", "hardwaretest"];

/**
 * The globals that make an output depend on when it ran or on luck.
 *
 * `new Date(x)` is absent deliberately: parsing or copying a given instant is arithmetic. It is
 * the **empty** constructor that reads the clock.
 */
const AMBIENT: [RegExp, string][] = [
  [/\bMath\.random\b/g, "Math.random"],
  [/\bnew Date\(\s*\)/g, "new Date()"],
  [/\bDate\.now\b/g, "Date.now"],
];

/**
 * Whether this occurrence is the default of a seam rather than a reach for the global.
 *
 * Two shapes, which are the ones the codebase uses.
 *
 * **A parameter default**: an `=` before it and a `)` or `,` after, as in
 * `mintProjectId(random = Math.random)` and `hhmm(when = new Date())`. Both halves are required.
 * Looking only backwards passes `const at = new Date().toISOString()`, which is the exact line
 * this rule exists to catch; looking only forwards passes `report(new Date())`, which is a clock
 * read wearing an argument's clothes.
 *
 * **An option's fallback**: `??` before it, as in `options.now?.() ?? new Date()` and
 * `options.now ?? (() => Date.now())`.
 */
function isDefault(source: string, at: number, length: number): boolean {
  const before = source.slice(Math.max(0, at - 40), at);
  if (/\?\?\s*\(?\s*(\(\)\s*=>\s*)?$/.test(before)) return true;
  const assigned = /[^=!<>]=\s*$/.test(before);
  const ends = /^\s*[),]/.test(source.slice(at + length, at + length + 8));
  return assigned && ends;
}

/** Every ambient read in `source` that is not a seam's default, named by what it reached for. */
export function ambientReads(source: string): string[] {
  const found: string[] = [];
  for (const [pattern, name] of AMBIENT) {
    for (const match of source.matchAll(pattern)) {
      if (!isDefault(source, match.index, match[0].length)) found.push(name);
    }
  }
  return found;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const CORE = tsFiles(join(ROOT, "src")).filter(
  (file) => !NOT_CORE.includes(repoPath(file).split("/")[1]!),
);

test("nothing in core reads the clock or the dice except as a seam's default", () => {
  assert.ok(CORE.length > 40, `only ${CORE.length} core files found; the walk is wrong`);

  const offenders = CORE.flatMap((file) =>
    ambientReads(code(file)).map((api) => `${repoPath(file)} reads ${api}`));

  assert.deepEqual(offenders, [],
    "these make an output depend on when it ran. Take it as a parameter or an option, the way " +
      "`mintProjectId`, `BackupOptions.now` and `SafeFileWriteOptions.now` do:\n  " +
      offenders.join("\n  "));
});

test("the scan sees an ambient read, and lets a seam's default through", () => {
  // A check that cannot fail is the failure mode this whole file exists to prevent, so it is fed
  // both answers rather than trusted to be looking.
  assert.deepEqual(ambientReads("const id = Math.floor(Math.random() * 16);"), ["Math.random"]);
  assert.deepEqual(ambientReads("const at = new Date().toISOString();"), ["new Date()"]);
  assert.deepEqual(ambientReads("const ms = Date.now() - started;"), ["Date.now"]);

  assert.deepEqual(ambientReads("function mint(random: () => number = Math.random) {}"), []);
  assert.deepEqual(ambientReads("export function hhmm(when = new Date()): string {}"), []);
  assert.deepEqual(ambientReads("function f(now: Date = new Date(), other: number) {}"), []);
  assert.deepEqual(ambientReads("const at = options.now?.() ?? new Date();"), []);
  assert.deepEqual(ambientReads("this.now = options.now ?? (() => Date.now());"), []);

  // And a given instant is not a clock read.
  assert.deepEqual(ambientReads('const at = new Date("2026-09-22T10:00:00Z");'), []);

  // Neither half of the parameter rule is enough on its own.
  assert.deepEqual(ambientReads("report(new Date());"), ["new Date()"]);
  assert.deepEqual(ambientReads("const started = Date.now();"), ["Date.now"]);
});

test("a handed source of randomness is the one used", () => {
  /*
   * The seam is only real if the default is not reached for anyway. Two calls with a fixed source
   * must agree, and must differ from two calls with a different one.
   */
  const fixed = (value: number) => () => value;
  assert.equal(mintProjectId(fixed(0)), 0);
  assert.equal(mintProjectId(fixed(0.5)), 0x80008000);
  assert.equal(mintProjectId(fixed(0.25)), mintProjectId(fixed(0.25)));
  assert.notEqual(mintProjectId(fixed(0.25)), mintProjectId(fixed(0.75)));

  // The halves are drawn separately, which is the point of the two calls rather than one scaled
  // one. A source that changes between them must show in both halves.
  let nth = 0;
  const alternating = (): number => (nth++ % 2 === 0 ? 0 : 0.5);
  assert.equal(mintProjectId(alternating), 0x00008000);
});
