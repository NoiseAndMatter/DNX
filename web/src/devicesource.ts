/**
 * A connected instrument as a project source for the manager, alongside files.
 *
 * The browser half of `src/device/deviceproject.ts`: everything here is MIDI plumbing and
 * permissions, and everything about *what a project is* lives in the library, which is why this
 * file is short and has no format knowledge in it at all.
 *
 * ## Files do not become the second-class option
 *
 * A device is a **source**, not a mode. What comes back is an ordinary image, so the session, the
 * undo history, the grid, every operation and the exporter all work on it unchanged — a project
 * read off a Digitone can be exported to a `.dn2prj` and one opened from disk can be written to a
 * device. That symmetry is the point, and it is free precisely because the library speaks images.
 *
 * ## The donor, and why the template is the right default
 *
 * A capture is 99.5% of a project (`ROADMAP` §3c-vi). The header, the song table and the slot array
 * never come over the wire, so an image needs a donor for them. The served template is the right
 * one: a device-authored blank contributes an **empty** song table rather than another project's.
 *
 * It matters less than it sounds, because `writeChangedRecords` only transmits records that
 * differ, and the donor-supplied regions are identical on both sides of that diff by construction.
 * The donor shapes what an **export** of a device-read project contains, not what goes back to the
 * instrument.
 */

import { type DeviceIo, readProjectFromDevice } from "../../src/device/deviceproject.js";
import {
  type BackupHook,
  type ConfirmHook,
  type RecordWriteReview,
  type SafeRecordWriteResult,
  type WriteStage,
  safeWriteRecords,
} from "../../src/device/safewrite.js";
import { requireWriteEnabled } from "./writeenable.js";
import {
  type DriveProject,
  imageFrom,
  listProjects,
  manifestFor,
  readDriveProject,
} from "../../src/device/drive.js";
import type { ProjectManifest, ProjectPayload } from "../../src/project/container.js";
import { type ApiTransport } from "../../src/device/storagesession.js";
import { DeviceLink, type PortPair, candidatePairs } from "./devicelink.js";
import { type DeviceChoice } from "./devicechoice.js";
import { type ConnectedDevice, DeviceSourceError, identify } from "../../src/device/identify.js";
import { PRODUCT_NAMES } from "../../src/sysex/devices.js";
import { layoutFor } from "../../src/project/dn2image.js";
import { IDS_FOR, reserveMessageIds } from "./messageids.js";

// Re-exported so a page importing "a device" gets its description from the same place. The
// definition lives in `devicechoice.ts`, which needs no MIDI and therefore no browser.
export { type DeviceChoice, describeChoice } from "./devicechoice.js";

/*
 * `ConnectedDevice`, `identify` and `DeviceSourceError` live in `src/device/identify.ts` now.
 * Asking an instrument who it is is the dump protocol and the API disagreeing about product
 * numbers, which is true on every host. What kept the type here was the two MIDI ports it carried,
 * and the one caller that read them takes an `ApiTransport` off the device instead.
 *
 * Re-exported under their old names from their old module, so no page had to change and
 * `error instanceof DeviceSourceError` still names exactly one class.
 */
export { type ConnectedDevice, DeviceSourceError } from "../../src/device/identify.js";

export interface ConnectOptions {
  /**
   * The instrument wanted, as a **dump-protocol** `ProductId`.
   *
   * Omit to take whichever Digitone answers first. Supply it when the page needs a *particular*
   * one — which the expander always does, because "the Digitone 1" and "the Digitone II" are two
   * different roles on the same page and picking the wrong one is not a recoverable mistake.
   */
  want?: number;
  /**
   * The MIDI **input port name** to connect through, as `listDevices` reports it.
   *
   * `want` names a *kind* of instrument, and that is all the expander needs — its two roles are two
   * different products. It is not enough for the manager, where either device is a legitimate
   * subject and owning two Digitone IIs is not exotic. A port name addresses one instrument rather
   * than one model.
   */
  port?: string;
}

