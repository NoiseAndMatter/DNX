/**
 * Putting a stored table into a project's pool, from the Library's Wavetables mode.
 *
 * **One job: the pool half of this mode's writing.** `importstage.ts` puts tables *into the store*;
 * this puts a stored table *into a project's list*, which is the step that decides whether a sound
 * can reach it at all. They are deliberately separate modules and separate questions, because a
 * table in the store and in no pool is a real state somebody may want — the store is shared by
 * every project and the pool is one project's choice.
 *
 * ## Why an import does not do this on its own
 *
 * It could append each imported table to the first free pool slot, and the first draft was going to.
 * The owner's instruction on 2026-10-13 settled it the other way: *the user will curate the pool and
 * make sure that things are in the correct pool location for them to play when called by number.*
 * The pool slot **is** the number a sound reaches, so choosing it is the point of keeping a pool,
 * and a tool that silently decided it would be taking away the only thing the list is for.
 *
 * So the flow is two deliberate gestures: drop files on the store and write them, then pick a table
 * and pick a slot. The right pane says a table is in no pool, so the gap announces itself.
 *
 * ## The one thing this has to say out loud
 *
 * A project with no pool of its own plays every stored table in store-slot order. **Writing a pool
 * for it is not only an addition** — it pins the tables it plays today at the positions they are in
 * now, and from then on a table added to the store no longer joins that project by itself. That is
 * usually what somebody wants and it is never what they asked for in words, so the confirmation
 * says it before anything is sent. `poolState` is what distinguishes the case; the record carries
 * it and `pooledit.ts` deliberately cannot see it.
 *
 * ## Everything else is the house write path
 *
 * `writePool` reads the record, hands it to the backup hook, sends the whole 512 bytes carrying the
 * generation it just read as a compare-and-swap token, and proves the write by reading the entries
 * back. The gate is passed to it rather than checked here, the question is asked once, and the
 * hook that answers the per-write confirm is local to this file so nothing else can pick up a
 * confirm that says yes.
 */

import { askConfirm } from "../dialog.js";
import { $ } from "../dom.js";
import { type ConnectedDevice, apiTransport } from "../devicesource.js";
import { pageMessageIds } from "../messageids.js";
import { type StatusWriter } from "../statusbar.js";
import { downloadBackup } from "../safewriteui.js";
import { requireWriteEnabled } from "../writeenable.js";
import { type PoolReading } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { writePool } from "@noiseandmatter/dnx-core/device/wavepoolwrite.js";
import { freeIndices, placeInPool } from "@noiseandmatter/dnx-core/waverider/pooledit.js";

export interface PoolWriteHost {
  device(): ConnectedDevice | undefined;
  /** The pool and store on screen. Accessor, not a copy: the mode re-reads it on every Refresh. */
  reading(): PoolReading | undefined;
  /** Which project's pool the mode is showing. `0` is the working project. */
  projectSlot(): number;
  /** The store slot the right-hand pane has selected, when one is selected. */
  pickedSlot(): number | undefined;
  /** The pool index the left-hand grid has selected, when one is selected. */
  pickedIndex(): number | undefined;
  status: StatusWriter;
  /** Read the pool and the store again, because a write changed what is out there. */
  reread(): Promise<void>;
}

export interface PoolWriting {
  /**
   * Decide the control's label and whether it can be pressed, from the state the panes are in.
   *
   * **The render decides it, never the handler.** `test/librarywavetables.test.ts` keeps a standing
   * check on this shape, because the staged-import write shipped with its only `disabled = false`
   * inside the handler's own `finally` and was therefore unreachable while every test passed.
   */
  redraw(): void;
}

const BUTTON = "wavepoolAdd";

