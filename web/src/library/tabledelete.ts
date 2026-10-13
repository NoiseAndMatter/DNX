/**
 * Deleting a stored wavetable from the Library's Wavetables mode.
 *
 * **One job: freeing a store slot from this page.** A sibling of `poolwrite.ts` rather than part
 * of it, because the two change different things: a pool write edits one project's list, and this
 * removes the table itself from the store that every project shares. Putting them together would
 * make one module that answers "what does this change" with "it depends".
 *
 * The careful part — the listing, the copy taken before the question, the delete, and the second
 * listing that proves it — is `device/waveriderdelete.ts`. It used to live in the probe page,
 * where nobody managing a library would find it.
 *
 * ## What the question has to say, and what it honestly cannot
 *
 * A pool entry names a **store slot**, not a table. So deleting a table leaves every entry that
 * named it pointing at an empty slot, which the pane then draws as MISSING, and any sound set to
 * that number plays the built-in Prim.
 *
 * This page has read **one** project's pool. It can name the slots in that pool exactly, and it
 * must not imply anything about the other 128 — so it says which project it checked and that the
 * others were not read, rather than producing a reassuring count that covers a fraction of the
 * card.
 *
 * The sharper case comes from the firmware session, 2026-10-13: a store slot refilled later makes
 * every entry still pointing there play the **new** table, silently, in every project. That is
 * why the confirmation suggests clearing the entries rather than leaving them, and why it says so
 * before the delete rather than after.
 */

import { askConfirm } from "../dialog.js";
import { $ } from "../dom.js";
import { type ConnectedDevice, apiTransport } from "../devicesource.js";
import { pageMessageIds } from "../messageids.js";
import { type StatusWriter } from "../statusbar.js";
import { downloadBackup } from "../safewriteui.js";
import { requireWriteEnabled } from "../writeenable.js";
import { type PoolReading } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { deleteTableSlot } from "@noiseandmatter/dnx-core/device/waveriderdelete.js";
import { tblLabel } from "@noiseandmatter/dnx-core/waverider/poolview.js";

export interface TableDeleteHost {
  device(): ConnectedDevice | undefined;
  reading(): PoolReading | undefined;
  /** Which project's pool is on screen, so the warning can say which one it checked. */
  projectSlot(): number;
  /** The store slot the preview is showing, which is the one this acts on. */
  previewSlot(): number | undefined;
  status: StatusWriter;
  reread(): Promise<void>;
}

export interface TableDeleting {
  /** Decide the control's state from the panes. The render owns it, never the handler. */
  redraw(): void;
}

const BUTTON = "waveTableDelete";

export function wireTableDelete(host: TableDeleteHost): TableDeleting {
  let deleting = false;

  function redraw(): void {
    const button = $<HTMLButtonElement>(BUTTON);
    const reading = host.reading();
    const slot = host.previewSlot();
    const row = slot === undefined ? undefined : reading?.store.find((e) => e.slot === slot);
    const occupied = row?.occupied === true;

    button.disabled = deleting || !reading || !occupied || !host.device();
    button.title = !reading
      ? "Read the store first."
      : slot === undefined
        ? "Click a table in the store on the right, then press this."
        : !occupied
          ? `Store slot ${slot} is empty, so there is nothing to delete.`
          : `Delete store slot ${slot} from the instrument. A copy is saved first.`;
  }

  /** The sentences before a table goes. See this module's note on what it may and may not claim. */
  function questions(reading: PoolReading, slot: number, name: string): string[] {
    const where = host.projectSlot() === 0 ? "the working project" : `project slot ${host.projectSlot()}`;
    const named = reading.summary.byStoreSlot.get(slot) ?? [];

    const lines = [
      `Store slot ${slot}${name ? ` (${name})` : ""} is removed from the instrument. The store is ` +
        `shared, so it goes for every project, not just this one.`,
      `A copy is saved to your computer before anything is sent. There is no undo on the ` +
        `instrument itself — that copy is the only way back.`,
    ];

    if (named.length > 0) {
      lines.push(
        `${named.length === 1 ? "Pool slot" : "Pool slots"} ` +
          `${named.map((index) => shownOf(index)).join(", ")} of ${where} ` +
          `${named.length === 1 ? "names" : "name"} this table. ` +
          `${named.length === 1 ? "It" : "They"} will read MISSING afterwards, and a sound whose ` +
          `TBL reads ${named.map((index) => tblLabel(index)).join(" or ")} will play the ` +
          `built-in Prim.`,
      );
    } else {
      lines.push(`No pool slot of ${where} names this table.`);
    }

    /*
     * **The honest limit.** One pool has been read. Saying nothing about the rest would let
     * somebody read the line above as "nothing points at this", which is a claim this page has no
     * evidence for.
     */
    lines.push(
      `Only ${where}'s pool has been read. Any of the other projects may also name store slot ` +
        `${slot}, and DNX has not looked.`,
      `If you later write a different table into slot ${slot}, every entry still pointing there ` +
        `plays that new table instead — in every project, with nothing on screen having changed. ` +
        `Taking those entries out with Remove from pool is what avoids it.`,
    );
    return lines;
  }

  /** A pool index as both panes show it, 1..128. */
  const shownOf = (index: number): number => index + 1;

  async function run(): Promise<void> {
    const device = host.device();
    const reading = host.reading();
    const slot = host.previewSlot();
    if (!device || !reading || slot === undefined || deleting) return;

    const row = reading.store.find((e) => e.slot === slot);
    if (row?.occupied !== true) {
      host.status(`Store slot ${slot} is empty — nothing to delete.`, "warn");
      return;
    }
    const name = row.name ?? "";

    const ok = await askConfirm({
      title: `Delete store slot ${slot}${name ? ` — ${name}` : ""}?`,
      body: questions(reading, slot, name),
      confirmLabel: "Delete the table",
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled — nothing was sent.", "warn");
      return;
    }

    deleting = true;
    redraw();
    try {
      const result = await deleteTableSlot({
        transport: apiTransport(device),
        host: {
          ids: pageMessageIds,
          gate: requireWriteEnabled,
          // Already asked, about exactly this table. Local and unexported; see the module note.
          confirm: () => Promise.resolve(true),
        },
        slot,
        onBackup: downloadBackup(
          (message) => host.status(message, "ok"),
          () => `store slot ${slot}${name ? ` (${name})` : ""}`,
        ),
        onStatus: (message) => host.status(message),
        timeoutMs: 60_000,
      });

      if (result.cancelled) {
        host.status("Cancelled — nothing was sent.", "warn");
        return;
      }
      if (result.deleted) {
        const named = reading.summary.byStoreSlot.get(slot) ?? [];
        host.status(
          `Store slot ${slot} is empty.` +
            (named.length === 0
              ? ""
              : ` Pool slot(s) ${named.map(shownOf).join(", ")} now read MISSING.`),
          named.length === 0 ? "ok" : "warn",
        );
        return;
      }
      host.status(
        `The table was not deleted. ${result.problem ?? "The slot is still listed as in use."}`,
        "error",
      );
    } catch (error: unknown) {
      host.status(`The delete failed: ${String(error)}`, "error");
    } finally {
      deleting = false;
      // The store listing in hand is now wrong, so the pane asks the instrument again.
      await host.reread();
      redraw();
    }
  }

  $(BUTTON).addEventListener("click", () => {
    void run();
  });

  return { redraw };
}