/**
 * Every Digitone on the MIDI ports, identified and then **let go of**.
 *
 * The manager needs this and the expander does not. On the expander each device has a fixed role,
 * so `connectDevice({ want })` says everything: the Digitone 1 is the source and the Digitone II is
 * the destination. The manager has no such asymmetry — either instrument is a legitimate subject —
 * so it cannot pick for you, and taking whichever answered first is what it was doing wrong.
 *
 * **Nothing is left open.** Every device identified here is closed before returning, and the caller
 * reconnects to the one it wants. That costs a second `Device` request, the cheapest thing on the
 * wire, and it means a picker nobody chooses from has not quietly claimed two ports.
 */
export async function listDevices(): Promise<DeviceChoice[]> {
  const { inputs, outputs } = await ports();
  const found: DeviceChoice[] = [];

  for (const pair of candidatePairs(inputs, outputs)) {
    let device: ConnectedDevice;
    try {
      device = await identifyPair(pair);
    } catch {
      // A pair that does not answer is not an error here. Enumerating is allowed to come up empty,
      // and the caller's own message about that is better than one assembled from several failures.
      continue;
    }
    found.push({
      productId: device.productId,
      name: device.name,
      port: pair.input.name ?? "",
      ...(device.firmwareVersion === undefined ? {} : { firmwareVersion: device.firmwareVersion }),
    });
    device.close();
  }
  return found;
}

async function ports(): Promise<{ inputs: MIDIInput[]; outputs: MIDIOutput[] }> {
  if (!navigator.requestMIDIAccess) {
    throw new DeviceSourceError(
      "This browser has no Web MIDI. Chrome or Edge — Safari and Firefox cannot do this.",
    );
  }
  const access = await navigator.requestMIDIAccess({ sysex: true });
  const inputs = [...access.inputs.values()];
  const outputs = [...access.outputs.values()];
  if (inputs.length === 0 || outputs.length === 0) {
    throw new DeviceSourceError("No MIDI ports. Connect the instrument over USB and try again.");
  }
  return { inputs, outputs };
}

/**
 * Find a Digitone on the MIDI ports and confirm what it is.
 *
 * ## Why this asks around rather than guessing once
 *
 * Nothing in Web MIDI says which ports belong together, or what is behind them. Port names are the
 * only clue and they are an OS convention, not a protocol — so pairing is a guess, and **the only
 * authority on what an instrument is, is its own `Device` reply**.
 *
 * This used to take the single best-named pair and fail if it was wrong. That is fine with one
 * instrument connected and useless with two: the expander's whole premise is a Digitone 1 to read
 * from and a Digitone II to write to, at the same time, and one guess cannot address both.
 *
 * So every candidate pair is tried in order of confidence, each is asked who it is, and the first
 * that matches wins. With one device that is exactly one request, as before. With two it is what
 * makes "connect the Digitone 1" mean what it says.
 *
 * Pairs that answer but are the wrong instrument are **closed on the way past**, so probing leaves
 * no listeners behind on ports the page is not using.
 */
export async function connectDevice(options: ConnectOptions = {}): Promise<ConnectedDevice> {
  const { inputs, outputs } = await ports();

  const all = candidatePairs(inputs, outputs);
  const candidates =
    options.port === undefined ? all : all.filter((p) => (p.input.name ?? "") === options.port);
  // A named port that is not there is its own failure, and a different one from "nothing answered":
  // the instrument was unplugged, or the picker is showing a list from before it was.
  if (candidates.length === 0 && options.port !== undefined) {
    throw new DeviceSourceError(
      `No MIDI port called "${options.port}". It may have been unplugged since the list was made — ` +
        `look again.`,
    );
  }
  /** What answered, so a failure can say what *is* there rather than only what is not. */
  const answered: string[] = [];
  let lastError: unknown;

  for (const pair of candidates) {
    let device: ConnectedDevice;
    try {
      device = await identifyPair(pair);
    } catch (error) {
      lastError = error;
      continue;
    }

    if (options.want === undefined || device.productId === options.want) return device;

    // The right kind of instrument, on the wrong port pair for this role. Let go of it cleanly —
    // a probe that leaves listeners on every port it touched is a probe that changes the thing it
    // is measuring.
    answered.push(device.name);
    device.close();
  }

  if (options.want !== undefined) {
    const wanted = PRODUCT_NAMES[options.want] ?? `product ${options.want}`;
    throw new DeviceSourceError(
      answered.length > 0
        ? `No ${wanted} on the MIDI ports. Found: ${[...new Set(answered)].join(", ")}.`
        : `No ${wanted} answered on any of the ${candidates.length} port pair(s) tried. ` +
          `Connect it over USB, and check no other application is holding it.`,
    );
  }
  throw lastError instanceof DeviceSourceError
    ? lastError
    : new DeviceSourceError(`No Digitone answered on any MIDI port pair: ${String(lastError)}`);
}

