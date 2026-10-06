/**
 * Filling a range of `/waverider` slots from a folder, asking once.
 *
 * **One job: many tables, one question.** `writetable.ts` sends one table and is the right control
 * for trying something; this is for filling a pool. They are separate because the thing that makes
 * a batch safe is a different thing: the single write protects a slot, and this protects a
 * *range*, which it has to establish before the first byte goes out.
 *
 * ## Asking once is a relaxation, and here is exactly how much
 *
 * Seventy-five tables through the single control is seventy-five dialogs and seventy-five
 * hand-typed slot numbers, which is how slot 37 ends up holding the table meant for 38. So this
 * asks one question — and the question names **every slot it will touch**, which is what keeps it
 * a question rather than a formality.
 *
 * Three things keep the relaxation small:
 *
 * - **Every target must be empty in a listing taken at that moment.** One occupied slot refuses
 *   the whole run before anything is sent, and says which. So nothing can be overwritten, and the
 *   per-write backup rule has nothing to protect: there is no previous content.
 * - **Each write still passes the gate itself.** `writeTableToSlot` calls `requireWriteEnabled`,
 *   so switching WRITE off part-way stops the rest. The switch is the stop button.
 * - **It stops at the first failure.** A run that ploughs on past a slot the store refused would
 *   turn one problem into a directory nobody can reason about.
 *
 * The confirm hook each write receives is a local one that answers yes, because **the person has
 * already been asked about precisely this set**. It is defined here, named so it cannot be
 * mistaken for a general one, and never exported.
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
import { listProjectsAt } from "./drivefile.js";
import { $ } from "../dom.js";
import { askConfirm } from "../dialog.js";
import { requireWriteEnabled } from "../writeenable.js";
import { pageMessageIds } from "../messageids.js";
import { writeTableToSlot, WAVERIDER } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { INDEX_ENTRIES } from "@noiseandmatter/dnx-core/waverider/layout.js";
import { unplayableReason } from "@noiseandmatter/dnx-core/waverider/pool.js";

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

  /*
   * **The range check, before the question and before any byte.** A listing taken now, not the
   * one on screen: the point is that these slots are empty at the moment of asking.
   */
  status(`Checking slots ${first}..${last} are empty…`);
  const entries = await listProjectsAt(output, WAVERIDER);
  const occupied = [];
  for (let i = 0; i < picked.length; i++) {
    const slot = first + i;
    const entry = entries.find((e) => e.index === slot);
    if (entry === undefined) {
      status(`Slot ${slot} is not in the ${WAVERIDER} listing. Nothing sent.`, "error");
      return;
    }
    if (entry.occupied === true) occupied.push(`${slot}${entry.name ? ` (${entry.name})` : ""}`);
  }
  if (occupied.length > 0) {
    const rows: [string, string][] = [
      ["Asked for", `${picked.length} files into slots ${first}..${last}`],
      ["In the way", occupied.join(", ")],
      ["Sent", "nothing — the run needs every target empty"],
    ];
    verdictCard("Batch refused", rows);
    status(`Slots already in use: ${occupied.join(", ")}. Nothing sent.`, "error");
    return;
  }

  const total = picked.reduce((n, f) => n + f.size, 0);
  const unplayable = unplayableReason({ waves, points });
  const ok = await askConfirm({
    title: `Write ${picked.length} tables to ${WAVERIDER}/${first}..${last}?`,
    body: [
      `${picked.length} files, ${total.toLocaleString()} bytes of samples, one per slot in name ` +
        `order: ${nameOf(picked[0]!)} to slot ${first}, through ` +
        `${nameOf(picked[picked.length - 1]!)} to slot ${last}.`,
      `Every one of those slots is empty in a listing taken just now, so nothing is overwritten ` +
        `and there is no undo to need.`,
      `Each is read as ${waves} x ${points}` +
        (unplayable === undefined ? ", which the pool plays." : `. ${unplayable}`),
      `This is the only question. Each write still checks the WRITE switch, so switching it off ` +
        `stops the rest, and the run stops at the first slot that does not confirm.`,
    ],
    confirmLabel: `Write ${picked.length} tables`,
    danger: true,
  });
  if (!ok) {
    status("Cancelled — nothing was sent.", "warn");
    return;
  }

  running = true;
  $<HTMLButtonElement>("tableWriteAll").disabled = true;
  const done: [string, string][] = [];
  try {
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i]!;
      const slot = first + i;
      const name = nameOf(file);
      status(`Writing ${i + 1} of ${picked.length}: ${name} → ${WAVERIDER}/${slot}…`);

      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await writeTableToSlot({
        transport: apiTransport(output),
        host: {
          ids: pageMessageIds,
          // Per write, deliberately: this is what makes the WRITE switch a stop button.
          gate: requireWriteEnabled,
          // Already asked, about exactly this set. Local and unexported; see the module note.
          confirm: () => Promise.resolve(true),
        },
        table: pendingFrom(bytes, slot, name, waves, points),
        timeoutMs: 60_000,
      });

      if (result.cancelled || result.problem !== undefined || !result.listed) {
        done.push([`Slot ${slot}`, `STOPPED — ${result.problem ?? "cancelled"}`]);
        verdictCard(`Batch stopped at ${i + 1} of ${picked.length}`, [
          ["Written", `${i} table(s), slots ${first}..${slot - 1}`],
          ["Stopped on", `${name} → ${WAVERIDER}/${slot}`],
          ["Why", result.problem ?? "cancelled"],
          ["Left", `${picked.length - i} file(s) not sent`],
        ]);
        status(`Batch stopped at slot ${slot}: ${result.problem ?? "cancelled"}`, "error");
        return;
      }
      done.push([`Slot ${slot}`, `${name} — listed as "${result.listedAs ?? ""}", read back identical`]);
    }

    verdictCard(`${picked.length} tables written`, [
      ["Slots", `${first}..${last}, every one listed and verified`],
      ["Bytes", `${total.toLocaleString()} of samples`],
      ...done.slice(0, 6),
      ...(done.length > 6 ? ([["…", `${done.length - 6} more, all verified`]] as [string, string][]) : []),
    ]);
    status(`${picked.length} tables written to slots ${first}..${last}, all listed and verified.`, "ok");
  } finally {
    running = false;
    $<HTMLButtonElement>("tableWriteAll").disabled = false;
  }
}
