/**
 * Reading a whole project, object by object.
 *
 * The read half of transfer mode. `readplan.ts` says what to ask for and `dumpreader.ts` paces it;
 * everything here is the page — a confirmation before pulling 14.6 MB, a progress line, a stop
 * button, and a report at the end.
 *
 * The bytes go into the same capture the front-panel listener fills, so **Save capture** writes a
 * `.syx` every existing tool already reads. While the read runs it takes the listener's inbound
 * sink, because it is drawing its own progress into the results area and a capture repaint per
 * message would tear that down.
 */

import { card } from "./cards.js";
import { bar, SPINNER, status } from "./chrome.js";
import { capture, setInboundSink } from "./listen.js";
import { readyDump } from "./ready.js";
import { readReportRows } from "./report.js";
import { fillWriteSources } from "./writeslot.js";
import { DumpReader, type ReadReport } from "../../../src/device/dumpreader.js";
import { planBytes, planProjectRead } from "../../../src/device/readplan.js";
import { askConfirm } from "../dialog.js";
import { $, escapeHtml } from "../dom.js";

/**
 * Ask the device for every object a project is made of, one at a time.
 *
 * The read half of transfer mode. `readplan.ts` says what to ask for and `dumpreader.ts` paces it;
 * everything here is the page: a confirmation before pulling 14.6 MB, a progress line, a stop
 * button, and a report at the end. The bytes go into the same capture the front-panel listener
 * fills, so **Save capture** writes a `.syx` every existing tool already reads.
 *
 * Requires Listen, like Request does — the listener is what feeds both the capture and the reader,
 * and a read with nothing collecting is a transfer for no reason.
 */
let reading: DumpReader | undefined;

$("readProject").addEventListener("click", () => {
  if (reading) {
    reading.stop();
    status("Stopping after the object in flight…", "warn");
    return;
  }
  void readProject();
});

async function readProject(): Promise<void> {
  const ready = readyDump("reply");
  if (!ready) return;
  const { output, productId } = ready;

  let plan;
  try {
    plan = planProjectRead(productId);
  } catch (error) {
    status(String(error), "error");
    return;
  }

  const megabytes = (planBytes(plan) / 1_000_000).toFixed(1);
  if (
    !(await askConfirm({
      title: `Read all ${plan.length} objects — roughly ${megabytes} MB?`,
      body: [
        "Nothing is written to the device; every request carries an empty body.",
        "Make sure SETTINGS > SYSEX DUMP is set to USB rather than USB+MIDI. DIN MIDI throttles " +
          "the transfer to about 3 kB/s, which would take over an hour.",
      ],
      confirmLabel: "Read the project",
    }))
  ) {
    return;
  }

  const results = $("results");
  results.innerHTML = "";
  const progress = document.createElement("section");
  progress.className = "card";
  results.append(progress);

  const started = Date.now();
  const reader = new DumpReader({
    productId,
    send: (bytes) => output.send([...bytes]),
    onProgress: (result, done, total) => {
      bar.at(done, total, "Reading the project");
      const seconds = (Date.now() - started) / 1000;
      // Remaining time from the rate so far rather than from a constant: the two families differ
      // by an order of magnitude and a hard-coded estimate would be wrong on one of them.
      const left = done === 0 ? 0 : Math.round((seconds / done) * (total - done));
      progress.innerHTML =
        `<h2>Reading — ${done} of ${total}</h2>` +
        `<div class="row"><span class="k">Now</span><span class="v">` +
        `${escapeHtml(result.step.label)} — ${escapeHtml(result.status)}</span></div>` +
        `<div class="row"><span class="k">Received</span><span class="v">` +
        `${capture.byteLength.toLocaleString()} bytes</span></div>` +
        `<div class="row"><span class="k">About</span><span class="v">${left}s to go</span></div>`;
      status(
        `${SPINNER[done % SPINNER.length]}  reading ${done}/${total} — ${result.step.label}`,
        result.status === "ok" ? "info" : "warn",
      );
    },
  });

  reading = reader;
  // The listener hands the bytes straight to the reader while this runs, instead of repainting
  // the capture under the progress this is drawing. Given back in the `finally`, always.
  setInboundSink((data) => reader.receive(data));
  $("readProject").textContent = "Stop read";
  $<HTMLButtonElement>("request").disabled = true;
  $<HTMLButtonElement>("listen").disabled = true;

  try {
    const report = await reader.run(plan);
    reportCard(results, report, Date.now() - started);
    status(
      `${report.ok} of ${plan.length} objects read, ${capture.byteLength.toLocaleString()} bytes.` +
        (report.silent > 0 ? ` ${report.silent} silent.` : "") +
        " Press Save capture.",
      report.silent === 0 ? "ok" : "warn",
    );
  } catch (error) {
    status(`The read stopped: ${error}`, "error");
  } finally {
    bar.done();
    setInboundSink(undefined);
    reading = undefined;
    $("readProject").textContent = "Read project";
    $<HTMLButtonElement>("request").disabled = false;
    $<HTMLButtonElement>("listen").disabled = false;
    $<HTMLButtonElement>("save").disabled = capture.isEmpty;
    $<HTMLButtonElement>("writeBack").disabled = capture.isEmpty;
    // Refreshed here rather than on every message: parsing a 14 MB capture to repopulate a select
    // is not something to do 257 times during a read.
    fillWriteSources();
  }
}

/**
 * What the run found.
 *
 * Silences, late answers and mismatches are reported as counts with what each one means, because
 * every one of them is a question about the device rather than a failure of ours — and the first
 * run of this is the experiment that answers two of them.
 */
function reportCard(into: HTMLElement, report: ReadReport, elapsedMs: number): void {
  card(into, "Read report", readReportRows(report, elapsedMs));
}
