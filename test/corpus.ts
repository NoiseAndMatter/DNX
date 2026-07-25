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
export const DN2_PROJECTS = "02_DN2/01_Projects";
export const DN2_CAPTURES = "02_DN2/reference_captures";
