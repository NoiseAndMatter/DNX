/**
 * The ZIP codec Node has, handed to the container in `src/archive/zip.ts`.
 *
 * `node:zlib` is synchronous, so the library's readers and writers stay synchronous and the forty
 * call sites that parse a project file on the command line are unchanged. The browser's codec is
 * asynchronous and lives in `web/src/zip.ts`; both reach the same container code, and
 * `test/archive.test.ts` holds them to the same bytes field for field.
 *
 * ## Why this is in `src/node/`
 *
 * Everything else under `src/` is platform-free and shared byte for byte with the browser. This is
 * not: it imports `node:zlib`. That used to be expressed as a filename in `tsconfig.web.json`'s
 * exclude list, which is a boundary somebody has to remember — and forgetting would drag Node into
 * the browser bundle, where it fails at page load with an unhelpful error.
 *
 * The directory *is* the boundary now. `tsconfig.web.json` excludes `src/node/**`, and
 * `test/web.test.ts` fails if anything outside `src/node/` or `src/cli/` imports a `node:` module.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { buildZip as buildZipWith, readZip as readZipWith, type ZipEntry } from "../archive/zip.js";

export { ZipError, crc32, type ZipEntry } from "../archive/zip.js";

/** Build a ZIP with one deflated entry per input, in the order given. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  return buildZipWith(entries, (data) => new Uint8Array(deflateRawSync(data)));
}

/** Read every entry of a ZIP, decompressing what needs it. */
export function readZip(file: Uint8Array): Map<string, Uint8Array> {
  return readZipWith(file, (data) => new Uint8Array(inflateRawSync(data)));
}
