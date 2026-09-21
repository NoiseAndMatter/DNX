/**
 * The probe's functions, read out of its own source.
 *
 * The probe is entirely DOM and MIDI, so the properties its writes must have are checked by reading
 * the functions rather than by running them. `safewrite.test.ts` checks that each write copies what
 * it overwrites before sending; `writeenable.test.ts` checks that each one passes the WRITE switch.
 * Both need the same slice of the same source, so the slicing lives here once.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "probe");

/**
 * Every module of the probe, read as one text.
 *
 * **A folder, not a file.** The page was a single 2,333-line module until it was split, and the
 * writes now sit in `writeback.ts`, `writeslot.ts` and `drivefile.ts` while the readiness check
 * they all pass through sits in `ready.ts`. What these fences guard is a property of the *page* —
 * every write copies first, every write passes the switch — so naming one file would have made
 * them pass by finding nothing the moment a write moved out of it.
 *
 * Sorted, so a function's slice does not depend on the order the filesystem hands the names back.
 */
export function probeSource(): string {
  return readdirSync(PROBE)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => readFileSync(join(PROBE, name), "utf8"))
    .join("\n");
}

/** The names of every top-level function in the probe, in source order. */
export function probeFunctionNames(): string[] {
  return [...probeSource().matchAll(/^(?:async )?function (\w+)\(/gm)].map((m) => m[1]!);
}

/** One top-level function of the probe, from its declaration to its closing brace at column 0. */
export function probeWrite(name: string, maxBytes = 12_000): string {
  const source = probeSource();

  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source)?.index ?? -1;
  assert.ok(start > 0, `${name} has been renamed; this fence no longer guards anything`);

  // Matched rather than searched for: the file is CRLF on this machine and LF in CI, and
  // `indexOf("\n}\n")` quietly returns -1 on the first of those, which `slice` then reads as "one
  // byte from the end" and hands back most of the file. A fence measuring the wrong region passes
  // for reasons that have nothing to do with the code it names.
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end, `${name} has no closing brace at column 0`);
  const body = source.slice(start, start + end.index);
  assert.ok(body.length < maxBytes, `${name}'s body came out at ${body.length} bytes; the slice is wrong`);
  return body;
}
