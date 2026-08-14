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

import {
  type DeviceIo,
  deliver,
  readProjectFromDevice,
  writeChangedRecords,
} from "../../src/device/deviceproject.js";
import {
  type ApiFrame,
  Code,
  decodeMessage,
  deviceRequest,
  isApiMessage,
  readDeviceResponse,
  readVersionResponse,
  versionRequest,
} from "../../src/device/api.js";
import {
  type DriveProject,
  imageFrom,
  listProjects,
  manifestFor,
  readDriveProject,
} from "../../src/device/drive.js";
import type { ProjectManifest, ProjectPayload } from "../../src/project/container.js";
import { type ApiTransport } from "../../src/device/storagesession.js";
import { DeviceLink, candidatePairs } from "./devicelink.js";
import { type DeviceChoice } from "./devicechoice.js";
import { DeviceSession } from "../../src/device/session.js";
import { dumpProductFor } from "../../src/device/dumprequest.js";
import { PRODUCT_NAMES } from "../../src/sysex/devices.js";
import { layoutFor } from "../../src/project/dn2image.js";
import { IDS_FOR, reserveMessageIds } from "./messageids.js";

export class DeviceSourceError extends Error {}

// Re-exported so a page importing "a device" gets its description from the same place. The
// definition lives in `devicechoice.ts`, which needs no MIDI and therefore no browser.
export { type DeviceChoice, describeChoice } from "./devicechoice.js";

export interface ConnectedDevice {
  productId: number;
  name: string;
  io: DeviceIo;
  input: MIDIInput;
  output: MIDIOutput;
  /**
   * The instrument's own firmware string, e.g. `1.10E`. **`undefined` when it did not answer**, and
   * left that way rather than filled in.
   *
   * A project file's manifest carries a `FirmwareVersion`, so exporting anything read off this
   * device needs it — and a manifest claiming a firmware we made up is precisely the
   * plausible-looking wrong field this codebase keeps paying for. Absent means absent; the caller
   * says so instead of writing a guess into a file.
   */
  firmwareVersion?: string;
  close(): void;
}

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
      device = await identify(pair);
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
      device = await identify(pair);
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

/** Open one pair, ask what is behind it, and describe it. Closes itself on every failure. */
async function identify(pair: { input: MIDIInput; output: MIDIOutput }): Promise<ConnectedDevice> {
  // Explicitly, because `addEventListener` does not open a MIDI input — only assigning
  // `onmidimessage` does, and a closed port delivers nothing while looking like a silent device.
  await Promise.all([pair.input.open(), pair.output.open()]);

  const io: DeviceIo = { send: (bytes) => pair.output.send([...bytes]) };
  const onMessage = (event: MIDIMessageEvent): void => {
    if (event.data) deliver(io, new Uint8Array(event.data));
  };
  pair.input.addEventListener("midimessage", onMessage);
  const close = (): void => pair.input.removeEventListener("midimessage", onMessage);

  // Ask what it is before anything else. The dump protocol and the API number products
  // differently, and a request addressed in the wrong space is correctly ignored.
  const session = new DeviceSession({ send: io.send });
  const relay = (event: MIDIMessageEvent): void => {
    if (event.data) session.receive(new Uint8Array(event.data));
  };
  pair.input.addEventListener("midimessage", relay);
  try {
    const info = readDeviceResponse((await session.request(Code.Device, deviceRequest)).body);
    const productId = dumpProductFor(info.productId);
    if (productId === undefined) {
      throw new DeviceSourceError(
        `${info.deviceName} is not a device this build knows how to address in the dump protocol.`,
      );
    }
    // Asked here because the session is already open and this is the cheapest request there is —
    // and because the alternative is asking at export time, when the port may have moved on.
    // **A silence is tolerated**: the connection is not worth failing over a field only the
    // exporter needs, and `firmwareVersion` staying undefined is a truthful answer.
    let firmwareVersion: string | undefined;
    try {
      firmwareVersion = readVersionResponse((await session.request(Code.Version, versionRequest)).body).version;
    } catch {
      firmwareVersion = undefined;
    }

    return {
      productId,
      name: PRODUCT_NAMES[productId] ?? info.deviceName,
      io,
      input: pair.input,
      output: pair.output,
      ...(firmwareVersion ? { firmwareVersion } : {}),
      close,
    };
  } catch (error) {
    close();
    throw error instanceof DeviceSourceError
      ? error
      : new DeviceSourceError(
          `No reply from ${pair.output.name}. Wrong port pair, another application holding it, ` +
            `or a browser dropping SysEx: ${String(error)}`,
        );
  } finally {
    pair.input.removeEventListener("midimessage", relay);
    session.close();
  }
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

/** Send the records the user's edits changed, and nothing else. */
export async function writeBack(
  handle: DeviceProjectHandle,
  edited: Uint8Array,
  onProgress: (done: number, total: number, label: string) => void,
  limit?: number,
): Promise<{ written: number; bytes: number; untransmittable: string[] }> {
  const outcome = await writeChangedRecords({
    productId: handle.productId,
    io: handle.io,
    before: handle.original,
    after: edited,
    layout: layoutFor(edited),
    witness: handle.witness,
    onProgress,
    ...(limit === undefined ? {} : { limit }),
  });
  return {
    written: outcome.written.length,
    bytes: outcome.bytes,
    untransmittable: outcome.untransmittable,
  };
}

// --- the +Drive: any project, not just the open one -----------------------------------------------

/**
 * Web MIDI as an `ApiTransport`.
 *
 * The correlation itself lives in `devicelink.ts` — one listener per request, matched by message
 * id — because the probe page needed exactly the same thing and had written its own, differing in
 * the part that matters. All this adds is the error the +Drive code expects on silence.
 */
export function apiTransport(device: ConnectedDevice): ApiTransport {
  return new DeviceLink(device.input, device.output).transport({
    timeoutError: (msgId, ms) => new DeviceSourceError(`no reply to 0x${msgId.toString(16)} within ${ms}ms`),
  });
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
  onProgress: (chunks: number, bytes: number) => void,
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
