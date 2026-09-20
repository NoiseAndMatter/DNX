/**
 * Web MIDI as a `SysexPort`, and the port-name guessing that only a browser needs.
 *
 * ## What is here and what is not
 *
 * The rule for correlating one reply with one request lives in `src/device/link.ts` and knows
 * nothing about MIDI. It was written here, against `MIDIInput` and `MIDIOutput`, which meant a
 * second host could not use it. What is left here is the part that is genuinely Web MIDI:
 * attaching a `midimessage` listener, opening a port that is not open, and guessing which input
 * belongs with which output from the names the OS gave them.
 *
 * `DeviceLink` still takes two ports and still answers `awaitReply`, `awaitApiFrame` and
 * `transport`, so every caller reads as it did. What it adds to the core link is the adapter and
 * this page's other-traffic counter.
 */

import { noteReply } from "./othertraffic.js";
import { SysexLink } from "../../src/device/link.js";
import { type SysexPort } from "../../src/device/port.js";

export { type AwaitOptions, matchApiFrame } from "../../src/device/link.js";

/** How long `.open()` on a closed port gets before a wait gives up rather than hangs. */
const OPEN_TIMEOUT_MS = 2000;

/**
 * A pair of Web MIDI ports as one `SysexPort`.
 *
 * The MIDI port itself is never closed, only its listeners dropped. A page holds one input for
 * several conversations at once, and shutting the port under the others is a larger claim than
 * "this link is finished with it".
 */
export class WebMidiPort implements SysexPort {
  private readonly stops = new Set<() => void>();

  constructor(
    readonly input: MIDIInput,
    readonly output: MIDIOutput,
  ) {}

  send(bytes: Uint8Array): void {
    this.output.send([...bytes]);
  }

  subscribe(listener: (bytes: Uint8Array) => void): () => void {
    const onMessage = (event: MIDIMessageEvent): void => {
      if (event.data) listener(new Uint8Array(event.data));
    };
    this.input.addEventListener("midimessage", onMessage);
    const stop = (): void => {
      this.input.removeEventListener("midimessage", onMessage);
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }

  close(): void {
    for (const stop of [...this.stops]) stop();
  }

  /**
   * Open the input if it is shut, and say so synchronously when it is not.
   *
   * **A closed input delivers nothing, and looks exactly like a device that never answered.**
   * `addEventListener` does not open a port, so a wait must not be attached to one that cannot
   * hear.
   *
   * But **only when there is something to open.** Opening unconditionally stalled both write tests
   * on hardware: `writeBack` and `writeToChosenSlot` refuse to run unless Listen is already active,
   * so their read-backs always called `.open()` on an already-open port, and the wait sat there
   * with no verdict. The caller's timeout is armed *after* this, so while the open call was
   * outstanding nothing existed to report the delay — the card showed "Write in progress" rather
   * than "NOT verified — yet", because the 5,000ms timer had not started.
   *
   * That an already-open `.open()` is what delayed it is **inferred**: what was measured is that
   * the stall sat before the timer, and that one run resolved with a full-length reply once it
   * cleared. Returning `undefined` here removes the suspect, and removes the await with it.
   *
   * The genuinely-closed path keeps its own ceiling, because a promise that does not know how to
   * fail is worse than one that fails fast — the same defect one level down.
   */
  ready(): Promise<void> | undefined {
    if (this.input.connection === "open") return undefined;
    return (async () => {
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
        throw new Error(
          `could not open ${this.input.name ?? "the input port"} within ${OPEN_TIMEOUT_MS}ms`,
        );
      }
    })();
  }
}

/**
 * One request, one reply, on a pair of Web MIDI ports.
 *
 * `input` and `output` stay as fields because callers send through them directly: the probe builds
 * its own request bytes and hands them to `output.send` inside an `awaitReply`.
 */
export class DeviceLink extends SysexLink {
  constructor(
    readonly input: MIDIInput,
    readonly output: MIDIOutput,
  ) {
    // `noteReply` is wired in here rather than inside the correlation, because what it feeds is a
    // warning strip on this page. Every API reply any page sees passes through `awaitApiFrame`,
    // so this is the one place it has to be done. See `othertraffic.ts`.
    super(new WebMidiPort(input, output), { noteReply });
  }
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
