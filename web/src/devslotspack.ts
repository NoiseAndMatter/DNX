/**
 * The diagnostics zip: each file as the unit sent it, and a manifest that says what each one is.
 *
 * DOM-free, so a test can open what it builds. The capture that feeds it is
 * `devslotscapture.ts`.
 */

import {
  type CapturedFile,
  captureEntryName,
  captureFileName,
} from "@noiseandmatter/dnx-core/device/devslots.js";
import { MODINFO_PATH, type ModInfo, readModInfoFile } from "@noiseandmatter/dnx-core/waverider/modinfo.js";
import { buildZip } from "./zip.js";
import { DNX_BUILD } from "./version.js";

export interface CaptureManifest {
  dnx: string;
  taken: string;
  mode: "capture" | "blocks";
  instrument: { name: string; os: string | null };
  modinfo: { buildTag: string; imageId: string; os: string; commit: string } | { error: string };
  files: { path: string; entry: string; bytes: number; sha256: string; ms: number; closed: boolean }[];
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The zip: each file under its entry name, then the manifest. Exported for the test. */
export async function packCapture(
  files: readonly CapturedFile[],
  device: { name: string; firmwareVersion?: string },
  mode: CaptureManifest["mode"],
  taken: Date,
): Promise<{ name: string; bytes: Uint8Array; manifest: CaptureManifest }> {
  const record = files.find((f) => f.path === MODINFO_PATH);
  let info: ModInfo | undefined;
  let infoError = "not read";
  try {
    if (record) info = readModInfoFile(record.bytes);
  } catch (error) {
    // A website build ships an unfilled record. The raw file is still in the zip.
    infoError = error instanceof Error ? error.message : String(error);
  }

  const manifest: CaptureManifest = {
    dnx: DNX_BUILD,
    taken: taken.toISOString(),
    mode,
    instrument: { name: device.name, os: device.firmwareVersion ?? null },
    modinfo: info
      ? {
          buildTag: info.buildTag,
          imageId: `0x${info.imageId.toString(16).padStart(8, "0")}`,
          os: info.os,
          commit: info.commit,
        }
      : { error: infoError },
    files: await Promise.all(files.map(async (f) => ({
      path: f.path,
      entry: captureEntryName(f.path),
      bytes: f.bytes.length,
      sha256: await sha256(f.bytes),
      ms: Math.round(f.ms),
      closed: f.closed,
    }))),
  };

  const bytes = await buildZip([
    ...files.map((f) => ({ name: captureEntryName(f.path), data: f.bytes })),
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") },
  ]);
  return { name: captureFileName(taken, info?.imageId, mode === "blocks"), bytes, manifest };
}
