/**
 * Reading a whole instrument into a `.dnx`.
 *
 * The format itself, and everything about it that needs no instrument, is in `dnxfile.ts`. This is
 * the half that talks to a device.
 *
 * ## What a `.dnx` is
 *
 * A zip. Rename it and every file inside opens in DNX, in Elektron Transfer, or in anything that
 * reads a zip. That is deliberate: a backup format nobody but its author can open is a way of
 * losing music slowly, and this one degrades into a folder of ordinary `.dn2prj` files the moment
 * somebody needs it to.
 *
 * ```
 * manifest.json          what was read, from which instrument, and where each file belongs
 * projects/01 PRESETS.dn2prj
 * projects/02 COREVAULT.dn2prj
 * ...
 * ```
 *
 * ## The manifest is what makes a restore possible
 *
 * A `.dn2prj` does not know which slot it came from. The device addresses projects by index and
 * `/projects/PRESETS` is refused, so a folder of files alone cannot be put back. `manifest.json`
 * carries the slot for each entry, plus the instrument and firmware it came off, so a restore can
 * say what it is about to overwrite and refuse a backup taken from a different machine.
 *
 * ## Stored form, and why a raw backup is not a backup
 *
 * Every read here asks for `STORED_FORM`. The device answers the same path two ways: the stored
 * payload, or the expanded image. **Only the stored form can be written back** — `refuseRawForm`
 * rejects the other at the door.
 *
 * This is not a precaution against a hypothetical. The first overwrite run on hardware, 2026-08-15,
 * backed up a slot in raw form: 12.9 MB, no container header, saved under a `.dn2prj` name it had
 * no right to, and unwritable by the very function that produced it.
 *
 * It is also the difference between a backup that takes minutes and one that takes an hour. A DN2
 * project is **12,889,647 bytes raw and about 90 KB stored**, 6,294 chunks against roughly 40.
 *
 * ## Empty slots are skipped, and that is load-bearing
 *
 * A +Drive has 128 project slots. The instrument this was built against uses 18. Reading all 128
 * would spend most of an hour on slots holding nothing.
 *
 * ## What a whole instrument turned out to be
 *
 * The +Drive root holds **three** directories, not the two `device-storage.md` recorded:
 *
 * ```
 * /projects            128 slots
 * /soundbanks/A..H     256 sounds per bank    2,048
 * /kits/A..H           128 kits per bank      1,024
 * ```
 *
 * Sounds and kits open the same way projects do, by index under their bank: `/soundbanks/A/1`
 * reads in two chunks, `/kits/A/1` in three. Measured on a Digitone II, 2026-09-07. That was the
 * open question, and `0x54` did not freeze anything.
 *
 * **Unnamed entries are skipped**, the same rule projects use. A listing gives a name for anything
 * that exists, so an empty one costs nothing to leave out.
 */

import { STORED_FORM, wholeListing } from "../../src/device/storage.js";
import { fileLengthFromHead } from "../../src/project/container.js";
import { readStoredFile } from "../../src/device/storagesession.js";
import type { DriveProject } from "../../src/device/drive.js";
import { projectPath } from "./driveslot.js";
import { listRequest, parseListing } from "../../src/device/storage.js";
import type { ApiTransport } from "../../src/device/storagesession.js";
import { apiTransport, listDeviceProjects, type ConnectedDevice } from "./devicesource.js";
import { IDS_FOR, reserveMessageIds } from "./messageids.js";
import { extensionsFor } from "./objectextensions.js";
import {
  DNX_VERSION, projectFile, type BackupEntry, type DeviceBackup,
} from "./dnxfile.js";

export class BackupError extends Error {}

/** How a slot read reports itself while it runs. */
/** One kind of thing, and how far through it the read has got. */
export interface BackupStage {
  /** `projects`, `soundbanks` or `kits`. */
  kind: string;
  done: number;
  total: number;
  state: "pending" | "reading" | "done";
}

export interface BackupProgress {
  /** Items finished, out of `total`. Both are known before the first read. */
  done: number;
  total: number;
  /** What is being read now. */
  name: string;
  /** `projects`, `soundbanks` or `kits`, so a caller can say which stage it is in. */
  kind: string;
  /** Bytes of the current item so far. Reported for projects, which are the slow ones. */
  bytes: number;
  /**
   * Every kind, in read order, each with its own count.
   *
   * **One bar cannot say what a backup is doing.** 1,835 sounds and 18 projects share a total, so a
   * bar at 40% is somewhere in the sounds and gives no clue which parts are safely read. A row per
   * kind says that at a glance, and says which is still pending.
   */
  stages: BackupStage[];
}

export interface BackupOptions {
  /** Which slots to read. Omitted means every occupied one. */
  slots?: readonly number[];
  /**
   * What to read. Omitted means everything the instrument holds.
   *
   * Sounds and kits are 3,072 small reads against 18 large ones, so a person who wants their
   * projects back in under a minute can ask for those alone.
   */
  kinds?: readonly string[];
  onProgress?: (progress: BackupProgress) => void;
  /** Called once, before the listing, which takes a moment and looks like nothing happening. */
  onList?: () => void;
  /** Cooperative cancellation, checked between slots rather than mid-file. */
  shouldStop?: () => boolean;
}

