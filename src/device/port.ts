/**
 * The one thing a host has to implement for DNX to talk to an instrument.
 *
 * ## Why this interface and not the three we had
 *
 * Before this there were three transport shapes: `Transport { send }` for identify, `DeviceIo`
 * plus a module-global registry for the active project, and `ApiTransport { request }` for the
 * +Drive. A host that implemented `ApiTransport` would get the +Drive and nothing else, and a host
 * that implemented `DeviceIo` had to reach back into core and call an exported `deliver` to hand
 * messages in, which is a registry of listeners keyed by object identity and is exactly the
 * module-level mutable state core is not allowed to keep.
 *
 * A port is the smallest thing that covers all three: bytes out, bytes in, and a way to stop.
 * `ApiTransport`, `DeviceIo` and the session are all built on top of it inside core, so the msgId
 * correlation in `link.ts` is written once rather than re-implemented per host. That correlation
 * has produced a false finding before, a `0xd3` from Elektron Transfer read as the reply to our
 * own request, and it is not a thing to write twice.
 *
 * Nothing here is browser-shaped. Web MIDI, a Kotlin MIDI plugin and a test fake are all the same
 * three methods.
 */

export interface SysexPort {
  /** Put one complete SysEx message on the wire. */
  send(bytes: Uint8Array): void;
  /**
   * Hear everything arriving on the port, including traffic that is not ours.
   *
   * Filtering is the caller's job, because only the caller knows what it asked for. Returns the
   * function that stops this listener, and nothing else: a subscription that can only be cancelled
   * by identity is how the registry this replaced managed to hold one listener per port and let
   * two overlapping readers steal each other's replies.
   *
   * More than one listener may be active at once, and each must get its own copy of the bytes.
   * Two waits in flight is the normal case, not the exception.
   */
  subscribe(listener: (bytes: Uint8Array) => void): () => void;
  /** Drop every listener this port handed out. Sending afterwards is the host's business. */
  close(): void;
  /**
   * Make the port able to hear, or `undefined` when it already can.
   *
   * **Returning `undefined` rather than a resolved promise is the contract, not an optimisation.**
   * A wait that awaits anything at all before sending has an async gap in it, and on real hardware
   * that gap cost a write its verdict: Web MIDI's `open()` on an already-open input did not settle
   * promptly, the wait's own timeout is armed after this point, and a write that had landed on the
   * device sat in "Write in progress" with nothing to report the delay. So a port that can already
   * hear must say so synchronously.
   *
   * Optional because a host whose port is always live has nothing to do here. A rejection reaches
   * the caller's `onOpenError` and **nothing is sent**.
   */
  ready?(): Promise<void> | undefined;
}
