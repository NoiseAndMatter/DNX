/**
 * Writing one captured record into a slot you choose.
 *
 * The first write on this page that puts bytes somewhere they were not. It is exempt from
 * `safeWriteRecords` because it is not an image diff — one record, one arbitrary destination — so
 * it carries the five rules itself: the destination is read from the device rather than assumed
 * from the capture, the question is asked, a copy of what is there is saved **before** anything is
 * sent, the write goes out, and the slot is read back and compared.
 *
 * The occupancy check is the one that matters. For most people the +Drive is the only copy of that
 * work, so a destination that is not provably empty stops the write rather than warning about it.
 */

import { status } from "./chrome.js";
import { VERIFY_TIMEOUT_MS } from "./dumpio.js";
import { awaitPatternKit, lastProductId, linkTo } from "./link.js";
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
import { describeWrite, unverifiedMeans, writeOutcome } from "./writeverdict.js";
import {
  looksBlank,
  settleMsAfter,
  verifyWrite,
  writeToSlot,
} from "../../../src/device/dumpwrite.js";
import { buildRecordBackup } from "../../../src/device/safewrite.js";
import { blankPatternKit } from "../../../src/librarian/blank.js";
import { DN1_DEVICE, DN2_DEVICE } from "../../../src/librarian/device.js";
import { patternIndex, patternName } from "../../../src/project/naming.js";
import { parseMessage } from "../../../src/sysex/container.js";
import { ProductId } from "../../../src/sysex/devices.js";
import { askConfirm } from "../dialog.js";
import { saveBytesTo, savedTone, whereSaved } from "../dnxfolder.js";
import { $, escapeHtml } from "../dom.js";
import { requireWriteEnabled } from "../writeenable.js";

/**
 * The first write that actually changes something.
 *
 * The null round trip proved the path with bytes that were already there. This one moves a pattern
 * into a slot it was not in, which is the operation the manager will eventually perform over MIDI
 * — and it is the experiment that answers the two things `docs/device-probing.md` still lists as
 * unknown: whether a write reaches the +Drive or only the active copy in RAM, and what happens to
 * a slot that already holds work.
 *
 * The destination defaults to `H16` because the last slot of the last bank is the least likely to
 * hold anything, and the control refuses a non-blank destination unless the user says otherwise —
 * judged against the **captured blank**, which is itself a device artefact rather than our idea of
 * what empty looks like.
 */
export function fillWriteSources(): void {
  const select = $<HTMLSelectElement>("writeFrom");
  const patterns = splitCapture().filter((m) => m.dumpType === 0x50);
  const seen = new Set<number>();
  const options: string[] = [];
  for (const m of patterns) {
    if (seen.has(m.objNr)) continue;
    seen.add(m.objNr);
    options.push(`<option value="${m.objNr}">${escapeHtml(patternName(m.objNr))}</option>`);
  }
  select.innerHTML = options.join("");
  const usable = options.length > 0 && lastProductId !== undefined;
  select.disabled = !usable;
  $<HTMLInputElement>("writeTo").disabled = !usable;
  $<HTMLButtonElement>("writeSlot").disabled = !usable;
}

$("writeSlot").addEventListener("click", () => {
  writeToChosenSlot().catch((error: unknown) => {
    status(`The write failed: ${String(error)}`, "error");
    verdictCard("Write failed", [["Error", String(error)]]);
  });
});