/**
 * Ask one Web MIDI pair who is behind it. Closes itself on every failure.
 *
 * All this adds to core's `identify` is the adapter: a `DeviceLink` over the two ports, which
 * brings the port-name matching's guess together with this page's other-traffic counter. Opening
 * the ports is the link's job now, under the `ready` rule, rather than an unconditional
 * `open()` pair here.
 */
async function identifyPair(pair: PortPair): Promise<ConnectedDevice> {
  return await identify(new DeviceLink(pair.input, pair.output), {
    portName: pair.output.name ?? "the output port",
  });
}

export interface DeviceProjectHandle {
  productId: number;
  io: DeviceIo;
  /** The image exactly as it came off the instrument — the baseline every write diffs against. */
  original: Uint8Array;
  /** A record the device produced, proving the storage version any write must match. */
  witness: Uint8Array;
  /** What did not arrive cleanly, so a caller can refuse to edit a bad read. */
  problems: string[];
}

/** Read a whole project off a connected device. */
export async function readProject(
  device: ConnectedDevice,
  donor: Uint8Array,
  onProgress: (done: number, total: number, label: string) => void,
): Promise<{ image: Uint8Array; handle: DeviceProjectHandle }> {
  const project = await readProjectFromDevice({
    productId: device.productId,
    io: device.io,
    donor,
    onProgress,
  });

  const witness = project.witness.get(0x50);
  if (!witness) {
    throw new DeviceSourceError(
      "The device sent no pattern records, so there is nothing to edit and no way to check the " +
        "storage version of anything written back.",
    );
  }

  const problems: string[] = [];
  if (project.report.silent > 0) {
    problems.push(`${project.report.silent} object(s) went unanswered`);
  }
  if (project.report.badChecksums > 0) {
    problems.push(`${project.report.badChecksums} arrived corrupt — read again before editing`);
  }

  return {
    image: project.image,
    handle: { productId: device.productId, io: device.io, original: project.image, witness, problems },
  };
}

export interface WriteBackHooks {
  /** Required, and required by the type: see `src/device/writepermit.ts`. */
  onBackup: BackupHook;
  confirm: ConfirmHook<RecordWriteReview>;
  onStatus?: (message: string) => void;
  onProgress?: (done: number, total: number, stage: WriteStage) => void;
  limit?: number;
}

/**
 * Send the records the user's edits changed, and nothing else.
 *
 * A thin adapter now: it turns a `DeviceProjectHandle` into the arguments `safeWriteRecords` wants
 * and does nothing else. It used to call `writeChangedRecords` directly, which is precisely the
 * shape this change removed — three surfaces each sending to an instrument by their own route, none
 * of them backing anything up, none of them checking that the bytes landed.
 */
export async function writeBack(
  handle: DeviceProjectHandle,
  edited: Uint8Array,
  hooks: WriteBackHooks,
): Promise<SafeRecordWriteResult> {
  // Nothing reaches an instrument until somebody arms the switch. Thrown before a byte is
  // sent, so a control the page forgot to gate still cannot write. See `writeenable.ts`.
  requireWriteEnabled();
  return safeWriteRecords({
    productId: handle.productId,
    io: handle.io,
    before: handle.original,
    after: edited,
    layout: layoutFor(edited),
    witness: handle.witness,
    onBackup: hooks.onBackup,
    confirm: hooks.confirm,
    ...(hooks.onStatus === undefined ? {} : { onStatus: hooks.onStatus }),
    ...(hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress }),
    ...(hooks.limit === undefined ? {} : { limit: hooks.limit }),
  });
}

