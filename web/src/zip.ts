/**
 * The ZIP codec a browser has, handed to the container in `src/archive/zip.ts`.
 *
 * `node:zlib` is unavailable here. The web platform offers `DecompressionStream` and
 * `CompressionStream` instead, which are asynchronous — so rather than making the library async
 * for everyone, this side is async and the library's is not. Both reach the same container code,
 * and `test/archive.test.ts` holds them to the same bytes field for field.
 *
 * That leaves the hardware-validated write path in `src/project/write.ts` untouched. Both sides
 * produce ordinary method-8 entries; only the code that gets them there differs.
 */

import {
  buildZipAsync,
  readZipAsync,
  type ZipEntry,
} from "@noiseandmatter/dnx-core/archive/zip.js";

export { ZipError, crc32, type ZipEntry } from "@noiseandmatter/dnx-core/archive/zip.js";

async function through(data: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  // The DOM lib types these streams as BufferSource-in / Uint8Array-out, which pipeThrough
  // cannot express; the cast is to the shape the runtime actually provides.
  const piped = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** Build a ZIP with one deflated entry per input, in the order given. */
export function buildZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  return buildZipAsync(entries, (data) => through(data, new CompressionStream("deflate-raw")));
}

/** Read every entry of a ZIP, decompressing what needs it. */
export function readZip(file: Uint8Array): Promise<Map<string, Uint8Array>> {
  return readZipAsync(file, (data) => through(data, new DecompressionStream("deflate-raw")));
}
