/**
 * One request, one reply, on a MIDI port that carries other people's traffic.
 *
 * ## The problem this exists for
 *
 * A Digitone volunteers API messages the moment a port opens, and Elektron Transfer polls the same
 * port continuously if it is running. So **"the next message to arrive" is regularly somebody
 * else's**, and a wait that accepts it will report a stranger's answer as ours. That has already
 * produced one false finding: a `0xd3` from Transfer read as the reply to our own request.
 *
 * Two rules follow, and both are the substance of this module rather than detail:
 *
 * 1. **Match on the message id**, not on the response code. The code says what kind of answer it
 *    is; only the id says whose.
 * 2. **One listener per request, removed on the way out.** The probe page used a single
 *    module-global `awaitingReply` slot shared by seven independent request paths, and two
 *    overlapping reads stole each other's answers — its own comments record paying for that twice.
 *    A waiter that owns its listener cannot be overwritten by the next caller.
 *
 * ## Why a class rather than a function
 *
 * A link is a pair of ports plus the rule for correlating traffic across them. Every caller needs
 * all three, and the two implementations that existed — one here, one on the probe page — differed
 * in exactly the part that matters. One home means the next request path cannot get it wrong.
 */

import { decodeMessage, isApiMessage, type ApiFrame } from "../../src/device/api.js";
import { type ApiTransport } from "../../src/device/storagesession.js";

/** How long `.open()` on a closed port gets before a wait gives up rather than hangs. */
const OPEN_TIMEOUT_MS = 2000;

/** How a caller waits for one reply. */
export interface AwaitOptions<T> {
  /**
   * Send the request. Called **after** the listener is attached, so a device that answers
   * immediately cannot beat the wait.
   */
  send: () => void;
  /**
   * Decide whether this message is the answer. Return a value to finish the wait, or `undefined`
   * to ignore the message and keep waiting.
   */
  match: (data: Uint8Array) => T | undefined;
  timeoutMs: number;
  /** Called when `send` throws. The wait then finishes as `undefined`. */
  onSendError?: (error: unknown) => void;
  /**
   * Called when the input port could not be opened. The wait finishes as `undefined` and
   * **nothing is sent**.
   *
   * Separate from `onSendError` deliberately. Reporting this through that hook put "could not open
   * the port" under a caller's *"Send failed"* heading, describing a send that never happened — and
   * an error names what failed, not what was wanted. Callers that do not care may omit it; they
   * still get `undefined` rather than a hang.
   */
  onOpenError?: (error: Error) => void;
  /**
   * Keep listening after the timeout, and call this if the answer turns up late.
   *
   * **A late answer is an answer.** Without this, a reply that missed the wait used to arrive,
   * trigger a redraw and wipe the verdict — which is how a slow but successful write came to look
   * like a control that does nothing.
   */
  onLate?: (value: T) => void;
}

export class DeviceLink {
  constructor(
    readonly input: MIDIInput,
    readonly output: MIDIOutput,
  ) {}

