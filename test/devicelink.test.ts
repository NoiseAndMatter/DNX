/**
 * Correlating one reply on a port that carries other people's traffic.
 *
 * **These tests exist for one bug.** The probe page kept a single module-global `awaitingReply`
 * slot shared by seven independent request paths, and two overlapping reads stole each other's
 * answers — its own comments record paying for that twice. The fix is a listener per request, and
 * "two waits do not interfere" is a property no manual test on hardware would reliably reproduce.
 *
 * `DeviceLink` takes ports rather than reaching for them, and `awaitReply` takes `send` and `match`
 * as functions, which is what makes all of this testable with no browser and no instrument.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceLink, bestPair, matchApiFrame, sharedPrefix } from "../web/src/devicelink.js";

/** A MIDI input that hands out whatever we feed it, and counts its listeners. */
function fakeInput() {
  const listeners = new Set<(event: { data: Uint8Array | null }) => void>();
  let opened = 0;
  return {
    port: {
      open: async () => {
        opened++;
      },
      addEventListener: (_type: string, fn: (event: { data: Uint8Array | null }) => void) => {
        listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (event: { data: Uint8Array | null }) => void) => {
        listeners.delete(fn);
      },
    },
    deliver: (bytes: number[]) => {
      // A copy per listener, as the browser does — a shared buffer would let one waiter's read
      // affect another's.
      for (const fn of [...listeners]) fn({ data: Uint8Array.from(bytes) });
    },
    get listenerCount() {
      return listeners.size;
    },
    get openCalls() {
      return opened;
    },
  };
}

function fakeOutput() {
  const sent: number[][] = [];
  return {
    port: { send: (bytes: number[]) => void sent.push([...bytes]) },
    sent,
  };
}

/** A link over the fakes. The casts are the price of not pulling in a DOM. */
function linkOver(input: ReturnType<typeof fakeInput>, output: ReturnType<typeof fakeOutput>): DeviceLink {
  return new DeviceLink(input.port as unknown as MIDIInput, output.port as unknown as MIDIOutput);
}

/** Match a message by its first byte, standing in for a real reply shape. */
const byTag = (tag: number) => (data: Uint8Array) => (data[0] === tag ? data : undefined);

test("the reply that matches finishes the wait, and the listener goes", async () => {
  const input = fakeInput();
  const output = fakeOutput();
  const link = linkOver(input, output);

  const waiting = link.awaitReply({ send: () => output.port.send([0x01]), match: byTag(0xaa), timeoutMs: 500 });
  await Promise.resolve();
  input.deliver([0xaa, 0x02]);

  assert.deepEqual([...(await waiting)!], [0xaa, 0x02]);
  assert.equal(input.listenerCount, 0, "the listener outlived its request");
  assert.deepEqual(output.sent, [[0x01]], "the request was not sent exactly once");
});

test("messages that do not match are ignored, not accepted", async () => {
  const input = fakeInput();
  const output = fakeOutput();
  const link = linkOver(input, output);

  const waiting = link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 500 });
  await Promise.resolve();
  // Somebody else's traffic first — this is the normal case, not the exception.
  input.deliver([0xbb, 0x09]);
  input.deliver([0xcc]);
  input.deliver([0xaa, 0x07]);

  assert.deepEqual([...(await waiting)!], [0xaa, 0x07]);
});

test("two waits in flight do not steal each other's replies", async () => {
  // The bug this module was extracted for. With one shared slot, whichever request registered last
  // received both answers and the other waited out its timeout.
  const input = fakeInput();
  const output = fakeOutput();
  const link = linkOver(input, output);

  const first = link.awaitReply({ send: () => {}, match: byTag(0x11), timeoutMs: 500 });
  const second = link.awaitReply({ send: () => {}, match: byTag(0x22), timeoutMs: 500 });
  await Promise.resolve();
  assert.equal(input.listenerCount, 2, "each wait must own a listener");

  // Answered out of order, which is the case that hurts.
  input.deliver([0x22, 0xbb]);
  input.deliver([0x11, 0xaa]);

  assert.deepEqual([...(await first)!], [0x11, 0xaa]);
  assert.deepEqual([...(await second)!], [0x22, 0xbb]);
  assert.equal(input.listenerCount, 0);
});

