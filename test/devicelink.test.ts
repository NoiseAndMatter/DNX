/**
 * Web MIDI as a `SysexPort`, and the port-name guessing beside it.
 *
 * The correlation these ports feed is tested in `link.test.ts`, against a fake port and no browser
 * at all. What is left here is the half only a browser has: a `midimessage` listener, a port that
 * has to be opened before it can hear, and the OS naming convention that says which input belongs
 * with which output.
 *
 * **The opening rules are the ones written in blood.** Both came off hardware: one from a port
 * that delivered nothing because nobody opened it, one from a write that hung because an
 * already-open port was opened again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceLink, WebMidiPort, bestPair, candidatePairs, sharedPrefix } from "../web/src/devicelink.js";

/**
 * A MIDI input that hands out whatever we feed it, and counts its listeners.
 *
 * `connection` defaults to `"open"`, matching the state a wait finds Listen in on the probe page —
 * the exact case where calling `.open()` again hung on real hardware. `neverOpens` reproduces a
 * genuinely closed port whose `.open()` never settles, which is the case the ceiling exists for.
 */
function fakeInput(options: { connection?: "open" | "closed"; neverOpens?: boolean } = {}) {
  const listeners = new Set<(event: { data: Uint8Array | null }) => void>();
  let opened = 0;
  let connection = options.connection ?? "open";
  return {
    port: {
      get connection() {
        return connection;
      },
      open: async () => {
        opened++;
        if (options.neverOpens) return new Promise(() => {}); // never resolves, on purpose
        connection = "open";
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

/**
 * A MIDI output that records what was sent, and opens like a real one.
 *
 * `connection` defaults to `"open"` for the same reason the input's does: that is the state every
 * wait after the first finds the ports in, and re-opening an open port is the bug the `ready`
 * contract exists for. `identify` is the caller that meets a genuinely shut output.
 */
function fakeOutput(options: { connection?: "open" | "closed" } = {}) {
  const sent: number[][] = [];
  let opened = 0;
  let connection = options.connection ?? "open";
  return {
    port: {
      get connection() {
        return connection;
      },
      open: async () => {
        opened++;
        connection = "open";
      },
      send: (bytes: number[]) => void sent.push([...bytes]),
    },
    sent,
    get openCalls() {
      return opened;
    },
  };
}

/** A port over the fakes. The casts are the price of not pulling in a DOM. */
function portOver(input: ReturnType<typeof fakeInput>, output: ReturnType<typeof fakeOutput>): WebMidiPort {
  return new WebMidiPort(input.port as unknown as MIDIInput, output.port as unknown as MIDIOutput);
}

/** A link over the fakes, exercising the adapter and the correlation together. */
function linkOver(input: ReturnType<typeof fakeInput>, output: ReturnType<typeof fakeOutput>): DeviceLink {
  return new DeviceLink(input.port as unknown as MIDIInput, output.port as unknown as MIDIOutput);
}

/** Match a message by its first byte, standing in for a real reply shape. */
const byTag = (tag: number) => (data: Uint8Array) => (data[0] === tag ? data : undefined);

test("a subscriber hears the port, and stopping takes the MIDI listener with it", () => {
  const input = fakeInput();
  const port = portOver(input, fakeOutput());
  const heard: number[][] = [];

  const stop = port.subscribe((bytes) => void heard.push([...bytes]));
  assert.equal(input.listenerCount, 1);
  input.deliver([0xf0, 0x01]);

  stop();
  assert.equal(input.listenerCount, 0, "the midimessage listener outlived its subscription");
  input.deliver([0xf0, 0x02]);

  assert.deepEqual(heard, [[0xf0, 0x01]], "a message arrived after the subscription was stopped");
});

test("two subscribers each get their own copy", () => {
  // Two waits in flight is the normal case, and the registry this replaced could hold exactly one
  // listener per port. A shared buffer would also let one reader's work affect the other's.
  const input = fakeInput();
  const port = portOver(input, fakeOutput());
  const first: Uint8Array[] = [];
  const second: Uint8Array[] = [];

  port.subscribe((bytes) => void first.push(bytes));
  port.subscribe((bytes) => void second.push(bytes));
  input.deliver([0xf0, 0x7f]);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0], second[0], "both subscribers were handed the same buffer");
});

test("closing the port drops every subscription, and nothing else", () => {
  // What a device's `close()` is for: a probe that leaves listeners on every port it touched is a
  // probe that changes the thing it is measuring. The MIDI port itself stays open, because a page
  // holds one input for several conversations at once.
  const input = fakeInput();
  const port = portOver(input, fakeOutput());
  port.subscribe(() => {});
  port.subscribe(() => {});
  assert.equal(input.listenerCount, 2);

  port.close();
  assert.equal(input.listenerCount, 0);
  assert.equal(port.input.connection, "open", "the MIDI port itself must not be closed");
});

test("send goes out of the output port", () => {
  const output = fakeOutput();
  portOver(fakeInput(), output).send(Uint8Array.of(0xf0, 0x7f));
  assert.deepEqual(output.sent, [[0xf0, 0x7f]]);
});

test("a closed input is opened before anything is expected from it", async () => {
  // A closed port delivers nothing and looks exactly like a device that never answered. The probe
  // page's request paths only worked while its capture was running, for exactly this reason.
  const input = fakeInput({ connection: "closed" });
  const link = linkOver(input, fakeOutput());
  await link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 5 });
  assert.equal(input.openCalls, 1);
});

