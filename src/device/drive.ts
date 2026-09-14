/**
 * The +Drive as a project library: list what is stored, open any of it by slot.
 *
 * ## What this changes
 *
 * Every device-sourced read before this one worked on **the project that happens to be open**.
 * `0x6f` streams the active project; the 257-request plan reads the active project one record at a
 * time. Neither can reach slot 47 while slot 3 is loaded, and neither gets the whole file — a
 * dump-based rebuild borrows about 0.49% from a donor because the header, the pre-pool tail and the
 * song table never come over the wire.
 *
 * This reads **the stored file**. All of it, by index, without touching what the musician has open.
 * That is what "choose a source project and a target project from the device" needs, and it is the
 * last piece the two-device expander was waiting on.
 *
 * ## The bytes are the payload, not the `.dnprj`
 *
 * A project file is a ZIP holding `manifest.json` and one binary member. The +Drive hands over
 * **the binary member alone** — no ZIP, no manifest — which is the more useful half: `parsePayload`
 * takes it directly, and the unzip step disappears rather than moving.
 *
 * Verified on hardware, 2026-07-30: `/projects/1` returned 2,781,743 bytes, which is the DN1's
 * 31-byte payload header, its 2,781,700-byte image and a 12-byte trailer. `parsePayload` accepted
 * it unchanged — check field valid, stored length matching computed, 641 objects.
 *
 * The manifest is **reconstructed** rather than invented; see `manifestFor`.
 *
 * ## Stateless, like everything else in this layer
 *
 * A transport goes in, bytes come out. Two instruments have to be held at once — the whole point of
 * the expander — so nothing here may assume there is one device.
 */

import {
  type Project,
  type ProjectManifest,
  type ProjectPayload,
  fileLengthFromHead,
  parsePayload,
} from "../project/container.js";
import { type ApiTransport, type StoredFile, readStoredFile } from "./storagesession.js";
import { type Entry, ListingError, listRequest, StorageCode, wholeListing } from "./storage.js";
import { RESPONSE_BIT } from "./api.js";
import { DN1_LAYOUT, DN2_LAYOUT } from "../project/dn2image.js";

/** Where projects live. There are no folders — the +Drive is two flat lists. */
export const PROJECTS = "/projects";

/** One slot in the device's project list. */
export interface DriveProject {
  /**
   * The slot number, **1-based**, and the thing `openRequest` addresses.
   *
   * Not a display detail: `/projects/1` opens and `/projects/PRESETS` does not. The device turns
   * the last path segment into a number, and answers `invalid project id` when it cannot.
   */
  index: number;
  name: string;
  /** The slot's allocation — a flat 4 MiB on every project, **not** the file's size. */
  allocated: number;
}

export interface DriveOptions {
  /** First message id. A read consumes one per chunk, so give each call its own band. */
  msgId?: number;
  timeoutMs?: number;
  onProgress?: (chunks: number, bytes: number, total?: number) => void;
}

/**
 * Every project on the device, in slot order.
 *
 * Asks for the whole directory in one request rather than paging. A bare path returns all 128
 * entries — confirmed on hardware — and paging exists for callers who want a window, not because
 * the device needs coaxing.
 */
export async function listProjects(
  transport: ApiTransport,
  options: DriveOptions = {},
): Promise<DriveProject[]> {
  const msgId = options.msgId ?? 1;
  const reply = expect(
    await transport.request(listRequest(msgId, PROJECTS), msgId, options.timeoutMs ?? 5_000),
    StorageCode.List,
  );

  return wholeListing(reply, PROJECTS)
    .entries
    .filter((e) => e.kind === "file")
    .map(toProject)
    .sort((a, b) => a.index - b.index);
}

function toProject(entry: Entry): DriveProject {
  return { index: entry.index, name: entry.name, allocated: entry.size ?? 0 };
}

export interface DriveRead extends StoredFile {
  /** The payload parsed by the same code that reads a `.dnprj`. */
  payload: ProjectPayload;
}

/**
 * Read one project off the +Drive by slot.
 *
 * The payload is parsed here rather than handed back raw, because parsing is the check: a truncated
 * or misassembled read fails `parsePayload`'s length and check-field comparison, and it fails
 * **now**, next to the transfer that caused it, rather than three operations later in an editor.
 */
export async function readDriveProject(
  transport: ApiTransport,
  index: number,
  options: DriveOptions = {},
): Promise<DriveRead> {
  if (!Number.isInteger(index) || index < 1) {
    throw new ListingError(`project slot ${index} is not a 1-based index from a listing`);
  }

  const file = await readStoredFile(`${PROJECTS}/${index}`, {
    transport,
    msgId: options.msgId,
    timeoutMs: options.timeoutMs,
    onProgress: options.onProgress,
    // A project is an Elektron container, and its header declares how long it will be — so a read
    // that used to be able to report only "bytes so far" can report a percentage from the first
    // chunk. See `fileLengthFromHead`.
    totalFromHead: fileLengthFromHead,
  });

  return { ...file, payload: parsePayload(file.bytes) };
}

