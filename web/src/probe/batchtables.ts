/**
 * Filling a range of `/waverider` slots from a folder, asking once.
 *
 * **One job: many tables, one question.** `writetable.ts` sends one table and is the right control
 * for trying something; this is for filling a pool. They are separate because the thing that makes
 * a batch safe is a different thing: the single write protects a slot, and this protects a
 * *range*, which it has to establish before the first byte goes out.
 *
 * ## The safety sequence is core's
 *
 * Fresh listing, every target empty, one question, the gate on every write, stop at the first
 * failure: `writeTablesToSlots` in `device/waveriderbatch.ts`, shared with the library's import.
 * This file keeps the question's words and the verdict cards.
 *
 * ## Names come from the files
 *
 * `01 Basic Sine2Saw.raw` becomes `01 Basic Sine2Saw`. Typing seventy-five names is the other way
 * the wrong table ends up under the wrong name, and a filename is the one label that is already
 * right and already matches whatever manifest produced it.
 */

import { status } from "./chrome.js";
import { apiTransport } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictCard } from "./verdicts.js";
import { pendingFrom } from "./writetable.js";
import { $ } from "../dom.js";
import { askConfirm } from "../dialog.js";
import { requireWriteEnabled } from "../writeenable.js";
import { pageMessageIds } from "../messageids.js";
import { WAVERIDER } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import {
  type BatchWriteOutcome, writeTablesToSlots,
} from "@noiseandmatter/dnx-core/device/waveriderbatch.js";
import { INDEX_ENTRIES } from "@noiseandmatter/dnx-core/waverider/layout.js";
import { unplayableReason } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { askPlayableBounds } from "./waveriderbounds.js";

let running = false;

/** `01 Basic Sine2Saw.raw` → `01 Basic Sine2Saw`. */
function nameOf(file: File): string {
  return file.name.replace(/\.[^.]+$/, "").trim();
}

$("tableWriteAll").addEventListener("click", () => {
  writeAll().catch((error: unknown) => {
    status(`Batch write failed: ${String(error)}`, "error");
    verdictCard("Batch write failed", [["Error", String(error)]]);
  });
});

async function writeAll(): Promise<void> {
  const output = readyOutput("readback");
  if (!output) return;
  if (running) {
    status("A batch is already running.", "warn");
    return;
  }

  const picked = [...($<HTMLInputElement>("tableFiles").files ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (picked.length === 0) {
    status("Choose the table files first.", "warn");
    return;
  }

  const first = Number($<HTMLInputElement>("tableFirstSlot").value);
  const waves = Number($<HTMLInputElement>("tableWaves").value);
  const points = Number($<HTMLInputElement>("tablePoints").value);
  const last = first + picked.length - 1;

  if (!Number.isInteger(first) || first < 0 || last >= INDEX_ENTRIES) {
    status(
      `${picked.length} files from slot ${first} would run to ${last}, and the store ends at ` +
        `${INDEX_ENTRIES - 1}.`,
      "error",
    );
    return;
  }

  const total = picked.reduce((n, f) => n + f.size, 0);
  const playable = await askPlayableBounds(output);
  const unplayable = unplayableReason({ waves, points }, playable.bounds);
  const tables = await Promise.all(
    picked.map(async (file, i) =>
      pendingFrom(new Uint8Array(await file.arrayBuffer()), first + i, nameOf(file), waves, points),
    ),
  );

  const ask = (): Promise<boolean> =>
    askConfirm({
      title: `Write ${picked.length} tables to ${WAVERIDER}/${first}..${last}?`,
      body: [
        `${picked.length} files, ${total.toLocaleString()} bytes of samples, one per slot in name ` +
          `order: ${nameOf(picked[0]!)} to slot ${first}, through ` +
          `${nameOf(picked[picked.length - 1]!)} to slot ${last}.`,
        `Every one of those slots is empty in a listing taken just now, so nothing is overwritten ` +
          `and there is no undo to need.`,
        `This build's pool plays ${playable.why}.`,
        `Each is read as ${waves} x ${points}` +
          (unplayable === undefined ? ", which the pool plays." : `. ${unplayable}`),
        `This is the only question. Each write still checks the WRITE switch, so switching it off ` +
          `stops the rest, and the run stops at the first slot that does not confirm.`,
      ],
      confirmLabel: `Write ${picked.length} tables`,
      danger: true,
    });

  running = true;
  $<HTMLButtonElement>("tableWriteAll").disabled = true;
  status(`Checking slots ${first}..${last} are empty…`);
  try {
    const outcome = await writeTablesToSlots({
      transport: apiTransport(output),
      host: { ids: pageMessageIds, gate: requireWriteEnabled, ask },
      tables,
      ...(playable.bounds === undefined ? {} : { playable: playable.bounds }),
      onWriting: (done, count, table) =>
        status(`Writing ${done + 1} of ${count}: ${table.name} → ${WAVERIDER}/${table.slot}…`),
    });
    report(outcome, picked.length, first, last, total);
  } finally {
    running = false;
    $<HTMLButtonElement>("tableWriteAll").disabled = false;
  }
}

function report(outcome: BatchWriteOutcome, count: number, first: number, last: number, total: number): void {
  switch (outcome.kind) {
    case "unread":
      status(`Could not read the ${WAVERIDER} listing: ${outcome.problem}. Nothing sent.`, "error");
      return;
    case "missing":
      status(`Slot ${outcome.slots.join(", ")} is not in the ${WAVERIDER} listing. Nothing sent.`, "error");
      return;
    case "occupied": {
      const occupied = outcome.slots.map((slot) => `${slot.slot}${slot.name ? ` (${slot.name})` : ""}`);
      verdictCard("Batch refused", [
        ["Asked for", `${count} files into slots ${first}..${last}`],
        ["In the way", occupied.join(", ")],
        ["Sent", "nothing — the run needs every target empty"],
      ]);
      status(`Slots already in use: ${occupied.join(", ")}. Nothing sent.`, "error");
      return;
    }
    case "gated":
      status(outcome.problem, "warn");
      return;
    case "declined":
      status("Cancelled — nothing was sent.", "warn");
      return;
    case "stopped": {
      const at = outcome.at;
      const done = outcome.written.length;
      // `landed`: the table at the stop is in the store, and its read-back is what failed.
      const stored = done + (outcome.landed ? 1 : 0);
      verdictCard(`Batch stopped at ${done + 1} of ${count}`, [
        ["Written", stored === 0 ? "none" : `${stored} table(s), slots ${first}..${outcome.landed ? at.slot : at.slot - 1}`],
        ["Stopped on", `${at.name} → ${WAVERIDER}/${at.slot}${outcome.landed ? ", in the store" : ""}`],
        ["Why", outcome.problem],
        ["Left", `${count - stored} file(s) not sent`],
      ]);
      status(`Batch stopped at slot ${at.slot}: ${outcome.problem}`, "error");
      return;
    }
    case "done": {
      const rows: [string, string][] = outcome.written.map((result) => [
        `Slot ${result.slot}`, `listed as "${result.listedAs ?? ""}", read back identical`,
      ]);
      verdictCard(`${count} tables written`, [
        ["Slots", `${first}..${last}, every one listed and verified`],
        ["Bytes", `${total.toLocaleString()} of samples`],
        ...rows.slice(0, 6),
        ...(rows.length > 6 ? ([["…", `${rows.length - 6} more, all verified`]] as [string, string][]) : []),
      ]);
      status(`${count} tables written to slots ${first}..${last}, all listed and verified.`, "ok");
    }
  }
}
