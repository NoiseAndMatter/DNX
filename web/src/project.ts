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
  return readProjectFile(file.name, new Uint8Array(await file.arrayBuffer()));
}

/** Read project bytes from anywhere — a picked file, the server, or the embedded blank. */
export async function readProjectFile(fileName: string, bytes: Uint8Array): Promise<LoadedProject> {
  // Named here rather than left to the ZIP layer. `readZip` does not know what it is reading, so
  // its "not a project file" arrived without saying *which* file — and the one caller who most
  // needs that is the donor chain, which has three candidates and has to report the one that broke.
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(bytes);
  } catch (error) {
    throw new ProjectLoadError(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }

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
 * back. `undefined` means **there is no template here**, which is the normal case rather than
 * an error.
 *
 * **It does not mean the template could not be read.** Those are different problems and the
 * catch used to cover both: a template that was present but unparseable came back as absent,
 * so the page told the user to go and find a file that was already sitting on the server. So
 * the swallow stops at the network, and a broken template throws — with its own name on it.
 */
export async function fetchServedTemplate(): Promise<LoadedProject | undefined> {
  let name: string;
  let bytes: Uint8Array;
  try {
    const response = await fetch("template.dn2prj", { cache: "no-store" });
    if (!response.ok) return undefined;
    name = response.headers.get("x-template-name") ?? "template.dn2prj";
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    // Offline, opened over file://, or served by something that is not our server.
    return undefined;
  }
  return await readProjectFile(name, bytes);
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