/**
 * Rebuild the `manifest.json` the +Drive does not send.
 *
 * **Reconstructed from evidence, not invented.** Every field is either read off the payload or read
 * off the device:
 *
 * | Field | Source |
 * |---|---|
 * | `FormatVersion` | `"1.0"` in every corpus manifest, both families |
 * | `ProductType` | `["24","30"]` on a DN1, empty on a DN2 — from the payload's `kind` |
 * | `Payload` | the project's name, which is also the ZIP entry name |
 * | `FileType` | `"Project"` |
 * | `FirmwareVersion` | the device's own `Version` reply |
 *
 * That last one is why this takes a version string rather than guessing: a manifest claiming the
 * wrong firmware is exactly the kind of plausible-but-wrong field this codebase keeps paying for,
 * and the device will tell you if asked.
 *
 * With it, a project read off the +Drive can be written back out as a real `.dnprj` — so
 * "downloaded from the device" and "opened from a file" converge on the same `Project`, and every
 * tool above this line works on both without knowing which it has.
 */
export function manifestFor(
  payload: ProjectPayload,
  name: string,
  firmwareVersion: string,
): ProjectManifest {
  return {
    FormatVersion: MANIFEST_FORMAT_VERSION,
    // Only the DN1 lists product types. Nine DN2 files in the corpus carry an empty array, so an
    // empty array is what a DN2 manifest says — copying the DN1's would be a guess that reads as a
    // fact.
    ProductType: payload.kind === DN1_KIND ? [...DN1_PRODUCT_TYPES] : [],
    Payload: name,
    FileType: "Project",
    FirmwareVersion: firmwareVersion,
  };
}

/** A device read, assembled into the same shape `parseProject` returns for a file. */
export function projectFor(read: DriveRead, name: string, firmwareVersion: string): Project {
  return { manifest: manifestFor(read.payload, name, firmwareVersion), payload: read.payload };
}

/**
 * The image inside a +Drive payload — **already uncompressed**.
 *
 * This is the difference between a stored file and a downloaded one, and it is not a small one.
 * A `.dnprj` holds the image **LZ4-compressed**: `001 PRESETS.dnprj` is a 77,832-byte payload that
 * expands to 2,781,700. The +Drive sends those 2,781,700 bytes **as they are**, wrapped in the same
 * 31-byte header and 12-byte trailer. So `decodeProjectImage` must not be pointed at this: it reads
 * the first `BEEFBACE` as an LZ4 block length and refuses, claiming a 3.2 GB block.
 *
 * Recognised by measurement rather than by origin: when the payload's own declared length equals
 * the image size for its family, the payload body **is** the image. A caller that had to remember
 * where its bytes came from would eventually forget.
 *
 * > **Proved, not assumed.** The image this returns for `/projects/1` is **byte-for-byte identical**
 * > to the image `decodeProjectImage` produces from `001 PRESETS.dnprj` — 2,781,700 bytes, zero
 * > differences, two entirely independent paths off the same instrument. `test/drive.test.ts`.
 */
export function imageFrom(payload: ProjectPayload): Uint8Array {
  const sizes = IMAGE_SIZES[payload.kind];
  if (sizes === undefined) {
    throw new ListingError(`payload kind ${payload.kind} is neither a Digitone 1 nor a Digitone II`);
  }
  const expected = payload.storedLength;
  if (!sizes.includes(expected)) {
    // Two causes, and the old message knew one. Until OS 1.11 appended 512 bytes, every image of a
    // family had one size, so a mismatch could only have meant compressed bytes.
    throw new ListingError(
      `payload declares ${payload.storedLength} bytes, format ${payload.formatVersion}, and an ` +
        `uncompressed image of this family is ${sizes.join(" or ")} bytes. Either it is compressed, ` +
        `which a +Drive read never is, or it was written by a firmware this version of DNX does ` +
        `not know`,
    );
  }

  const image = payload.raw.subarray(PAYLOAD_HEADER, PAYLOAD_HEADER + expected);
  if (image.length !== expected) {
    throw new ListingError(`payload holds ${image.length} bytes of image, expected ${expected}`);
  }
  return image;
}

/** Bytes before the first object's magic. The image starts where `BEEFBACE` does. */
const PAYLOAD_HEADER = 31;


/** `kind` at payload offset 0x08 — the one byte that says which family a payload belongs to. */
const DN1_KIND = 9;
const DN2_KIND = 15;
const MANIFEST_FORMAT_VERSION = "1.0";
const DN1_PRODUCT_TYPES = ["24", "30"] as const;
const IMAGE_SIZES: Record<number, readonly number[]> = {
  [DN1_KIND]: DN1_LAYOUT.imageSizes,
  [DN2_KIND]: DN2_LAYOUT.imageSizes,
};

/** Refuse a reply that is not the one this request asked for. Same check the session makes. */
function expect(frame: { code: number; body: Uint8Array }, code: number): { body: Uint8Array } {
  if (frame.code !== (code | RESPONSE_BIT)) {
    throw new ListingError(
      `expected 0x${(code | RESPONSE_BIT).toString(16)} in reply to 0x${code.toString(16)}, ` +
        `got 0x${frame.code.toString(16)}`,
    );
  }
  return frame;
}

