/**
 * Correlating one reply on a port that carries other people's traffic.
 *
 * **These tests exist for one bug.** The probe page kept a single module-global `awaitingReply`
 * slot shared by seven independent request paths, and two overlapping reads stole each other's
 * answers — its own comments record paying for that twice. The fix is a listener per request, and
 * "two waits do not interfere" is a property no manual test on hardware would reliably reproduce.
 *
 * They run against a fake `SysexPort`, which is the point of the interface: `SysexLink` takes a
 * port rather than reaching for one, and `awaitReply` takes `send` and `match` as functions, so
 * none of this needs a browser or an instrument. The Web MIDI adapter that satisfies the same
 * interface is tested in `devicelink.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { encode87 } from "@noiseandmatter/dnx-core/sysex/codec.js";
import { API_SELECTOR, Code, RESPONSE_BIT } from "@noiseandmatter/dnx-core/device/api.js";
import { SysexLink, matchApiFrame } from "@noiseandmatter/dnx-core/device/link.js";
import { type SysexPort } from "@noiseandmatter/dnx-core/device/port.js";

/**
 * A port that hands out whatever we feed it, and counts its listeners.
 *
 * `ready` is absent by default, standing for a port that can already hear. A test that wants the
 * opening path supplies one.
 */
function fakePort(ready?: () => Promise<void> | undefined) {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const sent: number[][] = [];
  let closes = 0;

  const port: SysexPort = {
    send: (bytes) => void sent.push([...bytes]),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => {
      closes++;
      listeners.clear();
    },
    ...(ready ? { ready } : {}),
  };

  return {
    port,
    sent,
    deliver: (bytes: number[]) => {
      // A copy per listener, as a real port does — a shared buffer would let one waiter's read
      // affect another's.
      for (const fn of [...listeners]) fn(Uint8Array.from(bytes));
    },
    get listenerCount() {
      return listeners.size;
    },
    get closeCalls() {
      return closes;
    },
  };
}

/** A reply built by hand, the way a device would — never by our own encoder. */
function reply(respId: number, code: number, ...body: number[]): Uint8Array {
  const payload = Uint8Array.from([
    0x00, 0x01,
    (respId >> 8) & 0xff, respId & 0xff,
    code | RESPONSE_BIT,
    ...body,
  ]);
  return Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, API_SELECTOR, 0x00, ...encode87(payload), 0xf7]);
}

/** Match a message by its first byte, standing in for a real reply shape. */
const byTag = (tag: number) => (data: Uint8Array) => (data[0] === tag ? data : undefined);

test("the reply that matches finishes the wait, and the listener goes", async () => {
  const fake = fakePort();
  const link = new SysexLink(fake.port);

  const waiting = link.awaitReply({
    send: () => fake.port.send(Uint8Array.of(0x01)),
    match: byTag(0xaa),
    timeoutMs: 500,
  });
  await Promise.resolve();
  fake.deliver([0xaa, 0x02]);

  assert.deepEqual([...(await waiting)!], [0xaa, 0x02]);
  assert.equal(fake.listenerCount, 0, "the listener outlived its request");
  assert.deepEqual(fake.sent, [[0x01]], "the request was not sent exactly once");
});

test("messages that do not match are ignored, not accepted", async () => {
  const fake = fakePort();
  const link = new SysexLink(fake.port);

  const waiting = link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 500 });
  await Promise.resolve();
  // Somebody else's traffic first — this is the normal case, not the exception.
  fake.deliver([0xbb, 0x09]);
  fake.deliver([0xcc]);
  fake.deliver([0xaa, 0x07]);

  assert.deepEqual([...(await waiting)!], [0xaa, 0x07]);
});

test("two waits in flight do not steal each other's replies", async () => {
  // The bug this module was extracted for. With one shared slot, whichever request registered last
  // received both answers and the other waited out its timeout.
  const fake = fakePort();
  const link = new SysexLink(fake.port);

  const first = link.awaitReply({ send: () => {}, match: byTag(0x11), timeoutMs: 500 });
  const second = link.awaitReply({ send: () => {}, match: byTag(0x22), timeoutMs: 500 });
  await Promise.resolve();
  assert.equal(fake.listenerCount, 2, "each wait must own a listener");

  // Answered out of order, which is the case that hurts.
  fake.deliver([0x22, 0xbb]);
  fake.deliver([0x11, 0xaa]);

  assert.deepEqual([...(await first)!], [0x11, 0xaa]);
  assert.deepEqual([...(await second)!], [0x22, 0xbb]);
  assert.equal(fake.listenerCount, 0);
});

