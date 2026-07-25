/**
 * Reading a project FILE: the ZIP wrapper around the payload.
 *
 * Split from `container.ts` because ZIP decompression is the one part of reading a project
 * that needs a platform: `node:zlib` here, `DecompressionStream` in a browser. Everything
 * past the payload bytes — the container header, the LZ4 chain, the check field — is pure and
 * stays in `container.ts`, so both platforms share it.
 *
 * If you are looking for the payload format itself, it is next door.
 */

import { inflateRawSync } from "node:zlib";
import {
  ProjectParseError,
  parsePayload,
  type Project,
  type ProjectManifest,
} from "./container.js";
import { buildPayload } from "./write.js";
import { buildZip } from "./zip.js";

function readZipEntries(data: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;

  while (at + 30 <= data.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    let compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const nameStart = at + 30;
    const name = new TextDecoder().decode(data.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;

    if (compressedSize === 0 && (view.getUint16(at + 6, true) & 0x08) !== 0) {
      throw new ProjectParseError(
        `ZIP entry "${name}" uses a streaming data descriptor, which this reader does not support`,
      );
    }

    const chunk = data.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, chunk);
    else if (method === 8) entries.set(name, new Uint8Array(inflateRawSync(chunk)));
    else throw new ProjectParseError(`ZIP entry "${name}" uses unsupported method ${method}`);

    at = dataStart + compressedSize;
  }

  if (entries.size === 0) throw new ProjectParseError("No ZIP entries found — not a project file");
  return entries;
}

/** Parse a complete .dnprj / .dn2prj file. */
export function parseProject(file: Uint8Array): Project {
  const entries = readZipEntries(file);

  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new ProjectParseError("Project ZIP has no manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ProjectManifest;

  const payloadBytes = entries.get(manifest.Payload);
  if (!payloadBytes) {
    throw new ProjectParseError(
      `manifest names payload "${manifest.Payload}" but the ZIP has: ${[...entries.keys()].join(", ")}`,
    );
  }

  return { manifest, payload: parsePayload(payloadBytes) };
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
  return buildZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    { name: manifest.Payload, data: buildPayload(sourcePayload, image) },
  ]);
}
