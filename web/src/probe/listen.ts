/**
 * Listening: the half of the transport that sends nothing.
 *
 * The Digitone dumps from its own front panel, so this half can be proven with the safety question
 * entirely absent — which is why it was built before anything that transmits. The bytes are saved
 * verbatim as a `.syx`, the same form as the corpus captures, so every existing tool works on the
 * result the moment it lands.
 *
 * ## It is also the page's one inbound path
 *
 * Everything else here transmits and then waits for the answer to arrive **through this listener**:
 * requests, project reads and the read-back after a write all land in the same capture. That is why
 * every send first checks that Listen is running (see `ready.ts`), and why a project read hands the
 * listener a sink rather than the listener knowing what a read is.
 *
 * ## The repaint throttle is load-bearing
 *
 * Redrawing per message once blocked the main thread for 56.4 seconds during a single write. MIDI
 * events are dispatched back to back, so nothing — no timer, no promise, no repaint — gets a turn
 * until the queue drains. See `REPAINT_MS`.
 */

import { renderCapture as drawCapture } from "./cards.js";
import { SPINNER, status } from "./chrome.js";
import { access, issuedIds, ports } from "./link.js";
import { $ } from "../dom.js";
import { captureFileName, type CaptureSummary, DumpCapture } from "../../../src/device/capture.js";
import { parseMessage, rebuildMessage, splitMessages } from "../../../src/sysex/container.js";
import { matchApiFrame } from "../devicelink.js";
import { saveBytesTo, savedTone, whereSaved } from "../dnxfolder.js";
import { noteReply } from "../othertraffic.js";

/**
 * Capture whatever the device chooses to send.
 *
 * **Sends nothing.** The Digitone dumps from its own front panel, so this half of the transport
 * can be proven with the safety question entirely absent — which is why it is built before
 * anything that transmits. The bytes are saved verbatim as a `.syx`, which is the same form as
 * the corpus captures, so every existing tool works on the result the moment it lands.
 */
export const capture = new DumpCapture();
let listening: { input: MIDIInput; onMessage: (event: MIDIMessageEvent) => void } | undefined;

/**
 * Draw the capture into this page's results area.
 *
 * The drawing itself lives in `cards.ts`; this supplies what only the page knows — where to put
 * it, whether we are still listening, and which message ids this page issued.
 */
export function renderCapture(): CaptureSummary {
  const summary = capture.summarise();
  return drawCapture($("results"), summary, { listening: listening !== undefined, issuedIds });
}

/**
 * How often the capture may redraw while messages are pouring in.
 *
 * Fast enough to look live, slow enough that a flood cannot starve the page. The failure it
 * prevents was not subtle: 56.4 seconds of blocked main thread for one write.
 */
const REPAINT_MS = 250;

let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Whether Listen is running, which is what every send on this page checks before transmitting. */
export function isListening(): boolean {
  return listening !== undefined;
}

/**
 * Where arriving bytes go while something else is driving.
 *
 * **The reader registers itself, rather than the listener knowing about reads.** A project read
 * narrates its own progress and owns the results area while it runs, so re-rendering the capture
 * on every message would tear down what it is drawing. The bytes reach the capture either way,
 * which is the part that must not depend on the UI.
 */
let inbound: ((data: Uint8Array) => void) | undefined;

/** Take the arriving bytes, until the caller hands them back with `undefined`. */
export function setInboundSink(sink: ((data: Uint8Array) => void) | undefined): void {
  inbound = sink;
}

export function stopListening(): void {
  if (!listening) return;
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  listening.input.removeEventListener("midimessage", listening.onMessage);
  listening = undefined;
  $("listen").textContent = "Listen";
  $<HTMLButtonElement>("probe").disabled = false;
  renderCapture();
  status(
    capture.isEmpty
      ? "Nothing arrived. Trigger the dump from the device: SETTINGS > SYSEX DUMP > SYSEX SEND."
      : `Stopped. ${capture.byteLength.toLocaleString()} bytes captured — press Save capture.`,
    capture.isEmpty ? "warn" : "ok",
  );
}

