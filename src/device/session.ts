/**
 * One conversation with one device.
 *
 * The transport is injected, so this holds no WebMIDI and can be tested without hardware — which
 * matters more here than usual, because a protocol bug found at the device costs a session and
 * the same bug found here costs a minute.
 *
 * ## One of these per device, never one for "the device"
 *
 * `docs/ROADMAP.md` §3d requires WebMIDI be **multi-device from the start**: transfer mode reads
 * a Digitone's catalogue while writing to a Digitone II, both connected at once, each with its
 * own identity, firmware and storage versions. elk-herd is single-instrument by design — its
 * message ids, in-flight table and connection state are all module-level — so it is a guide to
 * the wire format and explicitly **not** to this layer.
 *
 * Everything that would have been global is a field here instead: the id counter, the in-flight
 * table, the timeout. Two sessions cannot collide because they share nothing. That is the whole
 * design, and it is easier to get right now than to retrofit later.
 *
 * ## Ids start at 1
 *
 * A response carries the id it answers in `respId`, and **zero means "this is a request"** — so
 * a request numbered 0 would be answered by something indistinguishable from a fresh request.
 * The counter therefore starts at 1 and skips 0 when it wraps.
 */

import {
  type ApiFrame,
  RESPONSE_BIT,
  decodeMessage,
  isApiMessage,
} from "./api.js";

/** Whatever can put bytes on the wire. A `MIDIOutput`, or a fake in a test. */
export interface Transport {
  send(bytes: Uint8Array): void;
}

export class DeviceTimeout extends Error {}
export class SessionClosed extends Error {}

/** The id field is a u16, and 0 is reserved to mean "not a response". */
const MAX_ID = 0xffff;

export interface SessionOptions {
  /**
   * How long to wait for a reply.
   *
   * Two seconds because a device that is present answers a `Device` request in milliseconds,
   * while one that is busy writing to the +Drive can take noticeably longer. The failure this
   * guards is not slowness but silence — a wrong port, a MIDI interface that does not pass
   * SysEx, or a request the device does not implement, all of which produce no reply at all.
   */
  timeoutMs?: number;
  /** Injectable so tests need no real clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface InFlight {
  /** The response code we will accept: the request's code with the response bit set. */
  expect: number;
  resolve: (frame: ApiFrame) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export class DeviceSession {
  private nextId = 1;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private closed = false;

  /**
   * Frames that arrived answering nothing we asked.
   *
   * Kept rather than dropped: a reply to an id we have forgotten means a timeout fired too
   * early, and a reply to an id we never sent means two sessions are sharing a port. Both are
   * worth being able to see, and both are invisible if unmatched frames are silently discarded.
   */
  readonly unmatched: ApiFrame[] = [];

  constructor(
    private readonly transport: Transport,
    options: SessionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** How many requests are waiting for a reply. */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Send a request and wait for its reply.
   *
   * `build` takes the id rather than the caller allocating one, because an id used twice is a
   * reply delivered to the wrong caller — a bug that looks like corrupt data rather than like a
   * bookkeeping mistake.
   */
  request(code: number, build: (msgId: number) => Uint8Array): Promise<ApiFrame> {
    if (this.closed) return Promise.reject(new SessionClosed("this session has been closed"));

    const msgId = this.allocate();
    return new Promise<ApiFrame>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.inFlight.delete(msgId);
        reject(
          new DeviceTimeout(
            `no reply to message ${msgId} (code 0x${code.toString(16)}) after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      this.inFlight.set(msgId, { expect: code | RESPONSE_BIT, resolve, reject, timer });

      try {
        this.transport.send(build(msgId));
      } catch (error) {
        this.settle(msgId, (f) => f.reject(error as Error));
      }
    });
  }

  /**
   * Hand the session one incoming SysEx message.
   *
   * Anything that is not an Elektron API message is ignored outright and not recorded: a MIDI
   * port carries clock, notes and every other device's dumps, so treating that traffic as a
   * problem would bury the ones that are.
   */
  receive(sysex: Uint8Array): void {
    if (!isApiMessage(sysex)) return;

    let frame: ApiFrame;
    try {
      frame = decodeMessage(sysex);
    } catch {
      return; // malformed, or a variant we do not speak — not ours to complain about
    }

    if (frame.respId === undefined) return; // a request from the device; nothing asked for it
    const waiting = this.inFlight.get(frame.respId);
    if (!waiting) {
      this.unmatched.push(frame);
      return;
    }

    // A reply with the wrong code for the id it names is worse than no reply: acting on it would
    // parse one message's arguments with another message's reader.
    if (frame.code !== waiting.expect) {
      this.settle(frame.respId, (f) =>
        f.reject(
          new Error(
            `message ${frame.respId} expected code 0x${waiting.expect.toString(16)} ` +
              `but the device answered with 0x${frame.code.toString(16)}`,
          ),
        ),
      );
      return;
    }

    this.settle(frame.respId, (f) => f.resolve(frame));
  }

  /** Fail everything outstanding. Safe to call twice. */
  close(reason = "the session was closed"): void {
    this.closed = true;
    for (const msgId of [...this.inFlight.keys()]) {
      this.settle(msgId, (f) => f.reject(new SessionClosed(reason)));
    }
  }

  private settle(msgId: number, finish: (entry: InFlight) => void): void {
    const entry = this.inFlight.get(msgId);
    if (!entry) return;
    this.inFlight.delete(msgId);
    this.clearTimer(entry.timer);
    finish(entry);
  }

  /** Next free id, skipping 0 and anything still outstanding. */
  private allocate(): number {
    for (let tried = 0; tried < MAX_ID; tried++) {
      const id = this.nextId;
      this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
      if (!this.inFlight.has(id)) return id;
    }
    throw new Error("no free message id: 65,535 requests are outstanding");
  }
}
