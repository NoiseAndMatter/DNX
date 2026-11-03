/**
 * The two controls for a build with no tables of its own: install the originals, and keep an
 * older project's saved `TBL` values.
 *
 * **One job: when they show, and the install.** The tables are `waverider/originaltables.ts`, the
 * write is `writeTablesToSlots`, and the pool shift is `poolwrite.ts`, which owns the pool's writes.
 * Both controls show only when the instrument reports `poolOnly`, and neither runs without a question.
 */

import { askConfirm } from "../dialog.js";
import { $ } from "../dom.js";
import { type ConnectedDevice, apiTransport } from "../devicesource.js";
import { pageMessageIds } from "../messageids.js";
import { type StatusWriter } from "../statusbar.js";
import { requireWriteEnabled } from "../writeenable.js";
import { whileWriting } from "../writing.js";
import { importOutcome } from "./importoutcome.js";
import type { PoolReading } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { writeTablesToSlots } from "@noiseandmatter/dnx-core/device/waveriderbatch.js";
import type { FitBounds } from "@noiseandmatter/dnx-core/waverider/fit.js";
import {
  freeStoreSlots,
  missingOriginalTables,
  originalTablePending,
  originalTableSlot,
} from "@noiseandmatter/dnx-core/waverider/originaltables.js";

export interface OriginalTablesHost {
  device(): ConnectedDevice | undefined;
  reading(): PoolReading | undefined;
  /** The instrument reports `poolOnly`. */
  poolOnly(): boolean;
  /** Store slots with an import staged on them, which an install must not take. */
  claimed(): ReadonlySet<number>;
  bounds(): FitBounds;
  status: StatusWriter;
  lock(on: boolean): boolean;
  reread(): Promise<void>;
  /** The confirmed pool shift. See `PoolWriting.keepOldValues`. */
  keepOldValues(harmSlot: number): Promise<void>;
}

export interface OriginalTables {
  /** Decide each control's state from the panes. The render owns it, never the handler. */
  redraw(): void;
}

const INSTALL = "wavepoolOriginals";
const KEEP_OLD = "wavepoolKeepOld";

export function wireOriginalTables(host: OriginalTablesHost): OriginalTables {
  let writing = false;

  function redraw(): void {
    const install = $<HTMLButtonElement>(INSTALL);
    const keepOld = $<HTMLButtonElement>(KEEP_OLD);
    const reading = host.reading();
    const on = host.poolOnly() && reading !== undefined;
    const missing = on ? missingOriginalTables(reading.store) : [];
    const harm = on ? originalTableSlot(reading.store, "Harm.") : undefined;

    install.hidden = missing.length === 0;
    install.textContent = `Install ${missing.map((table) => table.name).join(" and ")}`;
    install.disabled = writing || !host.device();

    keepOld.hidden = harm === undefined || reading?.record.entries[0] === harm;
    keepOld.disabled = writing || !host.device();

    $("wavepoolOriginalsBar").hidden = install.hidden && keepOld.hidden;
  }

  async function install(): Promise<void> {
    const device = host.device();
    const reading = host.reading();
    if (!device || !reading || writing) return;

    const missing = missingOriginalTables(reading.store);
    let tables;
    try {
      const slots = freeStoreSlots(reading.store, missing.length, host.claimed());
      tables = await Promise.all(missing.map(async (table, nth) => {
        const response = await fetch(`vendor/tables/${table.file}`);
        if (!response.ok) throw new Error(`${table.file} did not load (${response.status}).`);
        const wav = new Uint8Array(await response.arrayBuffer());
        return originalTablePending(table.name, wav, slots[nth]!);
      }));
    } catch (error: unknown) {
      host.status(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    if (!host.lock(true)) return;
    writing = true;
    redraw();
    const bounds = host.bounds();
    let outcome;
    try {
      outcome = await whileWriting(() => writeTablesToSlots({
        transport: apiTransport(device),
        host: {
          ids: pageMessageIds,
          gate: requireWriteEnabled,
          ask: (asked) => askConfirm({
            title: `Install ${asked.map((table) => table.name).join(" and ")}?`,
            body: [
              asked.map((table) => `${table.name} goes to store slot ${table.slot}`).join(", ") + `.`,
              `The store is shared by all projects. No table is replaced, and no pool changes.`,
              `To play a table, add it to the pool of a project.`,
            ],
            confirmLabel: "Install",
            danger: true,
          }),
        },
        tables,
        ...(bounds === undefined ? {} : { playable: bounds }),
        onWriting: (done, total, table) =>
          host.status(`Writing ${done + 1} of ${total}: ${table.name}…`),
      }));
    } finally {
      writing = false;
      host.lock(false);
    }
    await host.reread();
    host.status(...importOutcome(outcome, tables.length));
  }

  $(INSTALL).addEventListener("click", () => {
    void install();
  });
  $(KEEP_OLD).addEventListener("click", () => {
    const reading = host.reading();
    const harm = reading && originalTableSlot(reading.store, "Harm.");
    if (harm !== undefined) void host.keepOldValues(harm);
  });

  return { redraw };
}
