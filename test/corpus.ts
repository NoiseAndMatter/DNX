/**
 * Locating the test corpus.
 *
 * Many tests validate against real Digitone projects. Those files are the author's own
 * music and are deliberately NOT part of this repository — they are private, and shipping
 * a stranger's projects with a tool is not something to do casually.
 *
 * So the corpus is found at run time instead of being committed:
 *
 *   1. `DN_CORPUS`, if set — an absolute path to a folder laid out like `00_Examples/`.
 *   2. otherwise a sibling `dn_sysex/00_Examples/` next to this repository.
 *
 * When neither exists, corpus-dependent tests skip rather than fail, so a fresh clone runs
 * a green suite covering everything that does not need real files: the 8-in-7 codec, the
 * SysEx container, LZ4 round-tripping, placement rules, ranking and allocation.
 *
 * Expected layout:
 *
 *   <corpus>/01_DN1/01_Projects/*.dnprj      Digitone 1 projects
 *   <corpus>/01_DN1/02_Sounds/*.syx          Digitone 1 factory sound banks
 *   <corpus>/02_DN2/01_Projects/*.dn2prj     Digitone II projects
 *   <corpus>/02_DN2/reference_captures/*.syx native DN2 SysEx pattern captures
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function windowsSafe(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

/**
 * Always ends with a forward slash.
 *
 * Some tests build paths by concatenation (`${CORPUS}01_DN1/...`) rather than `join`, so a
 * missing trailing separator silently turns into "corpus not found" and those tests skip
 * instead of failing — the worst possible failure mode, since a green run then means
 * nothing. Normalising here removes the trap from every call site at once.
 */
function withTrailingSlash(path: string): string {
  return path.endsWith("/") || path.endsWith("\\") ? path : `${path}/`;
}

function resolveCorpus(): string | undefined {
  // An explicit setting is authoritative: if DN_CORPUS is set but missing, that is a
  // configuration error and silently falling back to a sibling folder would hide it.
  const fromEnv = process.env["DN_CORPUS"];
  if (fromEnv !== undefined) return existsSync(fromEnv) ? withTrailingSlash(fromEnv) : undefined;

  const sibling = windowsSafe(new URL("../../dn_sysex/00_Examples/", import.meta.url));
  return existsSync(sibling) ? withTrailingSlash(sibling) : undefined;
}

/** Absolute path to the corpus root, or undefined when it is not available. */
export const CORPUS = resolveCorpus();

/** True when corpus-dependent tests cannot run. Pass straight to `{ skip }`. */
export const NO_CORPUS = CORPUS === undefined;

/** Reason string for skipped tests, so the output explains itself. */
export const SKIP_REASON =
  "no corpus: set DN_CORPUS to a folder laid out like 00_Examples/, or place one beside this repo";

/** Resolve a path inside the corpus. Throws when the corpus is absent — guard with NO_CORPUS. */
export function corpusPath(...parts: string[]): string {
  if (!CORPUS) throw new Error(SKIP_REASON);
  return join(CORPUS, ...parts);
}

/**
 * A corpus path that **must** be there, or a thrown error naming it.
 *
 * ## The failure this exists to stop
 *
 * `{ skip: NO_CORPUS }` answers "is there a corpus at all". It says nothing about whether *this*
 * fixture is in it — so tests grew a second guard, `if (!existsSync(path)) return;`, which runs
 * **after** the skip has already passed. The corpus is present, the file is not, and the test
 * reports green having asserted nothing at all.
 *
 * Seven tests were doing that. A suite that goes green when its evidence is missing is worse than
 * one that fails, because the failure is at least visible.
 *
 * > A missing corpus is a reason to skip. A missing fixture inside a corpus that exists is a
 * > broken test, and it should say so.
 */
export function requireCorpusFile(...parts: string[]): string {
  const path = corpusPath(...parts);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is not in the corpus. This test asserts nothing without it — add the file, or ` +
        `delete the test rather than letting it pass by finding nothing.`,
    );
  }
  return path;
}

/**
 * Corpus files that must not be an empty list.
 *
 * The looping equivalent of the above: a `for` over nothing completes successfully, so a test that
 * checks a thousand patterns and a test that checks none are indistinguishable in the output.
 */
export function requireCorpusFiles(subdir: string, extension: string): string[] {
  const files = corpusFiles(subdir, extension);
  if (files.length === 0) {
    throw new Error(
      `no ${extension} files under ${subdir} in the corpus — this test would iterate over nothing ` +
        `and report success`,
    );
  }
  return files;
}

/** Files matching an extension under a corpus subdirectory, sorted. Empty when absent. */
export function corpusFiles(subdir: string, extension: string): string[] {
  if (!CORPUS) return [];
  const dir = join(CORPUS, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(extension.toLowerCase()))
    .sort()
    .map((f) => join(dir, f));
}

/** Every file with an extension anywhere under the corpus, recursively. */
export function corpusFilesRecursive(extension: string, from = CORPUS): string[] {
  if (!from) return [];
  const out: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const path = join(from, entry.name);
    if (entry.isDirectory()) out.push(...corpusFilesRecursive(extension, path));
    else if (entry.name.toLowerCase().endsWith(extension.toLowerCase())) out.push(path);
  }
  return out.sort();
}

export const DN1_PROJECTS = "01_DN1/01_Projects";
export const DN1_SOUNDS = "01_DN1/02_Sounds";
/** One project captured three ways around the OS 1.43 update. See `os143.test.ts`. */
export const DN1_OS143 = "01_DN1/03_OS143";
export const DN2_PROJECTS = "02_DN2/01_Projects";
export const DN2_CAPTURES = "02_DN2/reference_captures";
