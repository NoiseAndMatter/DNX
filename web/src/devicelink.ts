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
    const { send, match, timeoutMs, onSendError, onOpenError, onLate, onSuspicion } = options;
    const now = options.now ?? Date.now;

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

      /**
       * **A timer that fired far later than it was set for tells you nothing about the device.**
       *
       * A backgrounded tab is throttled and eventually suspended, and on resume both the overdue
       * timer and any queued `midimessage` become runnable — in an order nobody promises. So a
       * page that was asleep can declare "no reply within 5,000ms" while the reply is already
       * sitting in the queue behind it, and report a working instrument as a silent one.
       *
       * That is not hypothetical here: a 321ms settle on this page was measured taking 152.8s,
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

/** An input and an output guessed to be the same instrument. */
export interface PortPair {
  input: MIDIInput;
  output: MIDIOutput;
}

/**
 * Every plausible instrument on the ports, best guess first.
 *
 * ## Why one pair is not enough
 *
 * `bestPair` answers *"which single pair is most likely?"*, and that is the wrong question the
 * moment two instruments are plugged in — which is the expander's whole premise: a Digitone 1 to
 * read from and a Digitone II to write to, at the same time. Asking for the best pair returns one
 * of them arbitrarily, and there is no way to say which one you wanted.
 *
 * So this returns **all** of them, and the caller asks each who it is. Nothing in Web MIDI says
 * which ports belong together or what is behind them; the only authority on either question is the
 * device's own `Device` reply, and you cannot get one without picking a pair to ask on.
 *
 * ## How they are grouped
 *
 * One pair per output, matched to the input sharing the longest name prefix — the OS names both
 * ends of an instrument alike, so "Digitone II MIDI 1" finds its twin rather than whatever else is
 * connected. Ordered by that score, so the most confident guess is probed first and a single
 * connected device costs exactly one request.
 *
 * A pair whose two ends share nothing is still returned, last. On a machine where the naming
 * convention does not hold, a poor guess that can be tested beats no guess at all.
 */
export function candidatePairs(inputs: MIDIInput[], outputs: MIDIOutput[]): PortPair[] {
  const scored: { pair: PortPair; score: number }[] = [];

  for (const output of outputs) {
    let best: { input: MIDIInput; score: number } | undefined;
    for (const input of inputs) {
      const score = sharedPrefix(input.name ?? "", output.name ?? "");
      if (!best || score > best.score) best = { input, score };
    }
    if (best) scored.push({ pair: { input: best.input, output }, score: best.score });
  }

  // Highest score first, and stable within a score so the order is reproducible rather than
  // dependent on how the browser happened to enumerate the ports.
  return scored
    .map((entry, at) => ({ ...entry, at }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((entry) => entry.pair);
}

/**
 * The pair most likely to be one instrument, or `undefined` when the names give no reason to think
 * any two ports belong together.
 *
 * **No shared prefix means no guess.** Returning the first of each list would be a guess dressed as
 * a fact, and the probe — which shows its guess in two selects the user can override — has always
 * refused to make it. That rule lives here now rather than in a fourth copy of the scoring.
 */
export function bestPair(inputs: MIDIInput[], outputs: MIDIOutput[]): PortPair | undefined {
  const best = candidatePairs(inputs, outputs)[0];
  if (!best) return undefined;
  return sharedPrefix(best.input.name ?? "", best.output.name ?? "") > 0 ? best : undefined;
}

/** Length of the shared prefix of two strings. */
export function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
