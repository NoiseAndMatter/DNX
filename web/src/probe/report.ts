/**
 * What a whole-project read is telling you, as rows.
 *
 * A `ReadReport` is counts. This turns them into the sentences a person reads at two in the
 * morning with an instrument in front of them, and **almost every sentence here is something the
 * hardware taught us rather than something the format says.** A Digitone 1 answers four sounds when
 * asked for 128. DIN MIDI throttles a transfer to about 3 kB/s. A device that does not echo the
 * requested object number means a rebuild has to go by send order. A bad checksum is corruption in
 * transit and comes back clean on the next read.
 *
 * ## Why it is not in `main.ts`
 *
 * Same reason as `changes.ts`, `silence.ts`, `timing.ts` and `format.ts` — **a pure thing inside a
 * DOM module is a pure thing nobody can test.** This was eighty lines of derivation with a single
 * `card()` call at the end of it, which meant the only way to see what a report says about a
 * partial read was to perform a partial read on real hardware.
 *
 * ## Every row is conditional, and that is the design
 *
 * A clean read prints three rows. Everything else appears **only when it happened**, because a
 * report that lists nine categories with zeros in seven of them buries the two that matter. The
 * cost of that choice is that seven of these branches had never been rendered by anyone; they are
 * now rendered by tests.
 *
 * ## `skipped` is an answer, not a failure
 *
 * The one piece of tone worth protecting. A Digitone 1 asked for 128 sounds gives four; without
 * that line it reads as 124 things going wrong rather than as a device with four sounds.
 */

import { type ReadReport, stepsToRetry } from "@noiseandmatter/dnx-core/device/dumpreader.js";
import { hex } from "@noiseandmatter/dnx-core/device/capabilities.js";

/**
 * The read report as title-and-value rows, in the order they should be read.
 *
 * `elapsedMs` is passed rather than taken from `report.elapsedMs` because the caller times the
 * whole operation — the plan, the sends and the draining — and the reader times only its own run.
 * The number a person compares against a stopwatch is the caller's.
 */
export function readReportRows(report: ReadReport, elapsedMs: number): [string, string][] {
  const rows: [string, string][] = [
    ["Answered", `${report.ok} of ${report.results.length}`],
    ["Bytes", report.bytes.toLocaleString()],
    [
      "Took",
      `${(elapsedMs / 1000).toFixed(1)}s` +
        (report.bytesPerSecond > 0 ? ` — ${(report.bytesPerSecond / 1000).toFixed(0)} kB/s` : ""),
    ],
  ];

  if (report.stopped) rows.push(["Stopped", "by you, before the plan finished"]);

  // Said as an answer, not as a failure. A Digitone 1 asked for 128 sounds gives four; without
  // this line that reads as 124 things going wrong rather than as a device with four sounds.
  if (report.skipped > 0) {
    rows.push([
      "Not asked for",
      `${report.skipped} — the device went quiet on ${report.gaveUpOn
        .map((g) => hex(g.code))
        .join(", ")} after ${report.gaveUpOn[0]?.after ?? 0} in a row, so the rest was skipped. ` +
        `On a Digitone 1 that is expected for sounds: it answers 0x63 for its four kit tracks ` +
        `only, and its sound pool has to be sent from SETTINGS > SYSEX DUMP instead.`,
    ]);
  }

  if (report.silent > 0) {
    const first = report.results.find((r) => r.status === "silent");
    rows.push([
      "No answer",
      `${report.silent} object(s), first at ${first?.step.label ?? "?"} — either the device sends ` +
        `nothing for that slot, or the transport is too slow for the wait`,
    ]);
  }
  if (report.late > 0) {
    rows.push([
      "Answered late",
      `${report.late} — the wait is too short for this transport. If SYSEX DUMP is set to ` +
        `USB+MIDI, switch it to USB: DIN throttles this to about 3 kB/s (manual §13.4.2).`,
    ]);
  }
  if (report.objNrMismatches > 0) {
    rows.push([
      "Object number differed",
      `${report.objNrMismatches} — the device does not echo the requested index, so a rebuild ` +
        `must go by send order rather than by the number in the message`,
    ]);
  }
  if (report.sizeMismatches > 0) {
    const odd = report.results.find(
      (r) => r.status === "ok" && r.payloadBytes !== r.step.payloadBytes,
    );
    rows.push([
      "Unexpected size",
      `${report.sizeMismatches} — e.g. ${odd?.step.label}: ${odd?.payloadBytes} bytes, expected ` +
        `${odd?.step.payloadBytes}`,
    ]);
  }
  // Given its own line and its own instruction, because this is the failure the hardware found:
  // one Digitone II pattern arrived with a bad checksum and 6,433 wrong bytes, and came back
  // perfectly on the next read. Rare, silent, and fixed by asking again.
  if (report.badChecksums > 0) {
    const retry = stepsToRetry(report);
    rows.push([
      "Bad checksums",
      `${report.badChecksums} — corrupt in transit, not a format problem. Read again and these ` +
        `will almost certainly be clean: ${retry
          .slice(0, 6)
          .map((s) => s.label)
          .join(", ")}${retry.length > 6 ? `, +${retry.length - 6} more` : ""}`,
    ]);
  }
  if (report.foreign > 0) rows.push(["Other traffic", `${report.foreign} message(s), ignored`]);

  return rows;
}