test("silence resolves undefined and lets go of the port", async () => {
  const fake = fakePort();
  const link = new SysexLink(fake.port);
  assert.equal(await link.awaitReply({ send: () => {}, match: byTag(0xaa), timeoutMs: 5 }), undefined);
  assert.equal(fake.listenerCount, 0);
});

test("a late answer is an answer, when the caller asked to hear it", async () => {
  const fake = fakePort();
  const link = new SysexLink(fake.port);
  const late: Uint8Array[] = [];

  const result = await link.awaitReply({
    send: () => {},
    match: byTag(0xaa),
    timeoutMs: 5,
    onLate: (value) => void late.push(value),
  });

  assert.equal(result, undefined, "the wait itself still times out");
  assert.equal(fake.listenerCount, 1, "it must still be listening for the late reply");

  fake.deliver([0xaa, 0x42]);
  assert.equal(late.length, 1);
  assert.deepEqual([...late[0]!], [0xaa, 0x42]);
  assert.equal(fake.listenerCount, 0, "the late reply should end the listening");
});

test("a send that throws is reported, and does not leave a listener behind", async () => {
  // A port's `send` throws on an oversized message, and used to leave the shared slot armed for
  // whoever came next.
  const fake = fakePort();
  const link = new SysexLink(fake.port);
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
  assert.equal(fake.listenerCount, 0);
});

