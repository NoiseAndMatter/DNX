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
import {
  type Placed,
  clearInPool,
  freeIndices,
  placeInPool,
  planAdd,
} from "@noiseandmatter/dnx-core/waverider/pooledit.js";
import { POOL_ENTRIES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { tblLabel } from "@noiseandmatter/dnx-core/waverider/poolview.js";

export interface PoolWriteHost {
  device(): ConnectedDevice | undefined;
  /** The pool and store on screen. Accessor, not a copy: the mode re-reads it on every Refresh. */
  reading(): PoolReading | undefined;
  /** Which project's pool the mode is showing. `0` is the working project. */
  projectSlot(): number;
  /**
   * The store slots the right-hand pane has selected, in slot order.
   *
   * A list rather than one, because the pane took the house gesture: click, shift-click for a
   * run, ctrl-click to add. A drop carries the same list, so pressing the button and dragging the
   * selection do the same thing.
   */
  pickedSlots(): readonly number[];
  /** The pool index the left-hand grid has selected, when one is selected. */
  pickedIndex(): number | undefined;
  status: StatusWriter;
  /**
   * Hold the pane while this module talks to the instrument, and let it go afterwards.
   *
   * The +Drive takes one conversation at a time, and the pane's controls can start a second.
   * Released **before** `reread`, because that read is the mode's own and takes the pane itself.
   */
  lock(on: boolean): void;
  /** Read the pool and the store again, because a write changed what is out there. */
  reread(): Promise<void>;
}

export interface PoolWriting {
  /**
   * Put several stored tables into consecutive pool slots, starting at `firstIndex`.
   *
   * The drop half of the gesture. The button path goes through this too with one table, so there
   * is one implementation of *what a placement means* and the two ways of asking for it cannot
   * drift — which is the mistake the pool pane would most easily make, because a wrong index
   * looks right on screen and plays the wrong table on the instrument.
   */
  addAt(storeSlots: readonly number[], firstIndex?: number): Promise<void>;
  /** What a drop would do, for the drag's own hint. No side effects. */
  describeDrop(storeSlots: readonly number[], firstIndex: number): { label: string; status: string } | undefined;
  /**
   * Decide the control's label and whether it can be pressed, from the state the panes are in.
   *
   * **The render decides it, never the handler.** `test/librarywavetables.test.ts` keeps a standing
   * check on this shape, because the staged-import write shipped with its only `disabled = false`
   * inside the handler's own `finally` and was therefore unreachable while every test passed.
   */
  redraw(): void;
}

const ADD = "wavepoolAdd";
const REMOVE = "wavepoolRemove";

export function wirePoolWrite(host: PoolWriteHost): PoolWriting {
  let writing = false;

  /** The shown slot number, 1..128, which is what both panes and the instrument display. */
  const shown = (index: number): number => index + 1;

  function describeTable(slot: number): string {
    const row = host.reading()?.store.find((entry) => entry.slot === slot);
    return row?.name ? `${slot} (${row.name})` : `${slot}`;
  }

  function redraw(): void {
    const button = $<HTMLButtonElement>(ADD);
    const remove = $<HTMLButtonElement>(REMOVE);
    const reading = host.reading();
    const chosen = host.pickedSlots();
    const index = host.pickedIndex();

    /*
     * **The same decision the press will make, so the label cannot promise something else.**
     * This had its own copy of the occupied filter, which made three places working out what a
     * selection means: here, the drag, and the write. The label is now literally what would be
     * written.
     */
    const holding = reading ? planAdd(chosen, occupiedSlots(reading), index) : [];

    button.disabled = writing || !reading || holding.length === 0 || !host.device();
    button.textContent =
      holding.length > 1
        ? index === undefined
          ? `Add ${holding.length} to pool`
          : `Place ${holding.length} from slot ${shown(index)}`
        : index === undefined
          ? "Add to pool"
          : `Place in slot ${shown(index)}`;

    /*
     * **Remove reads the pool cell, not the store row.** The two controls take their subject from
     * opposite panes, which is why they can be enabled at different moments: a store table
     * selected with no pool cell picked can be added and not removed, and a pool cell holding a
     * table can be removed whatever the store pane has selected.
     *
     * A cell reading MISSING is removable, and deliberately so: an entry naming a store slot whose
     * table was deleted is the one a person most wants rid of, and it is the only way to get rid
     * of it.
     */
    const inPool = index === undefined ? undefined : reading?.record.entries[index];
    remove.disabled = writing || !reading || inPool === undefined || !host.device();
    remove.title =
      index === undefined
        ? "Click a pool slot on the left, then press this."
        : inPool === undefined
          ? `Pool slot ${shown(index)} is already empty.`
          : `Take store slot ${inPool} out of pool slot ${shown(index)}. The table stays in the store.`;

    /*
     * The title carries the reason it is off. A dead control with a label and no explanation is
     * the state somebody reads as a broken page, and all three reasons are things they can fix.
     */
    button.title = !reading
      ? "Read a pool first."
      : chosen.length === 0
        ? "Click a table in the store on the right, then press this. Shift-click for a run."
        : holding.length === 0
          ? "Those store slots are empty, so there is nothing to add."
          : index === undefined
            ? `Put ${holding.length === 1 ? "this table" : `these ${holding.length} tables`} in the first free pool slot onwards. Dragging them onto a slot chooses where.`
            : `Put ${holding.length === 1 ? "this table" : `these ${holding.length} tables`} in pool slot ${shown(index)} onwards, replacing whatever is there.`;
  }

  /**
   * The sentences the confirmation is built from.
   *
   * Separate from the asking so the awkward case — a project with no pool of its own — is written
   * once, in one place, where it can be read as prose rather than assembled across a handler.
   */
  function questions(reading: PoolReading, placed: readonly Placed[]): string[] {
    const where = host.projectSlot() === 0 ? "the working project" : `project slot ${host.projectSlot()}`;
    const lines: string[] = [];

    if (placed.length === 1) {
      const one = placed[0]!;
      lines.push(
        `Store slot ${describeTable(one.storeSlot)} goes into pool slot ${shown(one.index)} of ` +
          `${where}. On the instrument its TBL reads ${tblLabel(one.index)}.`,
      );
    } else {
      lines.push(
        `${placed.length} tables go into ${where}, one per slot: ` +
          placed.map((one) => `${describeTable(one.storeSlot)} to ${shown(one.index)}`).join(", ") +
          `. On the instrument they read ${tblLabel(placed[0]!.index)} to ` +
          `${tblLabel(placed[placed.length - 1]!.index)}.`,
      );
    }

    const replacing = placed.filter((one) => one.replaced !== undefined);
    if (replacing.length > 0) {
      lines.push(
        `${replacing.length === 1 ? "One of those slots names" : `${replacing.length} of those slots name`} ` +
          `a table today: ` +
          replacing.map((one) => `slot ${shown(one.index)} names ${describeTable(one.replaced!)}`).join(", ") +
          `. Those tables stay in the store; it is this project's entries that change, so every ` +
          `sound set to those numbers plays the new ones from now on.`,
      );
    }

    /*
     * **The conversion, said plainly, and only where there is one.** A project that follows the
     * store plays every stored table, so writing a list pins what it plays today and stops new
     * tables joining — a change to how the project behaves, which nobody asks for by dropping a
     * table on a slot. A project with *no* pool plays nothing, so there is nothing to pin and
     * saying there is would be a warning about a loss that cannot happen.
     */
    if (reading.summary.kind === "follows-store") {
      lines.push(
        `This project follows the store: it plays every stored table in store-slot order. ` +
          `Writing a list pins the ${reading.summary.tables} table(s) it plays today at the slots ` +
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

  /**
   * Write a whole pool record and say how it went.
   *
   * **One copy, because adding and removing differ only in the entries and the sentence.** Two
   * copies of this would have to be kept in step through the gate, the backup, the cancelled case
   * and the three ways a write can fail to land — and the half nobody exercised would be the one
   * that drifted.
   *
   * `describe` is a function rather than a string so a caller can build its sentence from the
   * reading it had **before** the write, without that sentence being computed for a write that
   * was then cancelled.
   */
  async function send(
    device: ConnectedDevice,
    entries: readonly (number | undefined)[],
    describe: () => string,
  ): Promise<void> {
    const where = host.projectSlot() === 0 ? "the working project" : `project slot ${host.projectSlot()}`;

    writing = true;
    host.lock(true);
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
        entries,
        onBackup: downloadBackup(
          (message) => host.status(message, "ok"),
          () => `the pool of ${where}`,
        ),
        onStatus: (message) => host.status(message),
      });

      if (result.cancelled) {
        host.status("Cancelled — nothing was sent.", "warn");
        return;
      }

      if (result.landed) {
        host.status(describe(), "ok");
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
      host.lock(false);
      // The reading in hand is now wrong about this project, so the pane asks the instrument
      // again rather than redrawing what it had. `redraw` follows from the mode's own render.
      await host.reread();
      redraw();
    }
  }

  /**
   * The question before a table leaves a pool.
   *
   * The consequence is the whole of it: the table is not deleted, the slot does not close up, and
   * **every sound set to that number stops playing anything**. None of those is obvious from a
   * button called Remove from pool.
   */
  function removalQuestions(reading: PoolReading, index: number, storeSlot: number): string[] {
    const where = host.projectSlot() === 0 ? "the working project" : `project slot ${host.projectSlot()}`;
    const stillThere = reading.store.find((e) => e.slot === storeSlot)?.occupied === true;

    const lines = [
      `Pool slot ${shown(index)} of ${where} stops naming store slot ${describeTable(storeSlot)}.` +
        (stillThere
          ? ` The table stays in the store and every other project keeps it.`
          : ` That store slot is empty anyway — this clears an entry pointing at a table that is` +
            ` already gone.`),
      `Any sound whose TBL reads ${tblLabel(index)} will play the built-in Prim. from then on. ` +
        `Nothing renumbers: the slots after this one stay exactly where they are, and this one ` +
        `becomes the first free slot, so the next table added with no slot chosen lands here.`,
    ];

    if (reading.summary.kind === "follows-store") {
      lines.push(
        `This project follows the store: it plays every stored table in store-slot order. ` +
          `Writing a list pins the ${reading.summary.tables} table(s) it plays today at the slots ` +
          `they are in now, minus the one you are taking out. After this, a table written into ` +
          `the store no longer joins this project on its own.`,
      );
    }

    lines.push(
      `The 512-byte record being replaced is saved as a file first, which is the only undo there is.`,
    );
    return lines;
  }

  async function remove(): Promise<void> {
    const device = host.device();
    const reading = host.reading();
    const index = host.pickedIndex();
    if (!device || !reading || index === undefined || writing) return;

    const storeSlot = reading.record.entries[index];
    if (storeSlot === undefined) {
      host.status(`Pool slot ${shown(index)} is already empty.`, "info");
      return;
    }

    let edit;
    try {
      edit = clearInPool(reading.record.entries, [index]);
    } catch (error: unknown) {
      host.status(String(error instanceof Error ? error.message : error), "error");
      return;
    }

    const ok = await askConfirm({
      title: `Take store slot ${storeSlot} out of pool slot ${shown(index)}?`,
      body: removalQuestions(reading, index, storeSlot),
      confirmLabel: "Write the pool",
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled — nothing was sent.", "warn");
      return;
    }

    await send(device, edit.entries, () =>
      `Pool slot ${shown(index)} is empty. Store slot ${storeSlot} is still in the store.`);
  }

  /**
   * Where a run of tables would land, and what it would displace.
   *
   * Pure: the drag asks it on every `dragover`, so it must not read the instrument or change
   * anything. `undefined` means the drop is refused, which the grid shows as the browser's own
   * "no" cursor rather than a message nobody asked for.
   */
  /** Store slots the instrument's listing says hold a table. The only ones a pool may name. */
  function occupiedSlots(reading: PoolReading): Set<number> {
    return new Set(reading.store.filter((entry) => entry.occupied).map((entry) => entry.slot));
  }

  function describeDrop(
    storeSlots: readonly number[],
    firstIndex: number,
  ): { label: string; status: string } | undefined {
    const reading = host.reading();
    if (!reading) return undefined;

    // The same decision the drop will make, so the hint cannot describe a different write.
    const requests = planAdd(storeSlots, occupiedSlots(reading), firstIndex);
    if (requests.length === 0) return undefined;

    const last = firstIndex + requests.length - 1;
    if (firstIndex < 0 || last >= POOL_ENTRIES) return undefined;

    const replacing = requests.filter(
      (request) => reading.record.entries[request.index!] !== undefined,
    ).length;

    const where =
      requests.length === 1
        ? `pool slot ${shown(firstIndex)}`
        : `pool slots ${shown(firstIndex)} to ${shown(last)}`;
    return {
      label: requests.length === 1 ? "add" : `add ${requests.length}`,
      status:
        `${requests.length} table(s) into ${where}` +
        (replacing === 0 ? ", replacing nothing" : `, replacing ${replacing}`),
    };
  }

  async function addAt(storeSlots: readonly number[], firstIndex?: number): Promise<void> {
    const device = host.device();
    const reading = host.reading();
    if (!device || !reading || writing || storeSlots.length === 0) return;

    const requests = planAdd(storeSlots, occupiedSlots(reading), firstIndex);
    if (requests.length === 0) {
      host.status("Those store slots are empty, so there is nothing to add.", "warn");
      return;
    }

    if (firstIndex !== undefined) {
      const last = firstIndex + requests.length - 1;
      if (last >= POOL_ENTRIES) {
        host.status(
          `${requests.length} tables starting at pool slot ${shown(firstIndex)} would run past ` +
            `slot ${POOL_ENTRIES}. Drop them further up the pool.`,
          "warn",
        );
        return;
      }
    }

    let placement;
    try {
      placement = placeInPool(reading.record.entries, requests);
    } catch (error: unknown) {
      // The refusals name the pool and the way out — a full pool says to name the slot to replace.
      host.status(String(error instanceof Error ? error.message : error), "error");
      return;
    }

    /*
     * **A write that changes nothing is refused, unless it would change the kind of pool.** It
     * costs a confirmation, a saved file and an overwrite of somebody's record to achieve nothing.
     * The exception matters: on a project with no list of its own, writing the same entries is
     * what pins them, so it is a real act and goes ahead.
     */
    const changes = placement.placed.some(
      (one) => reading.record.entries[one.index] !== one.storeSlot,
    );
    if (reading.summary.authored && !changes) {
      host.status(
        placement.placed.length === 1
          ? `Pool slot ${shown(placement.placed[0]!.index)} already names store slot ` +
            `${placement.placed[0]!.storeSlot}. Nothing to write.`
          : `Those pool slots already name those tables. Nothing to write.`,
        "info",
      );
      return;
    }

    const free = freeIndices(placement.entries).length;
    const landed = placement.placed;
    const first = landed[0]!.index;
    const last = landed[landed.length - 1]!.index;

    const ok = await askConfirm({
      title:
        landed.length === 1
          ? landed[0]!.replaced === undefined
            ? `Add store slot ${landed[0]!.storeSlot} to pool slot ${shown(first)}?`
            : `Replace pool slot ${shown(first)} with store slot ${landed[0]!.storeSlot}?`
          : `Put ${landed.length} tables into ${describeSlots(landed)}?`,
      body: questions(reading, landed),
      confirmLabel: "Write the pool",
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled — nothing was sent.", "warn");
      return;
    }

    await send(device, placement.entries, () =>
      (landed.length === 1
        ? `Pool slot ${shown(first)} now names store slot ${landed[0]!.storeSlot}.`
        : `${describeSlots(landed)} now name ${landed.length} tables.`) +
      ` ${free} pool slot(s) free.` +
      (reading.summary.kind === "list" ? "" : " This project now has a pool of its own.") +
      (last === first ? "" : ""));
  }

  /** "pool slots 5 to 7", or the individual numbers when a press scattered them among the free. */
  function describeSlots(landed: readonly Placed[]): string {
    const indices = landed.map((one) => one.index);
    const consecutive = indices.every((index, nth) => nth === 0 || index === indices[nth - 1]! + 1);
    return consecutive && indices.length > 1
      ? `pool slots ${shown(indices[0]!)} to ${shown(indices[indices.length - 1]!)}`
      : `pool slot(s) ${indices.map(shown).join(", ")}`;
  }

  /** The button path. It names no pool slot unless one is picked, which is the whole difference. */
  async function add(): Promise<void> {
    const chosen = host.pickedSlots();
    if (chosen.length === 0) return;
    await addAt(chosen, host.pickedIndex());
  }

  $(ADD).addEventListener("click", () => {
    void add();
  });
  $(REMOVE).addEventListener("click", () => {
    void remove();
  });

  return { redraw, addAt, describeDrop };
}
