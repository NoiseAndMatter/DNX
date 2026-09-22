/**
 * What a `.dnprj` / `.dn2prj` holds, either side of the ZIP.
 *
 * A project file is a ZIP with exactly two entries: `manifest.json`, and the binary payload named
 * by `manifest.Payload`. This module owns that pairing in both directions — the entries a project
 * file is built from, and the project read back out of them — and knows nothing about how the ZIP
 * is compressed. `archive/zip.ts` takes the codec; the hosts supply it.
 *
 * The payload format itself is `container.ts`, and the manifest fields belong to `manifestFor` in
 * `device/drive.ts`, which derives them from the payload rather than inventing them. Neither is
 * repeated here.
 *
 * ## Why the entries are a value rather than a file
 *
 * Three callers write project files and each has its own ZIP writer: the CLI through
 * `node/projectfile.ts`, the expander through `web/project.ts`, and the backup through
 * `web/dnxfile.ts`, which puts them inside a second ZIP. What they share is the two entries and
 * nothing else, so that is what these functions return. The caller zips them with the codec its
 * host has.
 *
 * `dnxfile.ts` rebuilt the manifest by hand until it was made to call `manifestFor`; returning
 * the entries rather than the file is what stops the next caller doing the same again.
 */

import { manifestFor } from "../device/drive.js";
import type { ZipEntry } from "../archive/zip.js";
import {
  ProjectParseError,
  parsePayload,
  type Project,
  type ProjectManifest,
} from "./container.js";
import { buildPayload } from "./write.js";

/** The name of the entry every project file carries first. */
export const MANIFEST_ENTRY = "manifest.json";

/**
 * The two entries a project file holds, in the order it holds them.
 *
 * Two-space indented JSON, which is what every file in the corpus carries and what Transfer
 * writes. The manifest goes first so a reader meets it before the megabytes.
 */
export function projectEntries(manifest: ProjectManifest, payload: Uint8Array): ZipEntry[] {
  return [
    { name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(manifest, undefined, 2)) },
    { name: manifest.Payload, data: payload },
  ];
}

/**
 * The entries for a project file rebuilt around a modified image.
 *
 * The manifest and source payload come from the project the image came from, so the container
 * header, the payload entry name and the firmware version all carry over unchanged.
 */
export function rebuiltProjectEntries(
  manifest: ProjectManifest,
  sourcePayload: Uint8Array,
  image: Uint8Array,
): ZipEntry[] {
  return projectEntries(manifest, buildPayload(sourcePayload, image));
}

/**
 * The entries for a project file wrapped around a payload read off an instrument.
 *
 * **The device sends a payload, not a file.** The +Drive read returns the second entry alone, and
 * a backup that saved it under a `.dn2prj` name would be a file nothing can open. The manifest is
 * reconstructed by `manifestFor` from fields that are either read off the instrument or constant
 * across every project in the corpus; `firmwareVersion` is required because a caller whose device
 * did not answer has nothing honest to write there.
 */
export function storedProjectEntries(
  name: string,
  firmwareVersion: string,
  payload: Uint8Array,
): ZipEntry[] {
  return projectEntries(manifestFor(parsePayload(payload), name, firmwareVersion), payload);
}

/**
 * The project inside a ZIP that has already been read.
 *
 * Takes entries rather than a file because decompression is the one part that needs a host. Every
 * refusal names what is missing and, for a payload the manifest points at and the ZIP does not,
 * what the ZIP holds instead — the case that happens when a file has been repacked by hand.
 */
export function projectFrom(entries: Map<string, Uint8Array>): Project {
  const manifestBytes = entries.get(MANIFEST_ENTRY);
  if (!manifestBytes) throw new ProjectParseError(`Project ZIP has no ${MANIFEST_ENTRY}`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ProjectManifest;

  const payloadBytes = entries.get(manifest.Payload);
  if (!payloadBytes) {
    throw new ProjectParseError(
      `manifest names payload "${manifest.Payload}" but the ZIP has: ${[...entries.keys()].join(", ")}`,
    );
  }

  return { manifest, payload: parsePayload(payloadBytes) };
}