test("a port that cannot be made ready fails the wait rather than hanging it", async () => {
  // The host's own ceiling reports through `onOpenError`, and the wait ends there: nothing is sent
  // through a port that never opened, and no listener is left on it.
  const fake = fakePort(() => Promise.reject(new Error("could not open the input port")));
  const link = new SysexLink(fake.port);
  let openError: unknown;
  let sendError: unknown;

  const result = await link.awaitReply({
    send: () => fake.port.send(Uint8Array.of(0x01)),
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
  assert.deepEqual(fake.sent, [], "nothing may be sent through a port that never opened");
  assert.equal(fake.listenerCount, 0, "no listener should have been attached — the port never opened");
});

test("the transport rejects on silence, because its callers expect a throw", async () => {
  const fake = fakePort();
  const link = new SysexLink(fake.port);
  const transport = link.transport({ timeoutError: () => new Error("nothing came back") });
  await assert.rejects(() => transport.request(Uint8Array.of(0xf0), 8192, 5), /nothing came back/);
});

test("the transport tells the caller an id is ours before the bytes go out", async () => {
  // Recorded before the send, or a reply can arrive before its id is known to be ours — which is
  // how a capture of our own reads came to be labelled "not ours". Exercised on a port whose
  // `ready` genuinely suspends execution, so there is a real gap for the ordering to fail across.
  // A port that can already hear has no such gap — see the next test.
  const fake = fakePort(() => Promise.resolve());
  const order: string[] = [];
  const transport = new SysexLink(fake.port).transport({ onSend: (id) => order.push(`issued ${id}`) });

  const sending = transport.request(Uint8Array.of(0xf0), 4242, 5).catch(() => order.push("timed out"));
  // Nothing has gone out yet: making the port ready is awaited first, and the id was recorded
  // before that. The order is the claim — `issued` can never come after `sent`.
  order.push(`sent ${fake.sent.length}`);
  await sending;

  assert.deepEqual(order, ["issued 4242", "sent 0", "timed out"]);
  assert.equal(fake.sent.length, 1, "the request never went out");
});

test("a port that can already hear sends without an extra hop — the regression that mattered", async () => {
  // **Found on hardware.** An already-open Web MIDI input used to be re-opened unconditionally and
  // did not resolve promptly, and because the wait's timeout is armed after that point a write
  // that had landed on the device sat in "Write in progress" forever. The rule that came out of it
  // is here rather than in the adapter: a `ready` that returns `undefined` must cost no async gap
  // at all, and this test is what holds the awaits in `awaitReply` to that.
  const fake = fakePort(() => undefined);
  const order: string[] = [];
  const transport = new SysexLink(fake.port).transport({ onSend: (id) => order.push(`issued ${id}`) });

  const sending = transport.request(Uint8Array.of(0xf0), 4242, 5).catch(() => order.push("timed out"));
  order.push(`sent ${fake.sent.length}`);
  await sending;

  assert.deepEqual(order, ["issued 4242", "sent 1", "timed out"]);
});

test("every API frame that goes past is offered to the reply hook, ours or not", async () => {
  // The other-traffic warning counts replies to ids DNX never issued, and this is the one place a
  // decoded frame exists for every page. Passed in rather than imported, because counting them is
  // a host's business and the browser layer is where that strip lives.
  const fake = fakePort();
  const seen: (number | undefined)[] = [];
  const link = new SysexLink(fake.port, { noteReply: (respId) => void seen.push(respId) });

  const waiting = link.awaitApiFrame(8192, { send: () => {}, timeoutMs: 50 });
  await Promise.resolve();
  fake.deliver([...reply(300, Code.Device)]);
  fake.deliver([...reply(8192, Code.Device)]);

  const frame = await waiting;
  assert.equal(frame?.respId, 8192, "the wait must finish on its own id and no other");
  assert.deepEqual(seen, [300, 8192], "every frame must be offered, including the one that is ours");
});

test("matchApiFrame refuses anything that is not an API message", () => {
  assert.equal(matchApiFrame(Uint8Array.of(0xf0, 0x00, 0x20, 0x3c, 0x0d), () => true), undefined);
  assert.equal(matchApiFrame(Uint8Array.of(0x90, 0x40, 0x7f), () => true), undefined);
});

test("a timeout that fired impossibly late re-arms instead of declaring silence", async () => {
  // **The defect this prevents.** A starved or suspended page resumes with both the overdue timer
  // and any queued message runnable, in an order nobody promises. Declaring "no reply" from a timer
  // that fired minutes late reports a working instrument as a silent one.
  //
  // Measured on hardware: a 321ms settle taking 246 seconds, with the tab visible throughout.
  const fake = fakePort();
  const link = new SysexLink(fake.port);

  // A clock that jumps a minute the moment the timer fires, which is what waking up looks like.
  let clock = 0;
  const suspicions: number[] = [];
  let listeningWhenNoticed = -1;

  const waiting = link.awaitReply({
    send: () => {},
    match: byTag(0xaa),
    timeoutMs: 5,
    now: () => clock,
    onSuspicion: (elapsed) => {
      suspicions.push(elapsed);
      // Asserted at the moment it happens rather than after a sleep. The re-armed wait is only
      // `timeoutMs` long, so anything that waits before looking is racing it — the first version of
      // this test did exactly that and passed by luck.
      listeningWhenNoticed = fake.listenerCount;
      // The device answers while the page is demonstrably awake. Delivering from inside the
      // callback is also the case that proved the re-arm had to be scheduled before the caller is
      // told: otherwise this resolves and a stray timer is then scheduled behind it.
      fake.deliver([0xaa, 0x01]);
    },
  });

  clock = 60_000;
  const answer = await waiting;

  assert.deepEqual(suspicions, [60_000], "the late timer should have been noticed, once");
  assert.equal(listeningWhenNoticed, 1, "it must still be listening — nothing has been concluded");
  assert.deepEqual([...answer!], [0xaa, 0x01], "the answer after a late timer must still be heard");
  assert.equal(fake.listenerCount, 0, "and the listener goes once it is");
});

test("re-arming happens once, so a wait cannot run forever", async () => {
  // A page starved repeatedly would otherwise never conclude anything.
  const fake = fakePort();
  const link = new SysexLink(fake.port);

  let clock = 0;
  let suspicions = 0;
  const result = await new Promise<unknown>((resolve) => {
    void link
      .awaitReply({
        send: () => {},
        match: byTag(0xaa),
        timeoutMs: 5,
        now: () => clock,
        onSuspicion: () => {
          suspicions++;
          // Still asleep on the second pass: the clock keeps running away from the timer.
          clock += 60_000;
        },
      })
      .then(resolve);
    clock = 60_000;
  });

  assert.equal(result, undefined, "the second expiry must conclude rather than re-arm again");
  assert.equal(suspicions, 1);
  assert.equal(fake.listenerCount, 0);
});

test("an on-time timeout still means silence", async () => {
  // The ordinary case must not be disturbed by any of the above: a timer that fired when it was
  // asked to is evidence about the device, and it is the only evidence a silence ever gives.
  const fake = fakePort();
  const link = new SysexLink(fake.port);
  let clock = 0;
  const suspicions: number[] = [];

  const result = await link.awaitReply({
    send: () => {},
    match: byTag(0xaa),
    timeoutMs: 5,
    // Fired a few milliseconds late, which is ordinary jitter rather than a stopped page.
    now: () => (clock += 6),
    onSuspicion: (elapsed) => suspicions.push(elapsed),
  });

  assert.equal(result, undefined);
  assert.deepEqual(suspicions, [], "ordinary jitter must not read as suspension");
  assert.equal(fake.listenerCount, 0);
});