async function writeToChosenSlot(): Promise<void> {
  const ready = readyDump("readback");
  if (!ready) return;
  const { output, productId } = ready;

  const destination = patternIndex($<HTMLInputElement>("writeTo").value);
  if (destination === undefined) {
    status(`"${$<HTMLInputElement>("writeTo").value}" is not a slot. Use A1 to H16.`, "error");
    return;
  }

  const sourceObj = Number($<HTMLSelectElement>("writeFrom").value);
  const messages = splitCapture();
  const source = messages.find((m) => m.dumpType === 0x50 && m.objNr === sourceObj);
  if (!source) {
    status("That pattern is no longer in the capture. Read the project again.", "warn");
    return;
  }
  if (destination === sourceObj) {
    status("That is the slot it came from — use Write back for the null round trip.", "warn");
    return;
  }

  // Is there something in the way, and what is it? **Asked fresh, not read out of the capture.**
  // The capture holds whatever happened to have been read earlier, so a destination nobody had
  // read was overwritten with no copy of it at all, under a confirmation that admitted as much
  // ("not in the capture — unknown"). One read answers both questions: what the slot holds now,
  // and what to keep.
  const device = productId === ProductId.DN1 ? DN1_DEVICE : DN2_DEVICE;
  const from = patternName(sourceObj);
  const to = patternName(destination);

  // Nothing reaches an instrument until somebody arms the switch, and the disabled button is not
  // what enforces that. Checked before the pre-write read, so a control the page forgot to gate
  // is refused before the device is asked anything. See `writeenable.ts`.
  try {
    requireWriteEnabled();
  } catch (error) {
    verdictCard("Write refused: writing is switched off", [
      ["From", from],
      ["To", to],
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`Not written: ${String(error)}`, "warn");
    return;
  }

  status(`Asking for ${to} before touching it…`);
  const before = await awaitPatternKit(output, productId, destination);
  if (!before) {
    // The refusal `safeWriteRecords` makes, for the reason it gives: a device that has gone quiet
    // is exactly when a copy matters, so nothing is sent.
    verdictCard("Write refused — no copy of the destination", [
      ["To", to],
      ["Asked for it back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      [
        "Reason",
        "the copy of what is about to be destroyed comes from this read. Without it there is no " +
          "undo, so nothing was sent.",
      ],
      ["Device", "untouched"],
    ]);
    status(`${to} did not answer, so nothing was sent.`, "error");
    return;
  }

  // Judged against the device's own blank, not ours.
  const emptiness = looksBlank(
    before,
    blankPatternKit(device, destination),
    device.slotIndexOffset,
    device.layout.patternSize + 8,
    16,
  );
  const occupancy = emptiness.blank
    ? "empty — matches the device's own blank exactly"
    : `HOLDS WORK — ${emptiness.differingBytes.toLocaleString()} bytes differ from a blank`;

  if (
    !(await askConfirm({
      title: `Copy pattern ${from} into slot ${to}?`,
      body: [
        `Destination ${to} is ${occupancy}.`,
        `This overwrites ${to} in the device's ACTIVE project. ${from} is unaffected.`,
        `${to} as it stands is saved to your machine first, as a .syx you can send straight back.`,
        "To undo: load another project on the device without saving. A write does not reach the " +
          "+Drive until you press SAVE PROJECT.",
      ],
      confirmLabel: `Overwrite ${to}`,
      danger: true,
    }))
  ) {
    return;
  }

  const log: [string, string][] = [
    ["From", from],
    ["To", to],
    ["Destination was", occupancy],
  ];

  /*
   * **The copy: after the question, before anything is sent.** `safeWriteFile` settled that order
   * for both halves of the reason — a backup downloaded for a write somebody then cancels is rude,
   * and a write that began before the copy was taken is worse. A failure here is a refusal rather
   * than a warning, because this file is the only undo the page offers.
   */
  const backup = buildRecordBackup(
    productId, device.name, [destination], new Map([[destination, before]]),
  );
  try {
    const saved = await saveBytesTo(backup.bytes, backup.name, "copies");
    status(`Copy of the destination saved to ${whereSaved(saved)}.`, savedTone(saved));
  } catch (error) {
    verdictCard("Write refused — the copy could not be saved", [
      ...log,
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`The copy of ${to} could not be saved, so nothing was sent: ${String(error)}`, "error");
    return;
  }
  log.push(["Backup", `${backup.name} (${backup.bytes.length.toLocaleString()} bytes)`]);

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

  let message: Uint8Array;
  try {
    message = writeToSlot(productId, rebuildRaw(source), destination, device.slotIndexOffset);
  } catch (error) {
    verdictCard("Write refused before anything was sent", [
      ...log,
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`Refused: ${String(error)}`, "error");
    return;
  }

  const thread = watchMainThread();
  const inbound = watchInbound(linkTo(output).input);
  trace("Sending", `${message.length.toLocaleString()} bytes to ${to}…`);
  try {
    output.send([...message]);
  } catch (error) {
    trace("Send failed", String(error));
    status(`The device rejected the message: ${String(error)}`, "error");
    return;
  }

  // **Let the device finish taking it in before asking it anything.** A request sent immediately
  // behind 114 KB of SysEx is dropped by a device still ingesting — the write lands and the reply
  // never comes, which is exactly how this looked on hardware.
  const settle = settleMsAfter(message.length, productId);
  trace("Settling", `${settle}ms before asking — the device is still taking it in`);
  const watched = watchVisibility();
  const settling = tickWhileWaiting(log, "Settling", () => verdictCard("Write in progress", log));
  await new Promise((resolve) => setTimeout(resolve, settle));
  settling();

  trace("Sent", `asking for ${to} back`);
  const waiting = tickWhileWaiting(log, "Waiting for the read-back", () => verdictCard("Write in progress", log));
  const readBack = await awaitPatternKit(output, productId, destination);
  waiting();
  // Stopped once and kept: calling it twice would detach the listener twice and re-measure, and the
  // row belongs in the log either way so both the verdict and the timeout card carry it.
  const hidden = watched();
  log.push(...timeGoesRow(thread(), inbound()));
  log.push(...hiddenRow(hidden));

  if (!readBack) {
    verdictCard("Write NOT verified — yet", [
      ...log,
      ["Read back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      ["Means", unverifiedMeans(hidden.hiddenMs, false)],
    ]);
    status(`${to} written; no read-back yet.`, "warn");
    return;
  }

  // Compared against what was *sent*, not against the source: the slot index byte legitimately
  // differs between them, and comparing to the source would report that as a failure every time.
  const sent = parseMessage(message).payload;
  const verdict = verifyWrite(sent, readBack);

  /*
   * **Three outcomes, not two**, and the reasoning is in `writeverdict.ts` with its tests. A device
   * that overwrote and a device that refused both answer the read and both stay silent about the
   * write, so "did not match what we sent" is two situations wearing one label. Held against what
   * the slot contained *before*, the answer is unambiguous — and there is always a *before* now,
   * because the read that took the backup is that same record.
   */
  const outcome = writeOutcome(verdict.ok, verifyWrite(before, readBack).ok);
  const said = describeWrite(outcome, { from, to, ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) });

  verdictCard(said.title, [
    ...log,
    ["Read back", `${readBack.length.toLocaleString()} bytes`],
    ["Result", said.result],
    ["Next", said.next],
  ]);
  status(said.message, said.level);
}