  /**
   * Send, and wait for the one message that matches. Resolves `undefined` on timeout or a failed
   * send — a silence is a normal outcome here, not an exception.
   *
   * The listener belongs to this call alone. Two of these may be in flight at once without either
   * seeing the other's traffic, which is the whole point.
   */
  async awaitReply<T>(options: AwaitOptions<T>): Promise<T | undefined> {
    const { send, match, timeoutMs, onSendError, onOpenError, onLate } = options;

    // **A closed input delivers nothing, and looks exactly like a device that never answered.**
    // `addEventListener` does not open a port, so a wait must not be attached to one that cannot
    // hear.
    //
    // But **only when there is something to open.** Opening unconditionally stalled both write
    // tests on hardware: `writeBack` and `writeToChosenSlot` refuse to run unless Listen is already
    // active, so their read-backs always called `.open()` on an already-open port, and the wait sat
    // there with no verdict. The timeout below is armed *after* this await, so while the open call
    // was outstanding nothing existed to report the delay — the card showed "Write in progress"
    // rather than "NOT verified — yet", because the 5,000ms timer had not started.
    //
    // That an already-open `.open()` is what delayed it is **inferred**: what was measured is that
    // the stall sat before the timer, and that one run resolved with a full-length reply once it
    // cleared. Skipping the call when the port is open removes the suspect either way.
    //
    // The genuinely-closed path keeps its own ceiling, because a promise that does not know how to
    // fail is worse than one that fails fast — the same defect one level down.
    if (this.input.connection !== "open") {
      let ceiling: ReturnType<typeof setTimeout> | undefined;
      const opened = await Promise.race([
        this.input.open().then(() => true),
        new Promise<boolean>((resolve) => {
          ceiling = setTimeout(() => resolve(false), OPEN_TIMEOUT_MS);
        }),
      ]);
      // Cleared on both paths: a race leaves the loser running, and a stray two-second timer per
      // wait is exactly the kind of thing this module exists to not do.
      clearTimeout(ceiling);
      if (!opened) {
        onOpenError?.(
          new Error(`could not open ${this.input.name ?? "the input port"} within ${OPEN_TIMEOUT_MS}ms`),
        );
        return undefined;
      }
    }

    return new Promise<T | undefined>((resolve) => {
      let settled = false;

      const detach = (): void => {
        this.input.removeEventListener("midimessage", onMessage);
      };

      const timer = setTimeout(() => {
        settled = true;
        // Without `onLate` the wait is over and the listener goes. With it, we stay on the port for
        // an answer that is merely slow.
        if (!onLate) detach();
        resolve(undefined);
      }, timeoutMs);

      const onMessage = (event: MIDIMessageEvent): void => {
        if (!event.data) return;
        const value = match(new Uint8Array(event.data));
        if (value === undefined) return;

        if (settled) {
          detach();
          onLate?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        detach();
        resolve(value);
      };

      this.input.addEventListener("midimessage", onMessage);

      try {
        send();
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        detach();
        onSendError?.(error);
        resolve(undefined);
      }
    });
  }

  /**
   * Wait for the API frame answering `msgId`.
   *
   * Anything that is not a well-formed API message, or answers a different id, is ignored rather
   * than rejected — it belongs to whoever else is on the port.
   */
  awaitApiFrame(msgId: number, options: Omit<AwaitOptions<ApiFrame>, "match">): Promise<ApiFrame | undefined> {
    return this.awaitReply<ApiFrame>({
      ...options,
      match: (data) => matchApiFrame(data, (frame) => frame.respId === msgId),
    });
  }

  /**
   * This link as an `ApiTransport`, for the +Drive code in `src/device/`.
   *
   * The transport contract is to reject on silence, where `awaitReply` resolves `undefined` — so
   * the error is built here. `onSend` lets a page note the id as its own **before** the bytes go
   * out: omitting that is why a capture of 6,404 of our own reads was once labelled "not ours".
   */
  transport(options: { onSend?: (msgId: number) => void; timeoutError?: (msgId: number, ms: number) => Error } = {}): ApiTransport {
    return {
      request: async (request: Uint8Array, msgId: number, timeoutMs: number): Promise<ApiFrame> => {
        options.onSend?.(msgId);
        let sendError: unknown;
        const frame = await this.awaitApiFrame(msgId, {
          send: () => this.output.send([...request]),
          timeoutMs,
          onSendError: (error) => {
            sendError = error;
          },
        });
        if (sendError) throw sendError instanceof Error ? sendError : new Error(String(sendError));
        if (!frame) {
          throw (
            options.timeoutError?.(msgId, timeoutMs) ??
            new Error(`no reply to 0x${msgId.toString(16)} within ${timeoutMs}ms`)
          );
        }
        return frame;
      },
    };
  }
}

/**
 * Decode an API message and test it, or `undefined` for anything that is not one.
 *
 * Exported because pages match on more than the id — a response code, a dump type, an object
 * number — and every one of them needs the same "is this even ours to read" guard first.
 */
export function matchApiFrame(data: Uint8Array, accept: (frame: ApiFrame) => boolean): ApiFrame | undefined {
  if (!isApiMessage(data)) return undefined;
  let frame: ApiFrame;
  try {
    frame = decodeMessage(data);
  } catch {
    return undefined;
  }
  return accept(frame) ? frame : undefined;
}

/**
 * The input and output most likely to be the same instrument.
 *
 * Ports are named by the OS and a device usually shows up twice with the same prefix. Longest
 * shared prefix wins, which is how "Digitone II MIDI 1" finds "Digitone II MIDI 1" rather than
 * whatever else is plugged in.
 */
export function bestPair(
  inputs: MIDIInput[],
  outputs: MIDIOutput[],
): { input: MIDIInput; output: MIDIOutput } {
  let best = { input: inputs[0]!, output: outputs[0]!, score: -1 };
  for (const output of outputs) {
    for (const input of inputs) {
      const score = sharedPrefix(input.name ?? "", output.name ?? "");
      if (score > best.score) best = { input, output, score };
    }
  }
  return { input: best.input, output: best.output };
}

/** Length of the shared prefix of two strings. */
export function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
