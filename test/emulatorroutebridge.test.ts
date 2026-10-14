/**
 * The page's route to the emulator, end to end: browser module → HTTP → bridge → firmware.
 *
 * ## Why this is worth a boot
 *
 * The page had one transport, Web MIDI, and the emulator has no MIDI peripheral for it to find —
 * so with the instrument off or mid-flash the Library could not be opened at all. The dev server
 * now carries the +Drive API across, and what has to be true for that to be worth anything is a
 * single property: **a request made by the page's own transport comes back as the frame the
 * firmware sent, parsed by the same decoder, answering the id that was asked.**
 *
 * So this imports `web/src/emulatorsource.ts` itself rather than re-sending the POST it sends. A
 * test that posted its own body would prove the route works and say nothing about the code the
 * browser runs — and the one regression this project has had in a seam like this came from a
 * guard that compared call sites instead of answers.
 *
 * `fetch` is replaced with one that resolves the module's relative URLs against the test server.
 * That is the only thing stubbed: the module's bodies, its query parameters, its decoding and its
 * error text are all the real ones.
 *
 * Needs an emulator configured — see `docs/emulator-tests.md`. Without one these skip, and the
 * route is not reachable in that state either, which is the behaviour a deployed build has.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { closeEmulator, emulatorImages, handleEmulator } from "../src/cli/emulatorroute.js";
import {
  EMULATOR_PREFIX,
  connectEmulator,
  emulatorChoices,
  isEmulatorPort,
} from "../web/src/emulatorsource.js";
import { listRequest, parseListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { DeviceSourceError } from "@noiseandmatter/dnx-core/device/identify.js";

const images = emulatorImages();
const skip = images.length === 0
  ? "no emulator configured: see docs/emulator-tests.md"
  : false;

const TIMEOUT = 240_000;

/**
 * The dev server's routing, on a real socket.
 *
 * Only the emulator branch, because that is the only branch under test — the static file half of
 * `serve.ts` is unchanged and a 404 for everything else is exactly what the page would get.
 */
async function serve(): Promise<{ origin: string; stop: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0]!;
    handleEmulator(request, response, path)
      .then((handled) => {
        if (!handled) response.writeHead(404).end("not an emulator route");
      })
      .catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  // The page asks for `/emulator`, relative to its own origin. This is the only stub in the test.
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    real(typeof input === "string" && input.startsWith("/") ? `http://127.0.0.1:${port}${input}` : input, init)
  ) as typeof fetch;

  return {
    origin: `http://127.0.0.1:${port}`,
    stop: async () => {
      globalThis.fetch = real;
      await closeEmulator();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let running: { origin: string; stop: () => Promise<void> } | undefined;
after(async () => { await running?.stop(); });

test("the page is offered the images this machine has, and nothing else", { skip }, async () => {
  running ??= await serve();
  const choices = await emulatorChoices();

  assert.equal(choices.length, images.length, "every configured image should be offered");
  for (const choice of choices) {
    assert.ok(isEmulatorPort(choice.port), `${choice.port} should be marked as an emulator`);
    assert.ok(choice.port.startsWith(EMULATOR_PREFIX));
    // **Nothing has asked the firmware yet**, so neither field may be filled in. Both would have
    // to come from the image's filename, and a product id read off a filename is precisely the
    // plausible-looking wrong value this project keeps paying for.
    assert.equal(choice.productId, undefined, "an unopened image must claim no product id");
    assert.equal(choice.firmwareVersion, undefined, "an unopened image must claim no firmware");
    // The build is named, because which image is answering is the thing most worth knowing.
    assert.ok(choice.name.includes(".syx"), `${choice.name} should name the image file`);
  }
});

test("a request made by the page's transport is answered by the firmware", { skip }, async () => {
  running ??= await serve();
  const image = images[0]!;

  const said: string[] = [];
  const device = await connectEmulator(`${EMULATOR_PREFIX}${image.key}`, (m) => said.push(m));

  // The identity is the firmware's own `Device` reply, read with the same core functions
  // `identify` uses on hardware — so it cannot have come from the filename.
  assert.equal(typeof device.productId, "number");
  assert.ok(device.name.includes("emulator"), `${device.name} should say it is not an instrument`);
  assert.ok(device.name.includes(image.file), "and which image it is");
  assert.ok(said.some((m) => m.includes("half a minute")), "a 25-second boot must be announced");

  // The decisive one: a real +Drive read, through the page's own `ApiTransport`.
  const msgId = 8_192;
  const reply = await device.api.request(listRequest(msgId, "/"), msgId, TIMEOUT);
  assert.equal(reply.respId, msgId, "the frame that came back must answer the id we sent");
  const listing = parseListing(reply.body);
  assert.ok(
    listing.entries.some((entry) => entry.name === "projects"),
    `the root listing should have projects in it: ${listing.entries.map((e) => e.name).join(", ")}`,
  );

  /*
   * **The dump protocol is refused rather than left to time out.** There is no MIDI peripheral to
   * carry it, and a port that silently dropped sends would leave the record readers waiting on
   * records that are never coming — which on this project's own evidence gets attributed to the
   * firmware.
   */
  assert.throws(
    () => device.io.send(new Uint8Array([0xf0, 0xf7])),
    (error: unknown) =>
      error instanceof DeviceSourceError && /no MIDI peripheral/.test(error.message),
    "sending a record request must say why it cannot work",
  );

  device.close();
});

test("asking for an image this machine does not have is refused by name", { skip }, async () => {
  running ??= await serve();
  await assert.rejects(
    () => connectEmulator(`${EMULATOR_PREFIX}not-an-image`),
    (error: unknown) =>
      error instanceof DeviceSourceError && /not-an-image/.test(error.message),
    "the refusal should name what was asked for",
  );
});

test("a reply that answers somebody else is a failure, not a reply", { skip }, async () => {
  /*
   * The property every transport in DNX relies on. The bridge hands back the replies to *this*
   * request by construction, so the only way to get a mismatch is to ask for an id the firmware
   * did not answer — and what must not happen is the route shrugging and sending the frame it has.
   * A reply attributed to the wrong request is the failure mode this codebase has paid for twice,
   * and it reads as the device answering the wrong question.
   */
  running ??= await serve();
  const image = images[0]!;
  const device = await connectEmulator(`${EMULATOR_PREFIX}${image.key}`);

  const bytes = listRequest(8_300, "/");
  await assert.rejects(
    () => device.api.request(bytes, 9_999, TIMEOUT),
    (error: unknown) => error instanceof DeviceSourceError && /9999/.test(error.message),
    "the mismatch must be reported, with the id that went unanswered",
  );

  device.close();
});
