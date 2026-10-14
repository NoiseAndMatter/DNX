/**
 * Ask the emulated firmware who it is, so the page can name it like any other instrument.
 *
 * ## Why this is not `identify`
 *
 * `src/device/identify.ts` is the right code and this is deliberately not calling it. It takes a
 * `SysexLink` — a port it can subscribe to, plus a transport built on that port — because on real
 * hardware replies arrive as traffic and have to be sorted out from everything else on the wire.
 * The bridge has no wire: it is one request in and that request's replies out, with no stream to
 * subscribe to and nothing else on it. Adapting a port onto that would mean inventing a
 * subscription whose only subscriber is a session that cannot be surprised, which is more
 * machinery than the two requests below.
 *
 * What is kept is the part that matters: **the identity comes from the firmware's own reply**, and
 * it is read with the same core functions `identify` uses, so the product mapping cannot drift
 * between the two paths. Nothing here guesses from a filename.
 *
 * The firmware string is asked for and tolerated absent, exactly as on hardware — a manifest
 * claiming a version we made up is the plausible-looking wrong field this project keeps paying
 * for.
 */

import {
  Code,
  RESPONSE_BIT,
  deviceRequest,
  readDeviceResponse,
  readVersionResponse,
  versionRequest,
} from "@noiseandmatter/dnx-core/device/api.js";
import { dumpProductFor } from "@noiseandmatter/dnx-core/device/dumprequest.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { PRODUCT_NAMES } from "@noiseandmatter/dnx-core/sysex/devices.js";
import { BridgeError, type EmulatorBridge } from "./emulatorbridge.js";

/** What the firmware said about itself. The same three fields a connected instrument carries. */
export interface EmulatorIdentity {
  /** Dump-protocol product id, which is **not** the one the `Device` reply carries. */
  productId: number;
  name: string;
  /** Absent when the firmware did not answer the version request. Never filled in. */
  firmwareVersion?: string;
}

/** Send a `Device` request, and a `Version` request it is allowed to ignore. */
export async function identifyEmulator(
  bridge: EmulatorBridge,
  timeoutMs = 60_000,
): Promise<EmulatorIdentity> {
  const ids = new MessageIds();

  const deviceId = ids.reserve(1);
  const reply = await bridge.request(deviceRequest(deviceId), deviceId, timeoutMs);
  if (reply.code !== (Code.Device | RESPONSE_BIT)) {
    throw new BridgeError(
      `the firmware answered the Device request with code 0x${reply.code.toString(16)}`,
    );
  }
  const info = readDeviceResponse(reply.body);
  const productId = dumpProductFor(info.productId);
  if (productId === undefined) {
    throw new BridgeError(
      `${info.deviceName} is not a device this build knows how to address in the dump protocol.`,
    );
  }

  let firmwareVersion: string | undefined;
  try {
    const versionId = ids.reserve(1);
    firmwareVersion = readVersionResponse(
      (await bridge.request(versionRequest(versionId), versionId, timeoutMs)).body,
    ).version;
  } catch {
    // Tolerated, as on hardware: the connection is not worth failing over a field only the
    // exporter needs, and leaving it absent is the truthful answer.
    firmwareVersion = undefined;
  }

  return {
    productId,
    name: PRODUCT_NAMES[productId] ?? info.deviceName,
    ...(firmwareVersion ? { firmwareVersion } : {}),
  };
}
