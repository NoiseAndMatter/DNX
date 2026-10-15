/**
 * The status line for a finished wavetable import: what was written, and where and why it stopped.
 *
 * **One job, and no DOM**, so a Node test can check the words a person reads after a failure.
 */

import { type BatchWriteOutcome } from "@noiseandmatter/dnx-core/device/waveriderbatch.js";
import { type StatusKind } from "../statusbar.js";

/** The status line for a finished run: what was written, and where and why it stopped. */
export function importOutcome(outcome: BatchWriteOutcome, total: number): [string, StatusKind] {
  const tables = (n: number): string => `${n} ${n === 1 ? "table" : "tables"}`;
  // A reason that is already a sentence keeps its own full stop and gets no second one.
  const reason = (problem: string): string => problem.replace(/\.\s*$/, "");
  switch (outcome.kind) {
    case "unread":
      return [`Could not read the store listing: ${reason(outcome.problem)}. Nothing sent.`, "error"];
    case "missing":
      return [`Nothing sent. These slots are not in the store listing: ${outcome.slots.join(", ")}.`, "error"];
    case "occupied":
      return [
        `Nothing sent. These slots are no longer empty: ` +
          outcome.slots.map((slot) => `${slot.slot}${slot.name ? ` (${slot.name})` : ""}`).join(", ") +
          `. Refresh and move the staged tables.`,
        "error",
      ];
    case "gated":
      return [`${outcome.problem}`, "warn"];
    case "declined":
      return ["Cancelled. Nothing was sent.", "warn"];
    case "stopped":
      return [
        `Stopped at slot ${outcome.at.slot} (${outcome.at.name}): ${reason(outcome.problem)}. ` +
          `${tables(outcome.written.length)} written, ${total - outcome.written.length} not sent.`,
        "error",
      ];
    case "done":
      return [
        `Wrote ${tables(outcome.written.length)}. ${outcome.written.length === 1 ? "It is" : "They are"} ` +
          `in the store and in no pool yet. Click ${outcome.written.length === 1 ? "it" : "one"} on the ` +
          `right, then a pool slot on the left, and press Add to pool.`,
        "ok",
      ];
  }
}