// --- the +Drive: any project, not just the open one -----------------------------------------------

/**
 * The device's +Drive transport.
 *
 * Kept as a function because ten call sites across the library, the backup and the drive-project
 * workflows read like `apiTransport(device)`, and item 10 of the refactor is where those learn to
 * take an `ApiTransport` as a parameter instead. Until then this is one field lookup.
 *
 * **It used to build a fresh `DeviceLink` per call**, over a second `WebMidiPort` on the same MIDI
 * input. That was invisible bookkeeping: each call put another `midimessage` listener on the port
 * and `device.close()` knew about none of them. The correlation is per request, not per link, so
 * one transport on the link that identified the device carries overlapping conversations exactly
 * as several links did, and now the close covers them.
 */
export function apiTransport(device: ConnectedDevice): ApiTransport {
  return device.api;
}
// Message ids come from the page's one allocator. This module used to keep its own band scheme —
// the same idea the probe also implemented separately — and neither was shared with the library,
// which is why the library collided at id 1. See `messageids.ts`.

/** Every project stored on the device, by slot. Reads nothing but the directory. */
export async function listDeviceProjects(device: ConnectedDevice): Promise<DriveProject[]> {
  try {
    return await listProjects(apiTransport(device), { msgId: reserveMessageIds(IDS_FOR.oneMessage) });
  } catch (error) {
    throw new DeviceSourceError(`Could not list the +Drive: ${String(error)}`);
  }
}

export interface DriveProjectHandle {
  image: Uint8Array;
  project: DriveProject;
  /** The payload bytes exactly as the device sent them, so the project can be saved as a file. */
  bytes: Uint8Array;
  /**
   * The parsed payload — the 31-byte container header an export has to preserve.
   *
   * That header carries the device signature and the project slot, and `buildPayload` copies it
   * verbatim. Taking it from *this* project rather than from a donor is what makes an exported
   * +Drive project the device's own file rather than a transplant.
   */
  payload: ProjectPayload;
  /**
   * The manifest an export needs, or **`undefined` when the device did not give its firmware**.
   *
   * The +Drive sends no `manifest.json` — it is reconstructed by `manifestFor`, and every field of
   * it is read off the payload or off the device except one. Without the firmware string there is
   * no honest manifest, so there is none, and the export says why rather than inventing a version.
   */
  manifest?: ProjectManifest;
}

/**
 * Open any project on the +Drive by slot, without disturbing the one the musician has loaded.
 *
 * **This is a different thing from `readProject` above**, and the difference is worth stating.
 * That one asks the dump protocol for the *active* project record by record, and fills the ~0.49%
 * that never comes over the wire from a donor file. This reads the **stored file** — every byte,
 * any slot, no donor.
 *
 * Verified byte-for-byte against Elektron's own export of the same project. See `drive.ts`.
 */
export async function openDeviceProject(
  device: ConnectedDevice,
  project: DriveProject,
  onProgress: (chunks: number, bytes: number, total?: number) => void,
): Promise<DriveProjectHandle> {
  const read = await readDriveProject(apiTransport(device), project.index, {
    msgId: reserveMessageIds(IDS_FOR.wholeProject),
    onProgress,
  });

  // The device holds a handle for the duration and releases it on every path. Saying so when the
  // release went unacknowledged is the difference between a warning and a mystery next session.
  if (!read.closed) {
    console.warn(`the +Drive did not acknowledge closing ${project.name}; the read itself succeeded`);
  }

  // The manifest the +Drive never sends, rebuilt from the payload and the device's own firmware
  // string. `manifestFor` has existed and been tested since the read was written; nothing called
  // it, which is why a project opened from a slot could be looked at and not saved.
  const manifest = device.firmwareVersion
    ? manifestFor(read.payload, project.name, device.firmwareVersion)
    : undefined;

  return {
    image: imageFrom(read.payload),
    project,
    bytes: read.bytes,
    payload: read.payload,
    ...(manifest ? { manifest } : {}),
  };
}