export function wirePoolWrite(host: PoolWriteHost): PoolWriting {
  let writing = false;

  /** The shown slot number, 1..128, which is what both panes and the instrument display. */
  const shown = (index: number): number => index + 1;

  /** What a sound stores in TBL to reach a pool index. See 8w on the three numbers. */
  const coarse = (index: number): number => index + 2;

  function describeTable(slot: number): string {
    const row = host.reading()?.store.find((entry) => entry.slot === slot);
    return row?.name ? `${slot} (${row.name})` : `${slot}`;
  }

  function redraw(): void {
    const button = $<HTMLButtonElement>(BUTTON);
    const reading = host.reading();
    const slot = host.pickedSlot();
    const index = host.pickedIndex();

    const row = slot === undefined ? undefined : reading?.store.find((e) => e.slot === slot);
    const holdsTable = row?.occupied === true;

    button.disabled = writing || !reading || !holdsTable || !host.device();
    button.textContent = index === undefined ? "Add to pool" : `Place in slot ${shown(index)}`;

    /*
     * The title carries the reason it is off. A dead control with a label and no explanation is
     * the state somebody reads as a broken page, and all three reasons are things they can fix.
     */
    button.title = !reading
      ? "Read a pool first."
      : slot === undefined
        ? "Click a table in the store on the right, then press this."
        : !holdsTable
          ? `Store slot ${slot} is empty, so there is no table to add.`
          : index === undefined
            ? "Put this table in the first free pool slot."
            : `Put this table in pool slot ${shown(index)}, replacing whatever it names now.`;
  }

  /**
   * The sentences the confirmation is built from.
   *
   * Separate from the asking so the awkward case — a project with no pool of its own — is written
   * once, in one place, where it can be read as prose rather than assembled across a handler.
   */
  function questions(
    reading: PoolReading,
    slot: number,
    index: number,
    replaced: number | undefined,
  ): string[] {
    const where = host.projectSlot() === 0 ? "the working project" : `project slot ${host.projectSlot()}`;
    const lines = [
      `Store slot ${describeTable(slot)} goes into pool slot ${shown(index)} of ${where}. A sound ` +
        `reaches it as TBL ${coarse(index)}.`,
    ];

    if (replaced !== undefined) {
      lines.push(
        `Pool slot ${shown(index)} names store slot ${describeTable(replaced)} today. That table ` +
          `stays in the store; it is this project's entry that changes, so every sound set to TBL ` +
          `${coarse(index)} plays the new one from now on.`,
      );
    }

    if (!reading.summary.authored) {
      /*
       * **The conversion, said plainly.** This project has no list of its own, so what is on screen
       * is the firmware's answer rather than anybody's choice, and writing a list is a change to how
       * the project behaves rather than only an addition to it. Somebody who presses *Add to pool*
       * is not asking for that and has to be told.
       */
      lines.push(
        `This project has no pool of its own: it plays every stored table in store-slot order. ` +
          `Writing one pins the ${reading.summary.tables} table(s) it plays today at the slots ` +
          `they are in now, and adds yours. After this, a table written into the store no longer ` +
          `joins this project on its own — you place it, as you are doing here.`,
      );
    }

    lines.push(
      `The 512-byte record being replaced is saved as a file first, which is the only undo there is.`,
      `The generation just read goes with the write, so an edit on the instrument's front panel in ` +
        `between is refused and nothing is written.`,
    );
    return lines;
  }

  async function add(): Promise<void> {
    const device = host.device();
    const reading = host.reading();
    const slot = host.pickedSlot();
    if (!device || !reading || slot === undefined || writing) return;

    const asked = host.pickedIndex();

    let placement;
    try {
      placement = placeInPool(
        reading.record.entries,
        [asked === undefined ? { storeSlot: slot } : { storeSlot: slot, index: asked }],
      );
    } catch (error: unknown) {
      // The refusals name the pool and the way out — a full pool says to name the slot to replace.
      host.status(String(error instanceof Error ? error.message : error), "error");
      return;
    }

    const landed = placement.placed[0]!;

    /*
     * **A write that changes nothing is refused, unless it would change the kind of pool.** It
     * costs a confirmation, a saved file and an overwrite of somebody's record to achieve nothing.
     * The exception matters: on a project with no list of its own, writing the same entries is
     * what pins them, so it is a real act and goes ahead.
     */
    if (reading.summary.authored && reading.record.entries[landed.index] === slot) {
      host.status(
        `Pool slot ${shown(landed.index)} already names store slot ${slot}. Nothing to write.`,
        "info",
      );
      return;
    }

    const free = freeIndices(placement.entries).length;
    const ok = await askConfirm({
      title:
        landed.replaced === undefined
          ? `Add store slot ${slot} to pool slot ${shown(landed.index)}?`
          : `Replace pool slot ${shown(landed.index)} with store slot ${slot}?`,
      body: questions(reading, slot, landed.index, landed.replaced),
      confirmLabel: "Write the pool",
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled — nothing was sent.", "warn");
      return;
    }

    writing = true;
    redraw();
    try {
      const result = await writePool({
        transport: apiTransport(device),
        host: {
          ids: pageMessageIds,
          // Per write, as every path in core takes it: the WRITE switch is a stop button.
          gate: requireWriteEnabled,
          // Already asked, about exactly this edit. Local and unexported; see the module note.
          confirm: () => Promise.resolve(true),
        },
        projectSlot: host.projectSlot(),
        entries: placement.entries,
        onBackup: downloadBackup(
          (message) => host.status(message, "ok"),
          () => `the pool of ${host.projectSlot() === 0 ? "the working project" : `project slot ${host.projectSlot()}`}`,
        ),
        onStatus: (message) => host.status(message),
      });

      if (result.cancelled) {
        host.status("Cancelled — nothing was sent.", "warn");
        return;
      }

      if (result.landed) {
        host.status(
          `Pool slot ${shown(landed.index)} now names store slot ${slot}. ` +
            `${free} pool slot(s) free.` +
            (reading.summary.authored ? "" : " This project now has a pool of its own."),
          "ok",
        );
        return;
      }

      /*
       * **Not landed is two different things and the firmware cannot tell them apart.** A stale
       * write and a malformed one both answer ok and change nothing, so the guess is labelled as
       * one and the record on the instrument is named rather than assumed.
       */
      host.status(
        `The pool was not written. ${result.problem ?? "The entries read back are not the ones sent."}` +
          (result.probablyStale === true
            ? ` The generation moved by something other than this write, so the likeliest cause is ` +
              `an edit on the front panel between the read and the write. Press Refresh and look ` +
              `before trying again.`
            : ""),
        "error",
      );
    } catch (error: unknown) {
      host.status(`The pool write failed: ${String(error)}`, "error");
    } finally {
      writing = false;
      // The reading in hand is now wrong about this project, so the pane asks the instrument
      // again rather than redrawing what it had. `redraw` follows from the mode's own render.
      await host.reread();
      redraw();
    }
  }

  $(BUTTON).addEventListener("click", () => {
    void add();
  });

  return { redraw };
}