test("an input that is already open is not opened again, and costs no await", async () => {
  // **Found on hardware.** A write's read-back requires Listen to be running, which means the
  // input is already open by the time the wait starts. Calling `.open()` again did not resolve
  // promptly the way the spec says it should — it hung, past even the wait's own timeout, because
  // the timeout is armed *after* that point. A write that had already landed on the device sat in
  // "Write in progress" forever. Confirmed by writing to H13 and H16 on real hardware: both showed
  // the write succeed on the device and the page never move past it.
  //
  // `ready` returning `undefined` rather than a resolved promise is what keeps the async gap out
  // of the wait. The correlation's side of that contract is pinned in `link.test.ts`.
  const input = fakeInput({ connection: "open" });
  const output = fakeOutput({ connection: "open" });
  assert.equal(portOver(input, output).ready(), undefined, "an open pair must report no work to do");

  const link = linkOver(input, output);
  const result = await link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 5 });
  assert.equal(input.openCalls, 0, "an already-open port must not be re-opened");
  assert.equal(output.openCalls, 0, "an already-open port must not be re-opened");
  assert.equal(result, undefined, "the wait must still resolve — this is the regression test");
});

test("a shut output is opened too, because connect used to do it unconditionally", async () => {
  // `identify` opened both ports itself, outside the `ready` rule, and that unconditional pair of
  // opens is what kept it in the browser layer. Folding the output in here is what let it move.
  // Web MIDI opens an output implicitly on `send`, but a call that has always been made is not
  // dropped on the strength of a spec sentence when the path needs an instrument to test.
  const input = fakeInput({ connection: "closed" });
  const output = fakeOutput({ connection: "closed" });
  const link = linkOver(input, output);

  await link.awaitReply({ send: () => output.port.send([0x01]), match: byTag(0xaa), timeoutMs: 5 });

  assert.equal(input.openCalls, 1, "the input was not opened");
  assert.equal(output.openCalls, 1, "the output was not opened");
  assert.deepEqual(output.sent, [[0x01]], "the request went out once the ports were open");
});

test("an open that never resolves does not hang the wait", async () => {
  // Defence in depth for the same class of bug, on the path that genuinely needs to open: if
  // `.open()` itself is the thing that never settles, the wait must still finish rather than
  // silently hanging past its own timeout the way the hardware bug did.
  const input = fakeInput({ connection: "closed", neverOpens: true });
  const output = fakeOutput();
  const link = linkOver(input, output);
  let openError: unknown;
  let sendError: unknown;
  const result = await link.awaitReply({
    send: () => output.port.send([0x01]),
    match: byTag(0xaa),
    timeoutMs: 5,
    onOpenError: (error) => {
      openError = error;
    },
    onSendError: (error) => {
      sendError = error;
    },
  });
  assert.equal(result, undefined);
  assert.match(String(openError), /could not open/);
  // A failure to open is not a failure to send, and must not be reported as one: a caller that
  // logs `onSendError` under "Send failed" would be describing a send that never happened.
  assert.equal(sendError, undefined, "an open failure was reported as a send failure");
  assert.deepEqual(output.sent, [], "nothing may be sent through a port that never opened");
  assert.equal(input.listenerCount, 0, "no listener should have been attached — the port never opened");
});

test("a link over real ports still correlates a reply end to end", async () => {
  // The adapter and the correlation, wired the way every page wires them. Each half is proven on
  // its own; this is the proof that the two are actually connected.
  const input = fakeInput();
  const output = fakeOutput();
  const link = linkOver(input, output);

  const waiting = link.awaitReply({
    send: () => output.port.send([0x01]),
    match: byTag(0xaa),
    timeoutMs: 500,
  });
  await Promise.resolve();
  input.deliver([0xaa, 0x02]);

  assert.deepEqual([...(await waiting)!], [0xaa, 0x02]);
  assert.equal(input.listenerCount, 0, "the listener outlived its request");
  assert.deepEqual(output.sent, [[0x01]], "the request was not sent exactly once");
});

const port = (name: string) => ({ name }) as unknown as MIDIInput & MIDIOutput;

test("ports are paired by the longest shared name", () => {
  const inputs = [port("Launchpad"), port("Digitone II MIDI 1")];
  const outputs = [port("Digitone II MIDI 1"), port("Launchpad")];
  assert.equal(bestPair(inputs, outputs)?.input.name, "Digitone II MIDI 1");
  assert.equal(sharedPrefix("Digitone II", "Digitone 1"), 9);
});

test("no shared prefix means no guess, rather than a guess dressed as a fact", () => {
  // Four identical-looking ports on one interface: picking the first of each would be wrong three
  // times in four and look exactly as confident as a right answer.
  assert.equal(bestPair([port("MIDIIN1")], [port("out A")]), undefined);
});

test("both instruments are offered when both are plugged in, best guess first", () => {
  // The reason `candidatePairs` exists. The expander needs a Digitone 1 to read from and a
  // Digitone II to write to at the same time, so an answer that names one pair cannot serve it —
  // the caller has to be able to ask each one who it is.
  const inputs = [port("Digitone II MIDI 1"), port("Digitone MIDI 1")];
  const outputs = [port("Digitone MIDI 1"), port("Digitone II MIDI 1")];

  const pairs = candidatePairs(inputs, outputs);
  assert.equal(pairs.length, 2, "one candidate per output, so every instrument is reachable");
  // Each output found its own twin rather than the other instrument, which shares a prefix with it.
  for (const pair of pairs) assert.equal(pair.input.name, pair.output.name);
  // "Digitone II MIDI 1" agrees with itself over more characters, so it is tried first.
  assert.equal(pairs[0]!.output.name, "Digitone II MIDI 1");
});