/** A file name that survives a zip, a file system and a round trip through either. */
function safeName(slot: number, name: string, extension: string): string {
  const trimmed = name.replace(/[^ -~]/g, "").replace(/[\/:*?"<>|]/g, "-").trim();
  // The slot leads, because it is what addresses the project and what the instrument's own screen
  // shows. Two projects on one +Drive may share a name; two cannot share a slot.
  return `projects/${String(slot).padStart(3, "0")} ${trimmed || "UNNAMED"}${extension}`;
}

/** The banks a soundbank or kit directory holds, and what is in each. */
const BANKS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/** One readable thing on the +Drive, wherever it lives. */
interface DriveItem {
  path: string;
  file: string;
  name: string;
  slot: number;
  /** `projects`, `soundbanks` or `kits`. Decides whether the bytes need wrapping. */
  kind: string;
}

/** List a directory, keeping only the entries that hold something. */
async function listNamed(
  transport: ApiTransport, path: string,
): Promise<{ index: number; name: string }[]> {
  const id = reserveMessageIds(IDS_FOR.oneMessage);
  const reply = await transport.request(listRequest(id, path), id, 10_000);
  return wholeListing(reply, path).entries
    .filter((entry) => entry.name.trim().length > 0)
    .map((entry) => ({ index: entry.index, name: entry.name }));
}

/**
 * The directories this +Drive actually has, by name.
 *
 * A Digitone II root holds `projects`, `soundbanks` and `kits`. A **Digitone 1 holds the first two
 * and answers `Invalid path` for `/kits`** — measured 2026-09-07, where it took the whole backup
 * down with it. Every project and every sound had already been listed; the run ended with nothing
 * saved because one directory the instrument never had was asked for anyway.
 *
 * Asking the root costs one message, and it is also right for a firmware that adds a fourth
 * directory. Deciding from the product id would not be.
 */
async function driveKinds(transport: ApiTransport): Promise<Set<string>> {
  return new Set((await listNamed(transport, "/")).map((entry) => entry.name));
}

/**
 * Everything on the +Drive worth reading, in the order it will be read.
 *
 * Projects first, because they are the thing somebody is most afraid of losing and a backup that
 * is interrupted should have them. Sounds and kits follow.
 */
async function everything(
  transport: ApiTransport, kinds: readonly string[], sound: string,
): Promise<{ items: DriveItem[]; contents: string[] }> {
  const items: DriveItem[] = [];
  const contents: string[] = [];
  const present = await driveKinds(transport);

  if (kinds.includes("soundbanks") && present.has("soundbanks")) {
    let any = false;
    for (const bank of BANKS) {
      for (const entry of await listNamed(transport, `/soundbanks/${bank}`)) {
        any = true;
        items.push({
          path: `/soundbanks/${bank}/${entry.index}`,
          file: `soundbanks/${bank}/${String(entry.index).padStart(3, "0")} ${safeLeaf(entry.name)}${sound}`,
          name: entry.name,
          slot: entry.index,
          kind: "soundbanks",
        });
      }
    }
    if (any) contents.push("soundbanks");
  }

  if (kinds.includes("kits") && present.has("kits")) {
    let any = false;
    for (const bank of BANKS) {
      for (const entry of await listNamed(transport, `/kits/${bank}`)) {
        any = true;
        items.push({
          path: `/kits/${bank}/${entry.index}`,
          // Only a Digitone II has kits, so this one extension is not the instrument's to choose.
          file: `kits/${bank}/${String(entry.index).padStart(3, "0")} ${safeLeaf(entry.name)}.dn2kit`,
          name: entry.name,
          slot: entry.index,
          kind: "kits",
        });
      }
    }
    if (any) contents.push("kits");
  }

  return { items, contents };
}

/** A single path segment a file system will accept. */
function safeLeaf(name: string): string {
  return name.replace(/[^ -~]/g, "").replace(/[\/:*?"<>|]/g, "-").trim() || "UNNAMED";
}

/**
 * Read every occupied project slot off an instrument.
 *
 * Slots that fail are **reported and skipped**, never silently dropped: a backup missing one
 * project is worth having, and a backup that quietly lost one is not.
 */
export async function backupDevice(
  device: ConnectedDevice,
  options: BackupOptions = {},
): Promise<{ backup: DeviceBackup; failed: { slot: number; name: string; why: string }[] }> {
  const kinds = options.kinds ?? ["projects", "soundbanks", "kits"];
  const transport = apiTransport(device);
  // A backup's file names are the only thing saying which instrument the bytes came off once the
  // zip is open somewhere else.
  const extension = extensionsFor(device.productId);

  /*
   * **Everything is listed before anything is read.** A progress bar needs a denominator, and one
   * that arrives after the projects are done would jump from "18 of 18" to "18 of 1,869" halfway
   * through. Listing costs 17 messages against 1,869 reads, so knowing the total up front is
   * effectively free.
   */
  options.onList?.();
  const listed = await listDeviceProjects(device);
  const occupied = listed.filter((p) => p.name.trim().length > 0);
  const chosen = options.slots
    ? occupied.filter((p) => options.slots!.includes(p.index))
    : occupied;

  const items: DriveItem[] = [];
  const contents: string[] = [];

  /*
   * Projects lead. A backup interrupted halfway should hold the thing somebody is most afraid of
   * losing, and 3,072 small reads take longer than 18 large ones.
   */
  if (kinds.includes("projects") && chosen.length > 0) {
    contents.push("projects");
    for (const project of chosen) {
      items.push({
        path: projectPath(project.index),
        file: safeName(project.index, project.name, extension.project),
        name: project.name,
        slot: project.index,
        kind: "projects",
      });
    }
  }

  const rest = await everything(transport, kinds, extension.sound);
  items.push(...rest.items);
  contents.push(...rest.contents);

  if (items.length === 0) {
    throw new BackupError(
      listed.length === 0
        ? "The +Drive listing came back empty, so there is nothing to back up."
        : "Everything on this +Drive is empty. There is nothing to back up.",
    );
  }

  const files: { path: string; bytes: Uint8Array }[] = [];
  const entries: BackupEntry[] = [];
  const failed: { slot: number; name: string; why: string }[] = [];
  const total = items.length;

  /*
   * Counted per kind as well as overall. The totals come from the listing, so every row is complete
   * before the first read and a pending kind shows its size rather than a blank.
   */
  const stages: BackupStage[] = contents.map((kind) => ({
    kind,
    done: 0,
    total: items.filter((i) => i.kind === kind).length,
    state: "pending" as const,
  }));
  const stageOf = (kind: string): BackupStage | undefined => stages.find((g) => g.kind === kind);
  const snapshot = (): BackupStage[] => stages.map((g) => ({ ...g }));

  for (const [at, item] of items.entries()) {
    if (options.shouldStop?.()) break;
    const stage = stageOf(item.kind);
    if (stage) stage.state = "reading";
    options.onProgress?.({
      done: at, total, name: item.name, kind: item.kind, bytes: 0, stages: snapshot(),
    });

    try {
      const read = await readStoredFile(item.path, {
        transport,
        // The whole reason this is a minute rather than an hour, and the only form a write accepts.
        form: STORED_FORM,
        msgId: reserveMessageIds(IDS_FOR.wholeProject),
        totalFromHead: fileLengthFromHead,
        ...(item.kind === "projects"
          ? {
              onProgress: (_chunks: number, bytes: number) => {
                options.onProgress?.({
                  done: at, total, name: item.name, kind: item.kind, bytes, stages: snapshot(),
                });
              },
            }
          : {}),
      });

      /*
       * **A project is wrapped into a real project file; a sound and a kit are already objects.**
       *
       * The device sends a project as a payload, and a `.dn2prj` — or a `.dnprj` off a Digitone 1 —
       * is that payload inside a container. The first backup written here saved payloads under a `.dn2prj` name and not one
       * of the eighteen files parsed. Sounds and kits arrive carrying the Elektron object magic
       * already, so they are written through untouched.
       *
       * Wrapping needs the instrument's firmware, which it may not have answered. With no firmware
       * there is nothing honest to put in the container, so the payload keeps a name that does not
       * claim to be a project file.
       */
      const wrap = item.kind === "projects" ? device.firmwareVersion : undefined;
      const file = item.kind === "projects" && !wrap
        ? safeName(item.slot, item.name, ".payload")
        : item.file;
      const bytes = wrap ? await projectFile(item.name, wrap, read.bytes) : read.bytes;

      files.push({ path: file, bytes });
      entries.push({ file, source: item.path, slot: item.slot, name: item.name, bytes: bytes.length });
    } catch (error) {
      failed.push({ slot: item.slot, name: item.name, why: String(error) });
    }

    /*
     * The count moves whether the read succeeded or failed, because it is a count of what has been
     * attempted. A row that stalls on a failure would say the backup had stopped when it had not.
     */
    if (stage) {
      stage.done++;
      if (stage.done >= stage.total) stage.state = "done";
    }
  }

  for (const stage of stages) if (stage.done >= stage.total) stage.state = "done";
  options.onProgress?.({
    done: entries.length, total, name: "", kind: "", bytes: 0, stages: snapshot(),
  });

  return {
    backup: {
      manifest: {
        dnx: DNX_VERSION,
        taken: new Date().toISOString(),
        device: {
          name: device.name,
          productId: device.productId,
          ...(device.firmwareVersion === undefined ? {} : { firmwareVersion: device.firmwareVersion }),
        },
        contents,
        form: "stored",
        entries,
      },
      files,
    },
    failed,
  };
}
