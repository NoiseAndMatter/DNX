/**
 * The emulator as an instrument the page can connect to, beside the MIDI ports.
 *
 * ## Why a page can use this at all
 *
 * `EmulatorBridge` is a child process: it boots a real Digitone II OS image and injects SysEx into
 * the firmware's own router. digikit models no MIDI peripheral, so there is no port for Chrome to
 * see and this is not something Web MIDI can reach. The dev server bridges the gap —
 * `src/cli/emulatorroute.ts` — and `ApiTransport` is a single method, so the whole crossing is one
 * POST per request. Nothing above the transport seam knows the difference.
 *
 * ## Two limits, said in the UI rather than discovered later
 *
 * **The +Drive API only.** The dump protocol streams records over a wire and there is no wire. So
 * the +Drive works — listing projects, opening one by slot, the wavetable store, the pool — and
 * reading the *active* project does not. The port below refuses in those words instead of timing
 * out, because a timeout here would read as a firmware fault.
 *
 * **The dev server only.** The deployed static build has no server, the probe below 404s, and no
 * emulator appears. There is no build-time switch to get wrong.
 *
 * And the limit that is not technical: **a green run here is not a tested instrument.** It is the
 * firmware's real handlers behind a simulated wire, which is why it is worth having, and it says
 * nothing about the transport, about anything judged by ear, or about the TRIM after an erase.
 */

import { decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { DeviceSourceError, type ConnectedDevice } from "@noiseandmatter/dnx-core/device/identify.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { type SysexPort } from "@noiseandmatter/dnx-core/device/port.js";
import { EMULATOR_PREFIX, type DeviceChoice } from "./devicechoice.js";

// The prefix and the test for it live with the type they are part of, which needs no browser.
// Re-exported so a page importing "the emulator" gets them from here.
export { EMULATOR_PREFIX, isEmulatorPort } from "./devicechoice.js";

interface ImageInfo {
  key: string;
  label: string;
  file: string;
}

/**
 * Every emulator image this machine can offer, as picker entries.
 *
 * Empty when there is no dev server or no emulator configured — never an error, because both are
 * the normal case. A page asks for this the way it asks for the template: if it is there it is
 * used, and if it is not nothing is said about it.
 *
 * **The images are offered separately on purpose.** They are not interchangeable: the stock build
 * has no `/waverider` route and only the erase build carries the erase capability. Picking the
 * wrong one cost a confusing test run once (`docs/emulator-tests.md`), so the entry names the
 * exact file rather than a category.
 */
export async function emulatorChoices(): Promise<DeviceChoice[]> {
  let images: ImageInfo[];
  try {
    const response = await fetch("/emulator", { cache: "no-store" });
    if (!response.ok) return [];
    images = ((await response.json()) as { images?: ImageInfo[] }).images ?? [];
  } catch {
    // No server, or it is not this one. Not a failure: the page has Web MIDI either way.
    return [];
  }

  return images.map((image) => ({
    // The build is named in full, because which image is answering is the thing most worth
    // knowing about an emulator entry and the one a category word would hide.
    name: `Emulator · ${image.label} · ${image.file}`,
    port: `${EMULATOR_PREFIX}${image.key}`,
    // No `productId` and no `firmwareVersion`: **nothing has asked the firmware yet.** Booting an
    // image is 25 seconds, and this list is built before anybody has chosen one. Either field
    // here would be read off a filename, which is the plausible-looking wrong value this project
    // keeps paying for. Both arrive from the firmware's own reply when the image is opened.
  }));
}

/**
 * Opens and closes, in the order they were asked for.
 *
 * Only those two: a `request` is answered by whichever bridge is open and the bridge serialises
 * those itself. What has to be ordered is the thing that *changes* which bridge is open, because
 * there is exactly one.
 *
 * **One bridge is a real limit, not an oversight.** Two pages both using the emulator share it,
 * and one of them closing takes it away from the other. Booting a second would be another 25
 * seconds answering about another firmware, so a dev server serves one; the pages are not asked
 * to pretend otherwise.
 */
let work: Promise<unknown> = Promise.resolve();

function queue(step: () => Promise<unknown>): Promise<unknown> {
  work = work.then(step, step);
  return work.catch(() => undefined);
}

/** Wait for every open and close asked for so far. */
async function settled(): Promise<void> {
  await work.catch(() => undefined);
}

/**
 * A port that cannot carry the dump protocol, and says so the moment anything tries.
 *
 * **Refusing beats being absent.** `ConnectedDevice.io` is not optional and the two readers that
 * use it — the active project read, and the record write-back — are real features of the manager.
 * A port that silently dropped sends would leave them waiting on records that are never coming,
 * which on this project's own evidence gets attributed to the firmware. One sentence naming the
 * missing peripheral costs nothing and ends the question.
 */
const NO_WIRE: SysexPort = {
  send(): void {
    throw new DeviceSourceError(
      "The emulator has no MIDI peripheral, so the dump protocol cannot run against it. Its " +
        "+Drive works — open a project from a slot — but reading the project the instrument has " +
        "loaded needs a real wire.",
    );
  },
  subscribe(): () => void {
    return () => {};
  },
  close(): void {},
};

/**
 * Open an emulator image and hand back a device the rest of the page treats as an instrument.
 *
 * The identity is the firmware's own `Device` and `Version` replies, read with the same core
 * functions `identify` uses on hardware — so the product mapping cannot drift between the two
 * paths and nothing here is inferred from a filename.
 */
export async function connectEmulator(
  port: string,
  onStatus?: (message: string) => void,
): Promise<ConnectedDevice> {
  const key = port.slice(EMULATOR_PREFIX.length);
  // **Behind whatever this page asked for last.** A picker change closes the old device and
  // connects the new one in the same tick, and the two POSTs would otherwise race: the close
  // landing second shuts down the bridge the open had just handed over, leaving a device that
  // looks connected and answers nothing. One queue here matches the one process there.
  await settled();
  // Booting the OS is about 25 seconds and there is nothing to see while it happens. Said rather
  // than left to a spinner, because a connect that takes half a minute with no explanation is
  // indistinguishable from one that has hung.
  onStatus?.(`Booting the emulator (${key})… this takes about half a minute.`);

  const response = await fetch(`/emulator/open?image=${encodeURIComponent(key)}`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new DeviceSourceError(`The emulator would not start: ${await response.text()}`);
  }
  const identity = (await response.json()) as {
    productId: number;
    name: string;
    firmwareVersion?: string;
    image: ImageInfo;
  };

  return {
    productId: identity.productId,
    name: `${identity.name} (emulator · ${identity.image.file})`,
    ...(identity.firmwareVersion ? { firmwareVersion: identity.firmwareVersion } : {}),
    io: NO_WIRE,
    api: emulatorTransport(),
    close(): void {
      // Queued rather than fired and forgotten: `close` is synchronous by contract, so the only
      // way the next connect can be ordered after it is for both to go through `settled`. A
      // server that has already gone is not a failure anybody can act on, hence the swallow — and
      // the dev server closes its bridge on exit, so a missed call costs one process until the
      // next open, not a leak that grows.
      queue(async () => {
        await fetch("/emulator/close", { method: "POST" }).catch(() => undefined);
      });
    },
  };
}

/**
 * `ApiTransport` over the dev-server route.
 *
 * **No queueing here.** The bridge serialises requests in its own process — one line in, one line
 * out — so overlapping POSTs are held there rather than interleaved, and a second queue on this
 * side would only add a place for the order to be wrong. The reply is decoded by core's
 * `decodeMessage`, the same decoder the Node side uses, which is why the route sends the frame's
 * bytes instead of a JSON shape built to look like an `ApiFrame`.
 */
function emulatorTransport(): ApiTransport {
  return {
    async request(bytes, msgId, timeoutMs) {
      const response = await fetch(
        `/emulator/api?msgId=${msgId}&timeoutMs=${Math.max(1, Math.round(timeoutMs))}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          // A copy, because `fetch` reads the buffer after this returns and the bytes handed in
          // may be a view into something the caller still owns. Messages are kilobytes.
          body: bytes.slice() as BodyInit,
        },
      );
      if (!response.ok) {
        // The server's own words. A firmware that refused the message and a bridge that died
        // both land here, and the text is the only thing that tells them apart.
        throw new DeviceSourceError(
          `the emulator did not answer message ${msgId}: ${await response.text()}`,
        );
      }
      return decodeMessage(new Uint8Array(await response.arrayBuffer()));
    },
  };
}
