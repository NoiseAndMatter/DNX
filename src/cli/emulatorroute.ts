/**
 * Let the page talk to the emulator, so the UI can be used without an instrument on the desk.
 *
 * ## Why this route exists
 *
 * Everything DNX knows about the +Drive was learnt from the author's instrument, and the emulator
 * was built so that learning could happen without one. But the emulator only ever served the test
 * suite: `EmulatorBridge` spawns a process and digikit models no MIDI peripheral, so there is no
 * port for Chrome to see and the page had exactly one transport, Web MIDI. With the instrument off
 * or mid-flash, the Library could not be opened at all — not to check a layout, not to take a
 * screenshot, not to run a release check that has nothing to do with the wire.
 *
 * `ApiTransport` is one method, `request(bytes, msgId, timeoutMs)`, so an HTTP POST maps onto it
 * exactly: bytes in the request body, the reply frame's bytes in the response. No WebSocket, no
 * dependency, and nothing above the transport seam changes.
 *
 * ## What it is, and the two limits worth saying out loud
 *
 * **The +Drive API only.** The dump protocol needs a port to stream records over and there is no
 * MIDI peripheral to carry it, so reading the *active* project is not available here. The page's
 * emulator device supplies a port that refuses in those words rather than one that times out.
 *
 * **The dev server only.** This is `npm run web`; the deployed static build has no server, the
 * page's probe 404s, and no emulator entry appears. There is no build-time switch and nothing to
 * remember to turn off.
 *
 * The risk the author accepted when asking for this: a green emulator run reads as "tested". It is
 * not. Anything judged by ear, the MIDI transport itself, and the TRIM after an erase stay on the
 * instrument. See `docs/emulator-tests.md`.
 *
 * ## One image at a time, chosen from the picker
 *
 * Each configured firmware is offered as its own entry beside the MIDI ports, because they are not
 * interchangeable: the stock image has no `/waverider` route and only the erase build carries the
 * erase capability. Pointing one picker entry at the wrong image is the mistake that cost a
 * confusing test run, so the image is named in the entry rather than inferred. Opening a second
 * image closes the first — one bridge, one process.
 */

import { basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EmulatorBridge, bridgePaths } from "../node/emulatorbridge.js";
import { identifyEmulator, type EmulatorIdentity } from "../node/emulatoridentity.js";

/** The route prefix. Everything below it is this module's; nothing else serves from `web/`. */
export const EMULATOR_ROUTE = "/emulator";

/** How large a single request body may be. A write chunk is a few kilobytes; this is generous. */
const MAX_BODY = 4 * 1024 * 1024;

/**
 * The images this machine can offer, by key.
 *
 * The keys are what the page puts in a `DeviceChoice.port`, so they are stable names rather than
 * paths — a path is the server's business and does not belong in a picker's value.
 */
const IMAGES = [
  { key: "waverider", env: "DNX_WAVERIDER_FIRMWARE", label: "waverider" },
  { key: "erase", env: "DNX_ERASE_FIRMWARE", label: "waverider + erase" },
  { key: "stock", env: "DNX_EMU_FIRMWARE", label: "stock" },
] as const;

/** One emulator image the page may ask for. */
export interface EmulatorImage {
  /** `waverider`, `erase` or `stock` — what the page sends back to open it. */
  key: string;
  /** What kind of build it is, for the picker. */
  label: string;
  /** The image's filename, so the picker names the exact build rather than a category. */
  file: string;
}

/** Every image configured **and present on disk**, in the order the picker should show them. */
export function emulatorImages(): EmulatorImage[] {
  return IMAGES.flatMap((image) => {
    const firmware = process.env[image.env];
    // `bridgePaths` is the one authority on whether a bridge can actually start: it checks the
    // executable as well, and resolves both against the emulator's own working directory. An
    // entry offered here that cannot boot is worse than no entry at all.
    if (!firmware || !bridgePaths({ firmware })) return [];
    return [{ key: image.key, label: image.label, file: basename(firmware) }];
  });
}

/**
 * The bridge the page is talking to, if any.
 *
 * Module state, which is normally not allowed — but this is the dev server's own process and the
 * thing being held is an OS process, of which there is one. A second would boot for 25 s and
 * answer about a different firmware.
 */
let open: { key: string; bridge: EmulatorBridge; identity: EmulatorIdentity } | undefined;

