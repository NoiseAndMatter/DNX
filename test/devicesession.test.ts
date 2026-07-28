import assert from "node:assert/strict";
import { test } from "node:test";
import { encode87 } from "../src/sysex/codec.js";
import { API_SELECTOR, Code, RESPONSE_BIT, deviceRequest, versionRequest } from "../src/device/api.js";
import {
  DeviceSession,
  DeviceTimeout,
  SessionClosed,
  type Transport,
} from "../src/device/session.js";

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

/** Records what was sent and lets a test drive the clock rather than waiting on one. */
class Fake implements Transport {
  readonly sent: Uint8Array[] = [];
  private timers = new Map<number, () => void>();
  private next = 1;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  /** The ids the session allocated, read back off the wire rather than assumed. */
  idsSent(): number[] {
    return this.sent.map((m) => {
      // msgId is the first two bytes of the decoded payload; the first encoded group's msb byte
      // is zero for these small ids, so bytes 7 and 8 are the id directly.
      return (m[7]! << 8) | m[8]!;
    });
  }

  options() {
    return {
      setTimer: (fn: () => void) => {
        const handle = this.next++;
        this.timers.set(handle, fn);
        return handle;
      },
      clearTimer: (handle: unknown) => {
        this.timers.delete(handle as number);
      },
    };
  }

  /** Fire every outstanding timer, as a clock would. */
  expireAll(): void {
    const firing = [...this.timers.values()];
    this.timers.clear();
    for (const fn of firing) fn();
  }

  get liveTimers(): number {
    return this.timers.size;
  }
}

// --- matching a reply to its request ----------------------------------------------------------

test("a reply resolves the request it names", async () => {
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());

  const pending = session.request(Code.Device, deviceRequest);
  const [id] = fake.idsSent();
  session.receive(reply(id!, Code.Device, 43, 0, 0));

  const frame = await pending;
  assert.equal(frame.respId, id);
  assert.equal(frame.code, Code.Device | RESPONSE_BIT);
});

test("two requests in flight get their own replies, in whatever order they arrive", async () => {
  // The reason ids exist. Resolving in arrival order would hand a Version reply to whoever asked
  // for Device, and the arguments would be parsed by the wrong reader — corrupt-looking data
  // from a bookkeeping mistake.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());

  const device = session.request(Code.Device, deviceRequest);
  const version = session.request(Code.Version, versionRequest);
  const [deviceId, versionId] = fake.idsSent();
  assert.notEqual(deviceId, versionId, "each request must get its own id");

  session.receive(reply(versionId!, Code.Version, 0x30, 0));
  session.receive(reply(deviceId!, Code.Device, 43, 0, 0));

  assert.equal((await device).respId, deviceId);
  assert.equal((await version).respId, versionId);
});

test("ids never start at zero, because zero means \"this is a request\"", async () => {
  // A request numbered 0 would be answered by something indistinguishable from a fresh request,
  // and `decodeMessage` reports respId 0 as `undefined` for exactly that reason.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());
  for (let i = 0; i < 5; i++) void session.request(Code.Device, deviceRequest).catch(() => {});
  assert.ok(
    fake.idsSent().every((id) => id !== 0),
    `an id of 0 was allocated: ${fake.idsSent().join(", ")}`,
  );
});

test("a reply carrying the wrong code for its id is refused, not parsed", async () => {
  // Worse than no reply: acting on it would read one message's arguments with another's reader,
  // and the result would look like data rather than like a mismatch.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());

  const pending = session.request(Code.Device, deviceRequest);
  session.receive(reply(fake.idsSent()[0]!, Code.Version, 0x30, 0));

  await assert.rejects(pending, /expected code 0x81 but the device answered with 0x82/);
});

// --- what is ignored, and what is remembered ---------------------------------------------------

