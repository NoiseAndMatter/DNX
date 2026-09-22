/**
 * Ask what is on the other end of a port, and hand back a device the rest of the code can use.
 *
 * ## Why this is not browser code
 *
 * It looks like browser code because it lived in `web/src/devicesource.ts`, beside the Web MIDI
 * enumeration. But what it does is send a `Device` request, send a `Version` request and map one
 * product numbering onto another. None of that is a browser: it is the dump protocol and the API
 * disagreeing about how a Digitone is numbered, which is true on every host.
 *
 * What kept it in the browser layer was `ConnectedDevice` carrying `input: MIDIInput` and
 * `output: MIDIOutput`. Those two fields existed for one caller, which rebuilt a link from them to
 * get an `ApiTransport`. Handing the device the transport instead removes the only reason the type
 * had to know what a MIDI port is.
 *
 * ## The only authority on what an instrument is, is its own reply
 *
 * Nothing in Web MIDI, and nothing in a Kotlin plugin either, says what is behind a port. Port
 * names are an OS convention. So the identity comes from the device, and a pair that does not
 * answer is reported as not answering rather than guessed at.
 *
 * ## What the caller still owns
 *
 * Finding ports and pairing them. This takes one `SysexLink` that is already pointed at one
 * instrument, so the browser keeps `candidatePairs` and the Kotlin host keeps whatever its MIDI
 * API calls the same thing. A link rather than a bare port, because the caller may have wired
 * hooks onto it — the web build counts other people's replies through `noteReply` — and because
 * the `ApiTransport` this returns has to be the caller's link, not a second one over the same
 * wire.
 */

import {
  Code,
  deviceRequest,
  readDeviceResponse,
  readVersionResponse,
  versionRequest,
} from "./api.js";
import { type SysexLink } from "./link.js";
import { type SysexPort } from "./port.js";
import { DeviceSession, type SessionOptions } from "./session.js";
import { type ApiTransport } from "./storagesession.js";
import { dumpProductFor } from "./dumprequest.js";
import { PRODUCT_NAMES } from "../sysex/devices.js";

/**
 * Anything that went wrong talking to an instrument, as one class every page already catches.
 *
 * Here rather than in the web layer because `identify` throws it and `identify` is core now. The
 * browser re-exports it under the same name, so `error instanceof DeviceSourceError` keeps meaning
 * what it meant: there is one class, in one place, and the pages did not have to be touched.
 */
export class DeviceSourceError extends Error {}

/** An instrument that answered, and the two ways to talk to it. */
export interface ConnectedDevice {
  /** Dump-protocol product id, which is **not** the one the `Device` reply carries. */
  productId: number;
  name: string;
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
  /**
   * The port itself, for the dump protocol: record requests out, records in.
   *
   * A `SysexPort` rather than the `DeviceIo` the readers ask for, because a port already satisfies
   * `DeviceIo` and giving the device the narrower type would mean nothing here could close it.
   */
  io: SysexPort;
  /**
   * The +Drive API, correlated by message id.
   *
   * A field rather than a function a caller passes the device to. It used to be rebuilt per call
   * from `input` and `output`, which meant every +Drive operation stood up its own listener over
   * the same MIDI input, and `close()` had no idea they existed. One transport on the link that
   * identified the device is the same correlation with one owner.
   */
  api: ApiTransport;
  /** Drop every listener this device took out. The host's port stays open. */
  close(): void;
}

export interface IdentifyOptions {
  /**
   * What to call the far end in a failure message, e.g. the output port's name.
   *
   * The caller has it and this does not: a port is bytes in and bytes out, with no name on it.
   */
  portName?: string;
  /** Passed straight to the session, so a test needs no real clock. */
  session?: SessionOptions;
}

/**
 * Ask one link who is on it. **Closes the port on every failure**, so probing a machine with four
 * ports on it does not leave listeners behind on the three that were wrong.
 */
export async function identify(link: SysexLink, options: IdentifyOptions = {}): Promise<ConnectedDevice> {
  const port = link.port;
  const close = (): void => port.close();

  /*
   * **A port that cannot hear delivers nothing, and looks exactly like a device that never
   * answered.** So the port is made ready before anything is expected of it.
   *
   * Asked for synchronously and awaited only when there is something to await, which is the
   * `SysexPort.ready` contract rather than a nicety here. This used to be an unconditional
   * `Promise.all([input.open(), output.open()])`, the one place left outside that rule — and an
   * unconditional open on an already-open port is the bug that left a landed write showing "Write
   * in progress" one level down. It also had no ceiling on it: a host whose open never settles
   * hung the connect with nothing to report the delay. `ready` has both.
   */
  const opening = port.ready?.();
  if (opening) {
    try {
      await opening;
    } catch (error) {
      close();
      throw new DeviceSourceError(error instanceof Error ? error.message : String(error));
    }
  }

  const session = new DeviceSession({ send: (bytes) => port.send(bytes) }, options.session ?? {});
  const stopRelay = port.subscribe((data) => session.receive(data));
  try {
    // Ask what it is before anything else. The dump protocol and the API number products
    // differently, and a request addressed in the wrong space is correctly ignored.
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
      io: port,
      // The +Drive code expects an error on silence, where the correlation resolves `undefined`.
      api: link.transport({
        timeoutError: (msgId, ms) =>
          new DeviceSourceError(`no reply to 0x${msgId.toString(16)} within ${ms}ms`),
      }),
      ...(firmwareVersion ? { firmwareVersion } : {}),
      close,
    };
  } catch (error) {
    close();
    throw error instanceof DeviceSourceError
      ? error
      : new DeviceSourceError(
          `No reply from ${options.portName ?? "the instrument"}. Wrong port pair, another ` +
            `application holding it, or a host dropping SysEx: ${String(error)}`,
        );
  } finally {
    stopRelay();
    session.close();
  }
}
