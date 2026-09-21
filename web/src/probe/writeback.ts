/**
 * The null round trip: the least interesting write imaginable, and the right first one.
 *
 * A record from the current capture is sent back to the slot it came from — identical bytes to the
 * same place — and then requested again and compared. If the write path works, nothing changed; if
 * it is broken, nothing changed either; and if the bytes land somewhere else, the read-back shows
 * it while the original is still in the capture.
 *
 * See `docs/device-probing.md` for the regime and `src/device/dumpwrite.ts` for the guards that
 * refuse everything this page does not explicitly ask for. The destination is read fresh before
 * anything goes out, so "still the null round trip it calls itself" is checked rather than assumed.
 */

import { status } from "./chrome.js";
import { requestPatternKit, VERIFY_TIMEOUT_MS } from "./dumpio.js";
import { awaitPatternKit, linkTo } from "./link.js";
import { capture, rebuildRaw, splitCapture } from "./listen.js";
import { readyDump } from "./ready.js";
import {
  hiddenRow,
  tickWhileWaiting,
  timeGoesRow,
  watchInbound,
  watchMainThread,
  watchVisibility,
} from "./timing.js";
import { verdictCard } from "./verdicts.js";
import { unverifiedMeans } from "./writeverdict.js";
import {
  driftSince,
  nullRoundTrip,
  settleMsAfter,
  verifyWrite,
} from "../../../src/device/dumpwrite.js";
import { $ } from "../dom.js";
import { buildRecordBackup } from "../../../src/device/safewrite.js";
import { DN1_DEVICE, DN2_DEVICE } from "../../../src/librarian/device.js";
import { patternName } from "../../../src/project/naming.js";
import { ProductId } from "../../../src/sysex/devices.js";
import { askConfirm } from "../dialog.js";
import { saveBytesTo, savedTone, whereSaved } from "../dnxfolder.js";
import { requireWriteEnabled } from "../writeenable.js";

/**
 * The only control on this page that changes the instrument.
 *
 * It performs a **null round trip**: a record from the current capture is sent back to the slot it
 * came from — identical bytes to the same place — and then requested again and compared. If the
 * write path works, nothing changed; if it is broken, nothing changed either; and if the bytes land
 * somewhere else, the read-back shows it while the original is still in the capture.
 *
 * That is deliberately the least interesting write imaginable, and it is the right first one. See
 * `docs/device-probing.md` for the regime, and `src/device/dumpwrite.ts` for the guards that
 * refuse everything this page does not explicitly ask for.
 */

$("writeBack").addEventListener("click", () => {
  // **Never `void` a promise on this page.** A rejected `writeBack` used to vanish without a
  // trace: `output.send()` can throw on a 114 KB message, and the only symptom was a UI that did
  // nothing at all. Silence is the one outcome a control that changes an instrument must not have.
  writeBack().catch((error: unknown) => {
    status(`The write failed: ${String(error)}`, "error");
    verdictCard("Write failed", [
      ["Error", String(error)],
      [
        "Meaning",
        "the message was not sent, or the port rejected it. Nothing was written — but check the " +
          "device, because 'we threw before sending' and 'the send threw partway' look the same " +
          "from here.",
      ],
    ]);
  });
});

