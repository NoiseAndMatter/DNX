/**
 * Reading and writing a project FILE on the command line: the ZIP around the payload.
 *
 * Both halves are elsewhere and this is the join. `src/project/projectfile.ts` knows what a
 * project file holds — the manifest and the payload it names — and `src/archive/zip.ts` knows the
 * ZIP container. Neither can compress, which is the one part that needs a platform, so this
 * supplies Node's codec through `./zip.js` and nothing more.
 *
 * If you are looking for the payload format itself, it is in `project/container.ts`.
 *
 * ## Why this is in `src/node/`
 *
 * Everything else under `src/` is platform-free and shared byte for byte with the browser. This is
 * not: it reaches `node:zlib` through `./zip.js`. That used to be expressed as a filename in
 * `tsconfig.web.json`'s exclude list, which is a boundary somebody has to remember — and forgetting
 * would drag Node into the browser bundle, where it fails at page load with an unhelpful error.
 *
 * The directory *is* the boundary now. `tsconfig.web.json` excludes `src/node/**`, and
 * `test/web.test.ts` fails if anything outside `src/node/` or `src/cli/` imports a `node:` module.
 */

import { ZipError } from "@noiseandmatter/dnx-core/archive/zip.js";
import { ProjectParseError, type Project, type ProjectManifest } from "@noiseandmatter/dnx-core/project/container.js";
import { projectFrom, rebuiltProjectEntries } from "@noiseandmatter/dnx-core/project/projectfile.js";
import { buildZip, readZip } from "./zip.js";

/** Parse a complete .dnprj / .dn2prj file. */
export function parseProject(file: Uint8Array): Project {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readZip(file);
  } catch (error) {
    // Every reader on this side has always met one error type for a file that is not a project,
    // and the CLI reports it by that name. A `ZipError` reaching a caller that catches
    // `ProjectParseError` would read as an unhandled crash over a file somebody simply picked
    // wrongly, so the container's complaint is carried through under the type this side promises.
    if (error instanceof ZipError) throw new ProjectParseError(error.message);
    throw error;
  }
  return projectFrom(entries);
}

/**
 * Build a complete .dnprj / .dn2prj file from a modified image.
 *
 * Takes the manifest and source payload from the project the image came from, so the
 * container header, payload entry name and firmware version all carry over unchanged.
 */
export function buildProjectFile(
  manifest: ProjectManifest,
  sourcePayload: Uint8Array,
  image: Uint8Array,
): Uint8Array {
  return buildZip(rebuiltProjectEntries(manifest, sourcePayload, image));
}
