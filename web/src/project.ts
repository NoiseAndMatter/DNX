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
import { saveBlob } from "./dom.js";

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
  return readProject(file.name, new Uint8Array(await file.arrayBuffer()));
}

async function readProject(fileName: string, bytes: Uint8Array): Promise<LoadedProject> {
  const entries = await readZip(bytes);

  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new ProjectLoadError(`${fileName}: no manifest.json — not a project file`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ProjectManifest;

  const payloadBytes = entries.get(manifest.Payload);
  if (!payloadBytes) throw new ProjectLoadError(`${fileName}: manifest names a payload "${manifest.Payload}" the ZIP does not contain`);

  const payload = parsePayload(payloadBytes);
  return { fileName, manifest, payload, image: decodeProjectImage(payload.raw).image };
}

/**
 * Ask the local server for a template, if there is a local server.
 *
 * `npm run web` is the CLI, so it can find `EMPTY.dn2prj` the same way every other command
 * does and hand it over — which spares picking the same blank project by hand every session.
 * Deployed as static files there is no such endpoint, the fetch 404s, and the caller falls
 * back to the file picker. Returns `undefined` for **every** failure rather than throwing:
 * not having a template here is the normal case, not an error.
 */
export async function fetchServedTemplate(): Promise<LoadedProject | undefined> {
  try {
    const response = await fetch("template.dn2prj", { cache: "no-store" });
    if (!response.ok) return undefined;
    const name = response.headers.get("x-template-name") ?? "template.dn2prj";
    return await readProject(name, new Uint8Array(await response.arrayBuffer()));
  } catch {
    // Offline, opened over file://, or served by something that is not our server.
    return undefined;
  }
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

/**
 * Hand a built file to the browser as a download.
 *
 * Kept as a name the expander already uses, delegating to the shared helper rather than repeating
 * the object-URL dance a third time.
 */
export const download = saveBlob;