export async function startListening(): Promise<void> {
  if (!access) return;
  const input = ports.input(access);
  if (!input) {
    status("That input is no longer there. Press Rescan.", "error");
    return;
  }

  // Explicitly, for the same reason the probe does: `addEventListener` does not open a port, and
  // a closed one delivers nothing while looking exactly like a device that never sent.
  try {
    await input.open();
  } catch (error) {
    status(`Could not open ${input.name}: ${error}`, "error");
    return;
  }

  capture.clear();
  let ticks = 0;
  let lastAt = 0;
  const onMessage = (event: MIDIMessageEvent): void => {
    if (!event.data) return;
    const data = new Uint8Array(event.data);
    capture.add(data);
    lastAt = Date.now();

    /*
     * **Listen is where another application is most visible**, because it is the one mode that
     * hears a port nobody here is driving. The other pages count replies inside
     * `awaitApiFrame`, which only runs while DNX is waiting for one of its own; a probe sitting
     * idle on a shared port would see Transfer's whole conversation and say nothing.
     */
    matchApiFrame(data, (frame) => {
      noteReply(frame.respId);
      return false;
    });

    // A read drives its own narration and owns the results area while it runs, so re-rendering
    // the capture on every message would tear down the progress it is drawing. The bytes are
    // already in the capture either way, which is the part that must not depend on the UI.
    if (inbound) {
      inbound(data);
      return;
    }
    repaint();
  };

  /**
   * Redraw at most once every `REPAINT_MS`, however many messages arrive.
   *
   * **This is the write stall.** The listener used to call `renderCapture()` per message, and the
   * status line under it called `summarise()` a second time — so every arriving message parsed the
   * entire capture twice. Measured on hardware: 7,279 messages arrived during one write, the main
   * thread was blocked for **56.4 seconds in one go**, and two interval ticks got through in that
   * time. A 321ms settle took the whole of it.
   *
   * MIDI events are dispatched back to back, so nothing else — no timer, no promise, no repaint —
   * gets a turn until the queue drains. Coalescing turns thousands of full re-parses into one, and
   * a burst that blocks the page becomes a burst the page reads through.
   *
   * The trailing redraw matters as much as the throttle: when the flood ends, the last messages
   * must still be shown, and a leading-edge-only throttle would leave the count stale.
   */
  let repaintAt = 0;
  let repaintQueued: ReturnType<typeof setTimeout> | undefined;
  const draw = (): void => {
    repaintAt = Date.now();
    repaintQueued = undefined;
    const summary = renderCapture();
    // A project dump is minutes of silence punctuated by a message every so often, and a static
    // byte count during that gap is indistinguishable from a stall. The spinner advances and the
    // message count rises, so *something moving* is visible without comparing two numbers a
    // minute apart. Uses the summary the render already computed rather than asking again.
    status(
      `${SPINNER[ticks++ % SPINNER.length]}  receiving — ` +
        `${summary.bytes.toLocaleString()} bytes, ${summary.messages} message(s)`,
    );
  };
  const repaint = (): void => {
    if (repaintQueued !== undefined) return;
    const due = REPAINT_MS - (Date.now() - repaintAt);
    if (due <= 0) {
      draw();
      return;
    }
    repaintQueued = setTimeout(draw, due);
  };

  // And a heartbeat between messages, so the gap itself is legible: how long since the last one
  // arrived is exactly the number that tells you whether to keep waiting or to stop.
  heartbeat = setInterval(() => {
    if (!listening || lastAt === 0) return;
    const idle = Math.round((Date.now() - lastAt) / 1000);
    if (idle >= 2) {
      status(
        `${SPINNER[ticks++ % SPINNER.length]}  waiting — ${capture.byteLength.toLocaleString()} ` +
          `bytes so far, nothing for ${idle}s`,
        idle >= 20 ? "warn" : "info",
      );
    }
  }, 1000);

  input.addEventListener("midimessage", onMessage);
  listening = { input, onMessage };
  $("listen").textContent = "Stop";
  $<HTMLButtonElement>("probe").disabled = true;
  $<HTMLButtonElement>("save").disabled = false;
  renderCapture();
  status(`Listening on ${input.name}. Trigger the dump on the device.`);
}

$("listen").addEventListener("click", () => {
  if (listening) stopListening();
  else void startListening();
});

$("save").addEventListener("click", () => {
  if (capture.isEmpty) {
    status("Nothing captured yet.", "warn");
    return;
  }
  const name = captureFileName(capture.summarise());
  const length = capture.byteLength;
  void saveBytesTo(capture.bytes(), name, "probe").then((saved) => {
    status(`Saved ${whereSaved(saved)} — ${length.toLocaleString()} bytes.`, savedTone(saved));
  });
});

/** The capture, as parsed messages. */
export function splitCapture(): ReturnType<typeof parseMessage>[] {
  const out: ReturnType<typeof parseMessage>[] = [];
  for (const raw of splitMessages(capture.bytes())) {
    try {
      out.push(parseMessage(raw));
    } catch {
      // Not a dump. Counted elsewhere; ignored here.
    }
  }
  return out;
}

/** Re-emit a parsed message as bytes, so the writer can parse it back with its own guards. */
export function rebuildRaw(message: ReturnType<typeof parseMessage>): Uint8Array {
  return rebuildMessage(message);
}