test("other traffic on the port is ignored without complaint", async () => {
  // A MIDI port carries clock, notes and every other device's dumps. Treating that as an error
  // would bury the errors that matter.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());
  const pending = session.request(Code.Device, deviceRequest);

  session.receive(Uint8Array.from([0xf0, 0x43, 0x00, 0x00, 0xf7])); // Yamaha
  session.receive(Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, 0x15, 0x00, 0xf7])); // an Elektron dump
  session.receive(Uint8Array.from([0xf8])); // clock
  assert.deepEqual(session.unmatched, [], "none of that is a protocol problem");
  assert.equal(session.pending, 1, "and none of it should have settled the request");

  session.receive(reply(fake.idsSent()[0]!, Code.Device, 43, 0, 0));
  await pending;
});

test("a reply to something we never asked is kept rather than dropped", () => {
  // It means either a timeout fired too early or two sessions are sharing a port. Both are worth
  // being able to see; both are invisible if unmatched frames are silently discarded.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());
  session.receive(reply(999, Code.Device, 43, 0, 0));
  assert.equal(session.unmatched.length, 1);
  assert.equal(session.unmatched[0]!.respId, 999);
});

// --- failure ------------------------------------------------------------------------------------

test("silence becomes a timeout naming what went unanswered", async () => {
  // The failure being guarded is not slowness but silence: a wrong port, an interface that drops
  // SysEx, or a message the device does not implement. All produce no reply at all, and without
  // this the promise simply never settles and the page hangs with no explanation.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());
  const pending = session.request(Code.Device, deviceRequest);
  fake.expireAll();
  await assert.rejects(pending, DeviceTimeout);
  assert.equal(session.pending, 0, "a timed-out request must not stay in flight");
});

test("a settled request cancels its timer", async () => {
  // Otherwise a long-lived session accumulates one live timer per request ever made, and in a
  // browser that is a leak nobody attributes to the MIDI layer.
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());
  const pending = session.request(Code.Device, deviceRequest);
  assert.equal(fake.liveTimers, 1);
  session.receive(reply(fake.idsSent()[0]!, Code.Device, 43, 0, 0));
  await pending;
  assert.equal(fake.liveTimers, 0);
});

test("closing fails everything outstanding rather than leaving it hanging", async () => {
  const fake = new Fake();
  const session = new DeviceSession(fake, fake.options());
  const a = session.request(Code.Device, deviceRequest);
  const b = session.request(Code.Version, versionRequest);

  session.close("the device was unplugged");
  await assert.rejects(a, SessionClosed);
  await assert.rejects(b, /unplugged/);
  assert.equal(session.pending, 0);
  await assert.rejects(session.request(Code.Device, deviceRequest), SessionClosed);
});

test("a transport that throws rejects the request instead of leaking it", async () => {
  const failing: Transport = {
    send() {
      throw new Error("port is not open");
    },
  };
  const fake = new Fake();
  const session = new DeviceSession(failing, fake.options());
  await assert.rejects(session.request(Code.Device, deviceRequest), /port is not open/);
  assert.equal(session.pending, 0);
});

// --- the multi-device requirement -----------------------------------------------------------

test("two sessions share nothing, so two devices cannot collide", async () => {
  // ROADMAP §3d: transfer mode reads a Digitone's catalogue while writing to a Digitone II, both
  // connected at once. elk-herd keeps its id counter and in-flight table at module level, so
  // this is the one place its design deliberately is not copied. A reply meant for one device
  // must never settle a request made to the other.
  const one = new Fake();
  const two = new Fake();
  const dn1 = new DeviceSession(one, one.options());
  const dn2 = new DeviceSession(two, two.options());

  const a = dn1.request(Code.Device, deviceRequest);
  const b = dn2.request(Code.Device, deviceRequest);
  assert.deepEqual(one.idsSent(), two.idsSent(), "both start at 1 — the ids are per session");

  // The DN2's reply, delivered to the DN1's session. Same id, different conversation.
  dn1.receive(reply(two.idsSent()[0]!, Code.Device, 43, 0, 0));
  const first = await a;
  assert.equal(first.body[0], 43);

  assert.equal(dn2.pending, 1, "the other session is untouched by it");
  dn2.receive(reply(two.idsSent()[0]!, Code.Device, 20, 0, 0));
  assert.equal((await b).body[0], 20);
});