test("silence resolves undefined and lets go of the port", async () => {
  const input = fakeInput();
  const link = linkOver(input, fakeOutput());
  assert.equal(await link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 5 }), undefined);
  assert.equal(input.listenerCount, 0);
});

test("a late answer is an answer, when the caller asked to hear it", async () => {
  const input = fakeInput();
  const link = linkOver(input, fakeOutput());
  const late: Uint8Array[] = [];

  const result = await link.awaitReply({
    send: () => {},
    match: byTag(0xaa),
    timeoutMs: 5,
    onLate: (value) => void late.push(value),
  });

  assert.equal(result, undefined, "the wait itself still times out");
  assert.equal(input.listenerCount, 1, "it must still be listening for the late reply");

  input.deliver([0xaa, 0x42]);
  assert.equal(late.length, 1);
  assert.deepEqual([...late[0]!], [0xaa, 0x42]);
  assert.equal(input.listenerCount, 0, "the late reply should end the listening");
});

test("a send that throws is reported, and does not leave a listener behind", async () => {
  // `output.send()` throws on an oversized message, and used to leave the shared slot armed for
  // whoever came next.
  const input = fakeInput();
  const link = linkOver(input, fakeOutput());
  let seen: unknown;

  const result = await link.awaitReply({
    send: () => {
      throw new Error("port is busy");
    },
    match: byTag(0xaa),
    timeoutMs: 500,
    onSendError: (error) => {
      seen = error;
    },
  });

  assert.equal(result, undefined);
  assert.match(String(seen), /port is busy/);
  assert.equal(input.listenerCount, 0);
});

test("the input is opened before anything is expected from it", async () => {
  // A closed port delivers nothing and looks exactly like a device that never answered. The probe
  // page's request paths only worked while its capture was running, for exactly this reason.
  const input = fakeInput();
  const link = linkOver(input, fakeOutput());
  await link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 5 });
  assert.equal(input.openCalls, 1);
});

test("the transport rejects on silence, because its callers expect a throw", async () => {
  const input = fakeInput();
  const link = linkOver(input, fakeOutput());
  const transport = link.transport({ timeoutError: () => new Error("nothing came back") });
  await assert.rejects(() => transport.request(Uint8Array.of(0xf0), 8192, 5), /nothing came back/);
});

test("the transport tells the page an id is ours before the bytes go out", async () => {
  // Recorded before the send, or a reply can arrive before its id is known to be ours — which is
  // how a capture of our own reads came to be labelled "not ours".
  const input = fakeInput();
  const output = fakeOutput();
  const order: string[] = [];
  const transport = linkOver(input, output).transport({ onSend: (id) => order.push(`issued ${id}`) });

  const sending = transport.request(Uint8Array.of(0xf0), 4242, 5).catch(() => order.push("timed out"));
  // Nothing has gone out yet: opening the port is awaited first, and the id was recorded before
  // that. The order is the claim — `issued` can never come after `sent`.
  order.push(`sent ${output.sent.length}`);
  await sending;

  assert.deepEqual(order, ["issued 4242", "sent 0", "timed out"]);
  assert.equal(output.sent.length, 1, "the request never went out");
});

test("matchApiFrame refuses anything that is not an API message", () => {
  assert.equal(matchApiFrame(Uint8Array.of(0xf0, 0x00, 0x20, 0x3c, 0x0d), () => true), undefined);
  assert.equal(matchApiFrame(Uint8Array.of(0x90, 0x40, 0x7f), () => true), undefined);
});

test("ports are paired by the longest shared name", () => {
  const port = (name: string) => ({ name }) as unknown as MIDIInput & MIDIOutput;
  const inputs = [port("Launchpad"), port("Digitone II MIDI 1")];
  const outputs = [port("Digitone II MIDI 1"), port("Launchpad")];
  assert.equal(bestPair(inputs, outputs).input.name, "Digitone II MIDI 1");
  assert.equal(sharedPrefix("Digitone II", "Digitone 1"), 9);
});