async function writeBack(): Promise<void> {
  const ready = readyDump("readback");
  if (!ready) return;
  const { output, productId } = ready;

  // Sent back to its own slot, so the record has to come from this device in the first place.
  const messages = splitCapture();
  const candidate = messages.find((m) => m.dumpType === 0x50 && m.productId === productId);
  if (!candidate) {
    status(
      "No PatternKit in the capture from this device. Read one first — Write back only ever " +
        "returns a record to where it came from.",
      "warn",
    );
    return;
  }

  const slot = patternName(candidate.objNr);
  const device = productId === ProductId.DN1 ? DN1_DEVICE : DN2_DEVICE;

  // Nothing reaches an instrument until somebody arms the switch, and the disabled button is not
  // what enforces that. Checked before the pre-write read, so a control the page forgot to gate
  // is refused before the device is asked anything. See `writeenable.ts`.
  try {
    requireWriteEnabled();
  } catch (error) {
    verdictCard("Write refused: writing is switched off", [
      ["Slot", slot],
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`Not written: ${String(error)}`, "warn");
    return;
  }

  /*
   * **Is it still a null round trip?** The capture is what the slot held when it was read, and the
   * confirmation used to promise the bytes were identical to what the device just sent. That stops
   * being true the moment somebody turns a knob between the read and the write, and then this is an
   * ordinary overwrite of an ordinary edit, made under a promise that nothing would change.
   *
   * So the slot is asked for again, and the answer does two jobs: it decides what the question says,
   * and it is the copy kept before anything is sent.
   */
  status(`Asking for ${slot} before touching it…`);
  const onDevice = await awaitPatternKit(output, productId, candidate.objNr);
  if (!onDevice) {
    verdictCard("Write refused — no copy of the slot", [
      ["Slot", slot],
      ["Asked for it back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      [
        "Reason",
        "this read is both the check that the round trip is still null and the copy kept before " +
          "writing. Without it there is neither, so nothing was sent.",
      ],
      ["Device", "untouched"],
    ]);
    status(`${slot} did not answer, so nothing was sent.`, "error");
    return;
  }

  const drift = driftSince(candidate.payload, onDevice);
  if (!drift.same) {
    // A card before the question, so the finding survives whatever the person then chooses. A null
    // round trip that turns out not to be null is a result, and the probe exists to record results.
    verdictCard("The slot has moved on since the capture", [
      ["Slot", slot],
      ["Captured", `${candidate.payload.length.toLocaleString()} bytes`],
      ["On the device now", drift.reason ?? "differs"],
      [
        "Means",
        "this is no longer a null round trip. Writing puts the older capture back over whatever " +
          "changed. The copy saved on the way through is the newer one.",
      ],
    ]);
  }

  if (
    !(await askConfirm({
      title: drift.same
        ? `Write pattern ${slot} back to slot ${slot}?`
        : `Slot ${slot} has changed — still write the capture over it?`,
      body: [
        drift.same
          ? `This OVERWRITES that slot. The bytes are identical to what the slot holds right now, ` +
            `asked a moment ago, so nothing should change — but this is a real write and there is ` +
            `no undo.`
          : `This is NOT the null round trip it looks like. Since the capture was taken, ${drift.reason}. ` +
            `Writing puts the older bytes back over that change.`,
        `${slot} as it stands is saved to your machine first, as a .syx you can send straight back.`,
        "Load a scratch project first.",
      ],
      confirmLabel: `Overwrite ${slot}`,
      danger: true,
    }))
  ) {
    return;
  }

  /*
   * The copy: after the question, before anything is sent. The same order and the same reason as
   * `safeWriteFile` — a backup downloaded for a write somebody then cancels is rude, and a write
   * that began before the copy was taken is worse. A failure here is a refusal, not a warning.
   */
  const backup = buildRecordBackup(
    productId, device.name, [candidate.objNr], new Map([[candidate.objNr, onDevice]]),
  );
  try {
    const saved = await saveBytesTo(backup.bytes, backup.name, "copies");
    status(`Copy of the destination saved to ${whereSaved(saved)}.`, savedTone(saved));
  } catch (error) {
    verdictCard("Write refused — the copy could not be saved", [
      ["Slot", slot],
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`The copy of ${slot} could not be saved, so nothing was sent: ${String(error)}`, "error");
    return;
  }

  let message: Uint8Array;
  try {
    message = nullRoundTrip(productId, rebuildRaw(candidate));
  } catch (error) {
    // A guard firing is a result, not a non-event. Shown as a card because the status bar alone
    // was missed on the first hardware run.
    verdictCard("Write refused before anything was sent", [
      ["Slot", slot],
      ["Reason", String(error)],
      ["Device", "untouched — the message was never built, let alone sent"],
    ]);
    status(`Refused: ${String(error)}`, "error");
    return;
  }

  // Narrated step by step into the verdict element, which nothing else on this page redraws.
  const log: [string, string][] = [
    ["Slot", slot],
    ["Record", `${candidate.payload.length.toLocaleString()} bytes payload`],
    ["Message", `${message.length.toLocaleString()} bytes on the wire`],
    ["Slot before the write", drift.same ? "identical to the capture" : drift.reason ?? "differs"],
    ["Backup", `${backup.name} (${backup.bytes.length.toLocaleString()} bytes)`],
  ];
  // Every line carries how long the write has been running. Two stalled runs on hardware reported
  // their last line at *different* steps, which no single code path explains — without elapsed
  // times there was no way to tell a wait that is running from a page that has stopped running at
  // all. A log that cannot distinguish those two is not a log.
  const startedAt = Date.now();
  const since = (): string => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const trace = (what: string, detail: string): void => {
    log.push([what, `${detail}  (${since()})`]);
    verdictCard("Write in progress", log);
  };
  // Started before the send, because the send is the suspect — a measurement that begins after it
  // would miss exactly the window in question.
  const thread = watchMainThread();
  const inbound = watchInbound(linkTo(output).input);
  trace("Sending", `0x50 to slot ${slot}…`);

  try {
    status(`Writing ${slot}…`, "warn");
    output.send([...message]);
  } catch (error) {
    trace("Send failed", String(error));
    status(`The device rejected the message: ${String(error)}`, "error");
    return;
  }

  // Read it back — but not immediately. A request sent behind 114 KB of SysEx is dropped by a
  // device still ingesting it, which on hardware looked like a write that worked and a page that
  // hung. elk-herd has always paced its sends this way; see `settleMsAfter`.
  const settle = settleMsAfter(message.length, productId);
  trace("Settling", `${settle}ms before asking — the device is still taking it in`);
  await new Promise((resolve) => setTimeout(resolve, settle));

  trace("Sent", "asking for it back to see what actually landed");
  status(`Written. Asking for ${slot} back…`);
  const watched = watchVisibility();
  const waiting = tickWhileWaiting(log, "Waiting for the read-back", () => verdictCard("Write in progress", log));
  const readBack = await requestPatternKit(linkTo(output), productId, candidate.objNr, {
    onSendError: (error) => trace("Read-back request failed", String(error)),
    // **Keep listening after giving up.** A reply that missed the timeout used to arrive, trigger a
    // capture redraw and wipe the verdict — which is how a slow but successful write came to look
    // like a control that does nothing. A late answer is an answer, so it upgrades the card.
    onLate: (payload) => reportLateReadBack(payload, candidate, log, slot),
  });
  waiting();
  log.push(...timeGoesRow(thread(), inbound()));
  // Stopped once and kept, as the other write path already did: `watched()` detaches the listener
  // and re-measures, so calling it twice is both a double-detach and a second, later reading.
  const hidden = watched();
  log.push(...hiddenRow(hidden));

  if (!readBack) {
    log.push(["Read back", `nothing within ${VERIFY_TIMEOUT_MS}ms`]);
    verdictCard("Write NOT verified — yet", [
      ...log,
      // Taken from the measurement, not from the log. This used to string-match the row
      // `hiddenRow` produces, so renaming that row would have silently stopped the warning.
      ["Means", unverifiedMeans(hidden.hiddenMs, true)],
    ]);
    status("Written; the read-back has not arrived yet. Still listening.", "warn");

    // The late answer, if it comes, is handled by `onLate` on the wait above.
    return;
  }

  const verdict = verifyWrite(candidate.payload, readBack);
  verdictCard(verdict.ok ? "Write VERIFIED" : "Write did NOT match", [
    ...log,
    ["Read back", `${readBack.length.toLocaleString()} bytes`],
    ["Result", verdict.ok ? "the device returned exactly what was sent" : verdict.reason ?? "differs"],
    [
      "Means",
      verdict.ok
        ? "writing works on this device, at this record size, to this slot"
        : "the bytes did not land as sent — write nothing else until this is understood",
    ],
  ]);
  status(
    verdict.ok ? `${slot} written and verified — writing works.` : `${slot} did NOT verify.`,
    verdict.ok ? "ok" : "error",
  );
}

/**
 * A read-back that arrived after the wait expired.
 *
 * Separate from the verdict above because it is a different claim: the write is verified *and* the
 * timeout is too short for this device at this record size, which is worth saying on the card.
 */
function reportLateReadBack(
  payload: Uint8Array,
  candidate: { payload: Uint8Array },
  log: [string, string][],
  slot: string,
): void {
  const late = verifyWrite(candidate.payload, payload);
  verdictCard(late.ok ? "Write VERIFIED (reply was late)" : "Write did NOT match", [
    ...log,
    ["Read back", `${payload.length.toLocaleString()} bytes, after the wait expired`],
    ["Result", late.ok ? "the device returned exactly what was sent" : late.reason ?? "differs"],
    ["Note", `the ${VERIFY_TIMEOUT_MS}ms wait is too short for this device at this record size`],
  ]);
  status(late.ok ? `${slot} verified — the reply was just slow.` : `${slot} did NOT verify.`, late.ok ? "ok" : "error");
}
