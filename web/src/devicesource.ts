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
} from "../../src/device/api.js";
import {
  type DriveProject,
  imageFrom,
  listProjects,
  readDriveProject,
} from "../../src/device/drive.js";
import { type ApiTransport } from "../../src/device/storagesession.js";
import { DeviceSession } from "../../src/device/session.js";
import { dumpProductFor } from "../../src/device/dumprequest.js";
import { PRODUCT_NAMES } from "../../src/sysex/devices.js";
import { layoutFor } from "../../src/project/dn2image.js";

export class DeviceSourceError extends Error {}

export interface ConnectedDevice {
  productId: number;
  name: string;
  io: DeviceIo;
  input: MIDIInput;
  output: MIDIOutput;
  close(): void;
}

/**
 * Find a Digitone on the MIDI ports and confirm what it is.
 *
 * Pairs input and output by longest shared name prefix, the same guess the probe makes and for the
 * same reason: nothing in Web MIDI says which ports belong together. Unlike the probe there is no
 * chooser here yet — see the handover note. A wrong pair fails loudly at the `Device` request
 * rather than silently later.
 */
export async function connectDevice(): Promise<ConnectedDevice> {
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

  const pair = bestPair(inputs, outputs);
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
    return {
      productId,
      name: PRODUCT_NAMES[productId] ?? info.deviceName,
      io,
      input: pair.input,
      output: pair.output,
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
 * Web MIDI as an `ApiTransport`, **matching replies by message id**.
 *
 * The id match is the substance. Elektron Transfer polls the same port continuously and both
 * Digitones volunteer API messages when a port opens, so "the next message to arrive" is regularly
 * somebody else's — a confusion that has already produced one false finding here.
 *
 * A fresh listener per request, removed on the way out. The probe keeps a single global slot and
 * paid for it: two overlapping reads there stole each other's answers.
 */
function apiTransport(device: ConnectedDevice): ApiTransport {
  return {
    request(request: Uint8Array, msgId: number, timeoutMs: number): Promise<ApiFrame> {
      return new Promise((resolve, reject) => {
        const done = (fn: () => void): void => {
          clearTimeout(timer);
          device.input.removeEventListener("midimessage", onMessage);
          fn();
        };
        const timer = setTimeout(
          () => done(() => reject(new DeviceSourceError(`no reply to 0x${msgId.toString(16)} within ${timeoutMs}ms`))),
          timeoutMs,
        );
        const onMessage = (event: MIDIMessageEvent): void => {
          if (!event.data) return;
          const data = new Uint8Array(event.data);
          if (!isApiMessage(data)) return;
          let frame: ApiFrame;
          try {
            frame = decodeMessage(data);
          } catch {
            return;
          }
          if (frame.respId !== msgId) return;
          done(() => resolve(frame));
        };

        device.input.addEventListener("midimessage", onMessage);
        try {
          device.output.send([...request]);
        } catch (error) {
          done(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
    },
  };
}

/**
 * Message ids for +Drive work, in bands.
 *
 * A single read consumes one id per chunk — 1,358 for a DN1 project — and **`msgId` is a u16**, so
 * a plain counter runs out. Bands start at 8,192 to stay clear of Transfer, which numbers from the
 * low hundreds, and each call takes a fresh one.
 */
let driveBand = 0;
function nextDriveId(): number {
  return 8_192 + (driveBand++ % 6) * 8_192;
}

/** Every project stored on the device, by slot. Reads nothing but the directory. */
export async function listDeviceProjects(device: ConnectedDevice): Promise<DriveProject[]> {
  try {
    return await listProjects(apiTransport(device), { msgId: nextDriveId() });
  } catch (error) {
    throw new DeviceSourceError(`Could not list the +Drive: ${String(error)}`);
  }
}

export interface DriveProjectHandle {
  image: Uint8Array;
  project: DriveProject;
  /** The payload bytes exactly as the device sent them, so the project can be saved as a file. */
  bytes: Uint8Array;
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
    msgId: nextDriveId(),
    onProgress,
  });

  // The device holds a handle for the duration and releases it on every path. Saying so when the
  // release went unacknowledged is the difference between a warning and a mystery next session.
  if (!read.closed) {
    console.warn(`the +Drive did not acknowledge closing ${project.name}; the read itself succeeded`);
  }

  return { image: imageFrom(read.payload), project, bytes: read.bytes };
}

function bestPair(
  inputs: MIDIInput[],
  outputs: MIDIOutput[],
): { input: MIDIInput; output: MIDIOutput } {
  let best = { input: inputs[0]!, output: outputs[0]!, score: -1 };
  for (const output of outputs) {
    for (const input of inputs) {
      const score = sharedPrefix(input.name ?? "", output.name ?? "");
      if (score > best.score) best = { input, output, score };
    }
  }
  return { input: best.input, output: best.output };
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
