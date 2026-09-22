/**
 * The four things every command-line entry point does before it does anything interesting.
 *
 * ## Why it is worth sharing four lines
 *
 * Because there were **nine copies of `arg`**, four of `fail`, and two shapes of "load a project",
 * and they all agreed — which is exactly the situation where a shared version pays. Nothing had
 * drifted yet. The eleventh command would have been the one that did.
 *
 * And because one of the four lines is subtly wrong in every copy:
 *
 * ```
 * npm run convert -- --project --out build/
 * ```
 *
 * `argv.indexOf("--project") + 1` is `"--out"`, so the command reads a file called `--out` and
 * fails with `ENOENT: no such file or directory, open '--out'`. **A missing value should produce
 * the usage message**, which is the one thing that tells you what you meant to type. Fixed once
 * here rather than nine times, and see `valueOf` for why treating a `--`-prefixed token as a value
 * is safe to refuse.
 */

import { readFileSync } from "node:fs";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../node/projectfile.js";
import type { ProjectManifest, ProjectPayload } from "@noiseandmatter/dnx-core/project/container.js";

export interface CliArgs {
  /** The value after `--name`, or `undefined` when it is absent or has no value. */
  arg(name: string): string | undefined;
  /** Whether `--name` is present. */
  flag(name: string): boolean;
  /**
   * Every value after `--name`, up to the next `--flag` or the end.
   *
   * For the handful of options that take several — `--keep A1 A4` — which each such command was
   * scanning for by hand.
   */
  list(name: string): string[];
  /** The raw arguments, for the two commands that parse positionally. */
  readonly argv: readonly string[];
}

/**
 * Read `process.argv`, or an array supplied by a test.
 *
 * Taking the array is what makes this testable at all: `process.argv` is global, and a helper that
 * could only be exercised by launching a subprocess would not have been.
 */
export function cliArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  return {
    argv,
    arg: (name) => valueOf(argv, name),
    flag: (name) => argv.includes(`--${name}`),
    list: (name) => {
      const at = argv.indexOf(`--${name}`);
      if (at === -1) return [];
      const out: string[] = [];
      for (let i = at + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) out.push(argv[i]!);
      return out;
    },
  };
}

/**
 * The value after a flag, refusing another flag as a value.
 *
 * **Nothing this tool takes as a value begins with `--`**: they are file paths, slot names like
 * `A1`, track numbers and project names. So a `--` where a value should be always means the value
 * was left out, and reporting it as absent gets the user the usage text instead of a confusing
 * error about a file named after an option.
 */
function valueOf(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/**
 * Say what is wrong and stop.
 *
 * `stderr`, so a command's real output can still be piped somewhere while the complaint goes to the
 * terminal — and a non-zero exit, so a script calling this notices.
 */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A project file, in the shape the commands that rewrite one need. */
export interface LoadedProjectFile {
  manifest: ProjectManifest;
  payload: ProjectPayload;
  /** The decompressed image every reader in the library works on. */
  image: Uint8Array;
}

/**
 * Read a project file from disk.
 *
 * The manifest and payload come back with it because a command that writes a project out needs the
 * originals: the manifest carries the firmware version and the payload carries the 31-byte
 * container header, and neither is reconstructible from the image.
 */
export function readProjectFile(path: string): LoadedProjectFile {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));
  return { manifest, payload, image: decodeProjectImage(payload.raw).image };
}

/** Just the image, for the commands that only read. */
export function readProjectImage(path: string): Uint8Array {
  return readProjectFile(path).image;
}
