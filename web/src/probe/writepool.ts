/**
 * Writing a project's wavetable pool from this page.
 *
 * **One job: the pool list, which is the project's and not the store's.** `writetable.ts` and
 * `batchtables.ts` put tables on the card; a table on the card plays nothing until a pool entry
 * names it, and this is the control that names them.
 *
 * ## The list is typed, and that is the design rather than a shortcut
 *
 * A full pool is 128 entries built from 78 tables, so it cannot be checked by eye in any form a
 * person did not write. `0-77, 0-46, 20, 4, 46` can be counted and read back before it is sent; a
 * button labelled *fill the pool* cannot be checked at all. `parseEntryList` holds the grammar and
 * the refusals, in core, where a test reaches it without a DOM.
 *
 * ## Two writers, and a refusal that cannot speak
 *
 * The instrument's own wavetable page writes record 0 too. `writePool` carries the generation it
 * read, so the firmware refuses a write that would discard somebody's front-panel edit — and that
 * refusal answers `commit ok` and writes nothing, like every refusal on this route.
 *
 * So the proof is the entries coming back, and **on a conflict this card says which entries
 * moved**. ADD TO POOL places every ticked table in one generation step, so a refused write can
 * cover six additions; *the pool changed* would leave somebody choosing between reload and
 * overwrite with no idea what overwrite discards.
 */

import { status } from "./chrome.js";
import { apiTransport } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictCard } from "./verdicts.js";
import { $ } from "../dom.js";
import { requireWriteEnabled } from "../writeenable.js";
import { confirmFileWrite, downloadBackup } from "../safewriteui.js";
import { pageMessageIds } from "../messageids.js";
import { writePool } from "@noiseandmatter/dnx-core/device/wavepoolwrite.js";
import {
  diffEntries,
  parseEntryList,
  summariseEntryList,
} from "@noiseandmatter/dnx-core/waverider/entrylist.js";

let writing = false;

/** `undefined` reads as an empty entry, and a store slot as itself. Shown slots are index + 1. */
const shown = (index: number): string => String(index + 1);

$("poolWrite").addEventListener("click", () => {
  writeTheirPool().catch((error: unknown) => {
    status(`Pool write failed: ${String(error)}`, "error");
    verdictCard("Pool write failed", [["Error", String(error)]]);
  });
});

async function writeTheirPool(): Promise<void> {
  const output = readyOutput("readback");
  if (!output) return;
  if (writing) {
    status("A pool write is already running.", "warn");
    return;
  }

  const projectSlot = Number($<HTMLInputElement>("poolProject").value);
  const automatic = $<HTMLInputElement>("poolAutomatic").checked;
  const text = $<HTMLInputElement>("poolList").value;

  let entries: (number | undefined)[] = [];
  if (!automatic) {
    try {
      entries = parseEntryList(text);
    } catch (error) {
      // The grammar's refusals name the token at fault, which is the whole reason to show them
      // rather than a generic "invalid list".
      status(String(error instanceof Error ? error.message : error), "error");
      return;
    }
    if (entries.every((e) => e === undefined)) {
      status("That list is empty. Tick automatic to write the automatic pool instead.", "warn");
      return;
    }
  }

  const summary = summariseEntryList(entries);
  verdictCard("Writing a pool…", [
    ["To", `/wavepool/${projectSlot}${projectSlot === 0 ? " — the working project" : ""}`],
    ["Kind", automatic ? "automatic: every playable table in store order" : "a list"],
    ...(automatic
      ? []
      : ([
          ["Entries", `${summary.used} of 128 used, ${summary.distinct} distinct`],
          ["Repeats", summary.repeated.length === 0 ? "none" : `store slot(s) ${summary.repeated.join(", ")}`],
          ["Top three", `${shown(125)}, ${shown(126)}, ${shown(127)} → store ${entries[125] ?? "—"}, ${entries[126] ?? "—"}, ${entries[127] ?? "—"}`],
        ] as [string, string][])),
    ["Guard", "the generation just read goes with it, so a front-panel edit in between is refused"],
  ]);

  writing = true;
  $<HTMLButtonElement>("poolWrite").disabled = true;
  try {
    const result = await writePool({
      transport: apiTransport(output),
      host: {
        ids: pageMessageIds,
        gate: requireWriteEnabled,
        confirm: confirmFileWrite,
      },
      projectSlot,
      ...(automatic ? { automatic: true } : { entries }),
      // The record being replaced, 512 bytes, saved before anything is sent — the same rule every
      // other overwrite in core follows.
      onBackup: downloadBackup(
        (message) => status(message, "ok"),
        () => `the pool of project slot ${projectSlot}`,
      ),
      onStatus: (message) => status(message),
    });

    if (result.cancelled) {
      status("Cancelled — nothing was sent.", "warn");
      verdictCard("Cancelled", [["Sent", "nothing"]]);
      return;
    }

    if (result.landed) {
      verdictCard("Pool written", [
        ["To", `/wavepool/${result.projectSlot}`],
        ["Was", `generation ${result.before.generation}${result.before.automatic ? ", automatic" : ""}`],
        ["Entries", automatic ? "automatic" : `${summary.used} used, ${summary.distinct} distinct`],
        ["Proof", "the entries read back are the entries sent"],
      ]);
      status(`The pool of project slot ${result.projectSlot} is written.`, "ok");
      return;
    }

    /*
     * **Name what moved.** The firmware cannot say why it refused, so the diff between what we
     * read and what is there now is the only thing that tells somebody what overwriting costs.
     */
    const moved =
      result.after === undefined
        ? []
        : diffEntries(result.before.entries, result.after.entries);

    verdictCard("Pool NOT written", [
      ["To", `/wavepool/${result.projectSlot}`],
      ["Why", result.problem ?? "the entries did not come back"],
      ...(result.after === undefined
        ? ([["Now", "the record could not be read back"]] as [string, string][])
        : ([
            ["Generation", `${result.before.generation} when read, ${result.after.generation} now`],
            [
              "Changed",
              moved.length === 0
                ? "no entry moved — so the refusal was not a concurrent edit"
                : moved
                    .slice(0, 8)
                    .map((c) => `slot ${shown(c.index)}: ${c.before ?? "—"} → ${c.after ?? "—"}`)
                    .join(", ") + (moved.length > 8 ? `, and ${moved.length - 8} more` : ""),
            ],
          ] as [string, string][])),
      ["Next", "reload to take the instrument's version, or write again to overwrite it"],
    ]);
    status(result.problem ?? "The pool was not written.", "error");
  } finally {
    writing = false;
    $<HTMLButtonElement>("poolWrite").disabled = false;
  }
}
