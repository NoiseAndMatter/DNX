/**
 * Opening and saving projects in the browser.
 *
 * The only thing this adds over the library is the ZIP layer; everything past the payload
 * bytes — the container header, the LZ4 chain, the check field — is the same code the CLI
 * runs, so a project opened here is parsed exactly as it is on the command line.
 */

import { parsePayload, type ProjectManifest, type ProjectPayload } from "../../src/project/container.js";
import { decodeProjectImage } from "../../src/project/dn2codec.js";
import { buildPayload } from "../../src/project/write.js";
import { buildZip, readZip } from "./zip.js";

export interface LoadedProject {
  fileName: string;
  manifest: ProjectManifest;
  payload: ProjectPayload;
  /** The decompressed image every reader in the library works on. */
  image: Uint8Array;
}

export class ProjectLoadError extends Error {}

/** Read a `.dnprj` / `.dn2prj` the user picked. */
export async function openProject(file: File): Promise<LoadedProject> {
  const entries = await readZip(new Uint8Array(await file.arrayBuffer()));

  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new ProjectLoadError(`${file.name}: no manifest.json — not a project file`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ProjectManifest;

  const payloadBytes = entries.get(manifest.Payload);
  if (!payloadBytes) throw new ProjectLoadError(`${file.name}: manifest names a payload "${manifest.Payload}" the ZIP does not contain`);

  const payload = parsePayload(payloadBytes);
  return { fileName: file.name, manifest, payload, image: decodeProjectImage(payload.raw).image };
}

/**
 * Build a project file from a converted image.
 *
 * The manifest and source payload come from the **template**, because the output is a DN2
 * file and must carry the DN2's firmware version, payload entry name and device signature.
 */
export async function buildProjectBlob(template: LoadedProject, image: Uint8Array): Promise<Blob> {
  const file = await buildZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(template.manifest, null, 2)) },
    { name: template.manifest.Payload, data: buildPayload(template.payload.raw, image) },
  ]);
  return new Blob([file as BlobPart], { type: "application/octet-stream" });
}

/** Hand a built file to the browser as a download. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
