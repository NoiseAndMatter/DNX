/**
 * One request, one reply, on a port that carries other people's traffic.
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
 * A link is a port plus the rule for correlating traffic on it. Every caller needs both, and the
 * two implementations that existed, one in the browser layer and one on the probe page, differed
 * in exactly the part that matters. One home means the next request path cannot get it wrong.
 *
 * ## Why it is here rather than in the browser layer
 *
 * This was written against `MIDIInput` and `MIDIOutput`, so a second host could not use it and
 * would have had to re-implement msgId matching. It needs nothing from Web MIDI beyond bytes in,
 * bytes out and a way to stop listening, which is `SysexPort`. The Web MIDI adapter and the
 * port-name matching stay in `web/src/devicelink.ts`, where they belong.
 */

import { decodeMessage, isApiMessage, type ApiFrame } from "./api.js";
import { type SysexPort } from "./port.js";
import { type ApiTransport } from "./storagesession.js";

/**
 * How much later than its deadline a timer may fire before the page is assumed to have been asleep.
 *
 * Ordinary jitter is milliseconds. A starved or suspended page is seconds to minutes — a 321ms
 * settle on the probe page has been measured taking 246s. A second of slack sits far above the
 * first and far below the second, so a busy page is not misread as a stopped one.
 */
const SUSPENSION_SLACK_MS = 1000;

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
   * Called when the port could not be made ready. The wait finishes as `undefined` and
   * **nothing is sent**.
   *
   * Separate from `onSendError` deliberately. Reporting this through that hook put "could not open
   * the port" under a caller's *"Send failed"* heading, describing a send that never happened — and
   * an error names what failed, not what was wanted. Callers that do not care may omit it; they
   * still get `undefined` rather than a hang.
   */
  onOpenError?: (error: Error) => void;
  /**
   * Called when the timeout fired so late that the page cannot have been running, with how long it
   * actually took. The wait re-arms rather than concluding anything; this exists so a caller can
   * say so.
   */
  onSuspicion?: (elapsedMs: number) => void;
  /** The clock, injectable so the late-timer path can be tested without stopping anything. */
  now?: () => number;
  /**
   * Keep listening after the timeout, and call this if the answer turns up late.
   *
   * **A late answer is an answer.** Without this, a reply that missed the wait used to arrive,
   * trigger a redraw and wipe the verdict — which is how a slow but successful write came to look
   * like a control that does nothing.
   */
  onLate?: (value: T) => void;
}

export interface SysexLinkOptions {
  /**
   * Told the `respId` of every API frame that goes past, ours or not.
   *
   * Injected rather than imported because the thing that wants it is the browser layer's
   * other-traffic warning, which counts replies to ids DNX never issued and puts a strip on the
   * page. That is a host's business. This is the one place a decoded API frame exists for every
   * page that talks to an instrument, which is why the hook is here and not in each caller.
   */
  noteReply?: (respId: number | undefined) => void;
}

export class SysexLink {
  constructor(
    readonly port: SysexPort,
    private readonly linkOptions: SysexLinkOptions = {},
  ) {}

  /**
   * Send, and wait for the one message that matches. Resolves `undefined` on timeout or a failed
   * send — a silence is a normal outcome here, not an exception.
   *
   * The listener belongs to this call alone. Two of these may be in flight at once without either
   * seeing the other's traffic, which is the whole point.
   */
  async awaitReply<T>(options: AwaitOptions<T>): Promise<T | undefined> {
    const { send, match, timeoutMs, onSendError, onOpenError, onLate, onSuspicion } = options;
    const now = options.now ?? Date.now;

    // **A port that cannot hear delivers nothing, and looks exactly like a device that never
    // answered.** Subscribing does not open anything, so a wait must not be attached to a port in
    // that state.
    //
    // Asked for synchronously, and awaited only if there is genuinely something to wait for. A
    // port that can already hear returns `undefined` here and this whole block costs no async gap,
    // which is load-bearing rather than tidy: see `SysexPort.ready`, and the ordering the
    // transport tests pin below.
    const opening = this.port.ready?.();
    if (opening) {
      try {
        await opening;
      } catch (error) {
        onOpenError?.(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      }
    }

    return new Promise<T | undefined>((resolve) => {
      let settled = false;
      let stop: (() => void) | undefined;

      const detach = (): void => {
        stop?.();
        stop = undefined;
      };

      /**
       * **A timer that fired far later than it was set for tells you nothing about the device.**
       *
       * A backgrounded tab is throttled and eventually suspended, and on resume both the overdue
       * timer and any queued message become runnable — in an order nobody promises. So a page that
       * was asleep can declare "no reply within 5,000ms" while the reply is already sitting in the
       * queue behind it, and report a working instrument as a silent one.
       *
       * That is not hypothetical here: a 321ms settle on the probe page was measured taking 152.8s,
       * which is a page that was not running rather than an instrument that was slow.
       *
       * So the timeout asks the clock, not the timer. Fired roughly on time, it means silence.
       * Fired impossibly late, it means we were asleep — and the device is given one fair hearing
       * while we are actually awake before anything is concluded. Once only: twice would be a
       * wait that never ends.
       */
      let armedAt = now();
      let rearmed = false;
      let timer: ReturnType<typeof setTimeout>;

      const expire = (): void => {
        const elapsed = now() - armedAt;
        if (!rearmed && elapsed > timeoutMs + Math.max(timeoutMs, SUSPENSION_SLACK_MS)) {
          rearmed = true;
          armedAt = now();
          // **Re-armed before the caller is told, not after.** A caller that reacts inside
          // `onSuspicion` — the obvious one being "the reply arrived, resolve now" — would otherwise
          // finish the wait and then have a fresh timer scheduled behind it, firing into a settled
          // promise and detaching a listener somebody else may be using. Scheduling first means
          // `onMessage` clears the timer that is actually pending.
          timer = setTimeout(expire, timeoutMs);
          onSuspicion?.(elapsed);
          return;
        }
        settled = true;
        // Without `onLate` the wait is over and the listener goes. With it, we stay on the port for
        // an answer that is merely slow.
        if (!onLate) detach();
        resolve(undefined);
      };

      timer = setTimeout(expire, timeoutMs);

      const onMessage = (data: Uint8Array): void => {
        const value = match(data);
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

      stop = this.port.subscribe(onMessage);

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
      /*
       * **Every API frame that arrives is counted on the way past**, here rather than in a second
       * decode, because this predicate already holds the decoded frame and a project read is about
       * 6,300 of them. The hook ignores anything in the page's own id range; what it keeps is a
       * reply to an id below the allocator's floor, which cannot be ours. See `othertraffic.ts`.
       */
      match: (data) =>
        matchApiFrame(data, (frame) => {
          this.linkOptions.noteReply?.(frame.respId);
          return frame.respId === msgId;
        }),
    });
  }

  /**
   * This link as an `ApiTransport`, for the +Drive code in `src/device/`.
   *
   * The transport contract is to reject on silence, where `awaitReply` resolves `undefined` — so
   * the error is built here. `onSend` lets a caller note the id as its own **before** the bytes go
   * out: omitting that is why a capture of 6,404 of our own reads was once labelled "not ours".
   */
  transport(options: { onSend?: (msgId: number) => void; timeoutError?: (msgId: number, ms: number) => Error } = {}): ApiTransport {
    return {
      request: async (request: Uint8Array, msgId: number, timeoutMs: number): Promise<ApiFrame> => {
        options.onSend?.(msgId);
        let sendError: unknown;
        const frame = await this.awaitApiFrame(msgId, {
          send: () => this.port.send(request),
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