/** Close whatever is open. Called when the page asks, and on the way out. */
export async function closeEmulator(): Promise<void> {
  const held = open;
  open = undefined;
  if (held) await held.bridge.close();
}

/**
 * Serve one request, or say this was not ours.
 *
 * Returns false for any path outside `/emulator`, so the caller falls through to the static files
 * exactly as before.
 */
export async function handleEmulator(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<boolean> {
  if (path !== EMULATOR_ROUTE && !path.startsWith(`${EMULATOR_ROUTE}/`)) return false;

  // The server binds to 127.0.0.1, so this cannot be reached from another machine. The Host check
  // is the other half of that: a name that resolves here is how a page on some other origin would
  // reach a route bound to the loopback, and this route starts processes.
  if (!isLocal(request)) {
    text(response, 403, "the emulator route is local-only");
    return true;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (path === EMULATOR_ROUTE) {
      const images = emulatorImages();
      if (images.length === 0) {
        // 404 rather than an empty list, because that is what the deployed build does and the
        // page must treat the two the same: no emulator here, carry on with Web MIDI.
        text(response, 404, "no emulator configured on this machine");
        return true;
      }
      json(response, 200, { images, open: open?.key ?? null });
      return true;
    }

    if (path === `${EMULATOR_ROUTE}/open` && request.method === "POST") {
      json(response, 200, await openImage(url.searchParams.get("image")));
      return true;
    }

    if (path === `${EMULATOR_ROUTE}/close` && request.method === "POST") {
      await closeEmulator();
      response.writeHead(204).end();
      return true;
    }

    if (path === `${EMULATOR_ROUTE}/api` && request.method === "POST") {
      await relay(request, response, url);
      return true;
    }
  } catch (error: unknown) {
    // 502 rather than 500: the failure is the thing behind this route, and the page reports what
    // it said. A boot that times out and a firmware that refused a message both land here, and
    // the message is the only thing that tells them apart.
    text(response, 502, error instanceof Error ? error.message : String(error));
    return true;
  }

  text(response, 404, `no such emulator route: ${path}`);
  return true;
}

/** Boot an image, or hand back the one already running. */
async function openImage(key: string | null): Promise<EmulatorIdentity & { image: EmulatorImage }> {
  const images = emulatorImages();
  const wanted = images.find((image) => image.key === key);
  if (!wanted) {
    throw new Error(
      `no emulator image called "${key}". This machine offers: ${
        images.map((i) => i.key).join(", ") || "none"
      }`,
    );
  }

  if (open?.key === wanted.key) return { ...open.identity, image: wanted };
  // A different image means a different firmware answering, so the old process goes first. Asking
  // one bridge about another's routes is the mistake `docs/emulator-tests.md` warns about.
  await closeEmulator();

  const firmware = process.env[IMAGES.find((i) => i.key === wanted.key)!.env]!;
  const bridge = await EmulatorBridge.start({ firmware, startupMs: 180_000 });
  try {
    const identity = await identifyEmulator(bridge);
    open = { key: wanted.key, bridge, identity };
    return { ...identity, image: wanted };
  } catch (error) {
    // A bridge that booted but would not say who it is is not a device. Nothing is left running:
    // a held process that the page does not know about is a 25-second boot nobody can reclaim.
    await bridge.close();
    throw error;
  }
}

/** One `ApiTransport.request`: the page's bytes in, the reply frame's bytes out. */
async function relay(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!open) throw new Error("no emulator is open — the page must open one before sending to it");

  const msgId = Number(url.searchParams.get("msgId"));
  const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "120000");
  if (!Number.isInteger(msgId) || msgId < 1 || msgId > 0xffff) {
    throw new Error(`msgId must be a u16 above zero, got ${url.searchParams.get("msgId")}`);
  }

  const bytes = await body(request);
  const { raw } = await open.bridge.requestRaw(bytes, msgId, timeoutMs);
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
  });
  // The frame's own bytes, not a JSON shape built to match `ApiFrame`. The page decodes them with
  // core's `decodeMessage`, so there is one decoder and a new field cannot be dropped in transit.
  response.end(Buffer.from(raw));
}

function body(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error(`request body over ${MAX_BODY} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", reject);
  });
}

function isLocal(request: IncomingMessage): boolean {
  const host = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response
    .writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    .end(JSON.stringify(value));
}

function text(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
}
