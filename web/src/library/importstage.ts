/**
 * Staging audio files on the wavetable store, and writing the set with one question.
 *
 * **One job: what sits between a dropped file and a write.** Decoding is `decodeaudio.ts`,
 * choosing a shape is `fit.ts`, assembling the slot is `importplan.ts`, auditioning is
 * `tableaudio.ts`, and the write itself is `waveriderwrite.ts`. This holds the staged list, draws
 * it onto the store the pane already renders, and asks once.
 *
 * ## Why staging rather than a dialog per file
 *
 * The owner chose it (option 1 of three, 2026-10-13). A drop stages; nothing is converted or sent
 * until one button is pressed, and that button asks a single question naming every slot. A sheet
 * per file would be seventy-five sheets for a pool fill, which is the problem `batchtables.ts` was
 * written to avoid, and it makes the safeguard a formality people click through rather than a
 * question they read.
 *
 * It also means **a mis-drop is corrected instead of cancelled**: a staged row drags onto another
 * slot. Nothing has happened yet, so there is nothing to undo.
 *
 * ## It draws on the store's own rows, and adds none
 *
 * Every one of the 256 slots is already a row. A staged table marks the row of the slot it will go
 * to, so the pending state is shown where the table will land rather than in a list beside it. That
 * is also why this needs no row insertion and survives the pane re-rendering: `decorate` is called
 * with the fresh body and finds its rows by `data-slot`.
 *
 * ## The write is the batch control's sequence, deliberately
 *
 * A listing read at the moment of asking, not the one on screen. Every target empty in it or the
 * whole run refuses before a byte. One question naming every slot. Then per write: the gate itself,
 * so the WRITE switch is a stop button, and a local confirm that answers yes because the person has
 * already been asked about precisely this set. It stops at the first failure. Each of those is
 * argued for in `batchtables.ts`, and this agreeing with it is the point: two write paths to the
 * same route that disagree about safety is how one of them becomes the unsafe one.
 */

import { askConfirm } from "../dialog.js";
import { $, escapeHtml } from "../dom.js";
import { type ConnectedDevice, apiTransport } from "../devicesource.js";
import { pageMessageIds } from "../messageids.js";
import { type StatusWriter } from "../statusbar.js";
import { requireWriteEnabled } from "../writeenable.js";
import { decodeTableFile, type DecodedFile } from "./decodeaudio.js";
import { auditionTable, stopAudition } from "./tableaudio.js";
import { readStoreListing } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { WAVERIDER, writeTableToSlot } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { readTableSamples } from "@noiseandmatter/dnx-core/waverider/convert.js";
import { type FitBounds, type Geometry, proposeGeometry } from "@noiseandmatter/dnx-core/waverider/fit.js";
import {
  type PlannedImport,
  placeFrom,
  planImport,
  stemFromFileName,
} from "@noiseandmatter/dnx-core/waverider/importplan.js";
import { unplayableReason } from "@noiseandmatter/dnx-core/waverider/pool.js";

/** The drag type for moving a staged table, so a drop can tell one from a file. */
const MOVE_TYPE = "application/x-dnx-staged-slot";

/** What the pane has to provide for this to work. */
export interface ImportHost {
  device(): ConnectedDevice | undefined;
  /** Store slots the reading on screen says are occupied. */
  occupied(): ReadonlySet<number>;
  /** What the instrument says it will play. */
  bounds(): FitBounds;
  status: StatusWriter;
  /**
   * Redraw from what the pane already holds.
   *
   * For staging changes, which touch nothing on the instrument: a drop, a move, a removal.
   */
  redraw(): void;
  /**
   * Ask the instrument again.
   *
   * **Only after a write**, and it has to be a real read. Redrawing from the reading in hand would
   * leave the slots that were just written still showing as free, and `occupied` still saying they
   * are available to stage onto. Nothing could be overwritten, because the write re-lists at the
   * moment of asking, but the pane would be describing an instrument that no longer exists.
   */
  reread(): Promise<void>;
}

export interface ImportStaging {
  /** Toggle with the mode. Discards anything staged on the way out. */
  show(on: boolean): void;
  /** Mark the rows of a freshly rendered store body. */
  decorate(body: HTMLTableSectionElement): void;
  /** Slots with something staged on them, which the pane treats as claimed. */
  staged(): ReadonlySet<number>;
}

/** One file, decoded and placed, with nothing sent. */
interface Staged {
  slot: number;
  fileName: string;
  stem: string;
  decoded: DecodedFile;
  geometry: Geometry;
  /** What the proposal said, kept so the note can show it after an override. */
  proposed: string;
}

export function wireImport(host: ImportHost): ImportStaging {
  /** Staged tables by store slot, which is also the uniqueness rule: one per slot. */
  const staged = new Map<number, Staged>();
  /** Which staged slot the panel is showing. */
  let picked: number | undefined;
  /** The plan for `picked`, rebuilt whenever its name or geometry changes. */
  let plan: PlannedImport | undefined;
  let writing = false;
  let bound = false;

  const panel = (): HTMLElement => $("wavimport");
  const nameBox = (): HTMLInputElement => $<HTMLInputElement>("wavimportName");
  const wavesBox = (): HTMLInputElement => $<HTMLInputElement>("wavimportWaves");
  const pointsBox = (): HTMLInputElement => $<HTMLInputElement>("wavimportPoints");

  /** Rebuild `plan` for the picked table, or clear it and say why. */
  function replan(): void {
    plan = undefined;
    const entry = picked === undefined ? undefined : staged.get(picked);
    if (!entry) return;
    try {
      plan = planImport(
        { bytes: entry.decoded.bytes, samples: entry.decoded.samples },
        { slot: entry.slot, stem: entry.stem, geometry: entry.geometry },
      );
    } catch (error: unknown) {
      // Shown in the note rather than thrown: an impossible geometry is something the person typed
      // and can type differently, not a fault.
      plan = undefined;
      host.status(String(error), "warn");
    }
  }

  function renderPanel(): void {
    const where = panel();
    if (staged.size === 0) {
      where.hidden = true;
      return;
    }
    where.hidden = false;

    $("wavimportCount").textContent =
      `${staged.size} staged ${staged.size === 1 ? "table" : "tables"}, nothing sent`;

    /*
     * **The write control is enabled from here and nowhere else.**
     *
     * It ships `disabled` in the markup, and for a while nothing ever removed that: the only line
     * clearing it sat inside `writeAll`, which cannot run until the button is pressed. The whole
     * write path was unreachable and every test still passed, because the tests read the source
     * rather than the page. Driving it from the state the panel already has is what makes that
     * impossible to repeat.
     *
     * The red WRITE switch is a separate gate and sets `aria-disabled`, not this, so the two do
     * not fight.
     */
    $<HTMLButtonElement>("wavimportWrite").disabled = staged.size === 0 || writing;

    const entry = picked === undefined ? undefined : staged.get(picked);
    const body = $("wavimportBody");
    body.hidden = entry === undefined;
    if (!entry) {
      $("wavimportNote").innerHTML =
        '<p class="hint">Click a staged row to see what it will become.</p>';
      return;
    }

    nameBox().value = entry.stem;
    wavesBox().value = String(entry.geometry.waves);
    pointsBox().value = String(entry.geometry.points);

    const bounds = host.bounds();
    const notes: string[] = [];
    notes.push(
      `<p><strong>${escapeHtml(entry.fileName)}</strong> — ${escapeHtml(entry.decoded.describedAs)}, ` +
        `${entry.decoded.channels === 1 ? "mono" : `${entry.decoded.channels} channels mixed to mono`}, ` +
        `${entry.decoded.samples.length.toLocaleString()} samples.</p>`,
    );
    notes.push(`<p>Going to store slot <strong>${entry.slot}</strong>. ${escapeHtml(entry.proposed)}</p>`);

    if (plan) {
      notes.push(`<p>${escapeHtml(plan.fit.reason)}</p>`);
      const gain = plan.converted.gain;
      if (gain > 1.001) {
        notes.push(
          `<p class="warn">Normalised by ${gain.toFixed(2)}x. The instrument does not read the ` +
            `stored gain, so this table plays at full level whatever the file's own was.</p>`,
        );
      }
      // The instrument's own bounds, not the fallback: judging the staged shape against a
      // narrower rule than the one it was proposed under would contradict the proposal.
      const unplayable = unplayableReason(
        { waves: entry.geometry.waves, points: entry.geometry.points },
        bounds,
      );
      notes.push(
        unplayable === undefined
          ? `<p class="ok">The pool plays this geometry.</p>`
          : `<p class="warn">${escapeHtml(unplayable)}</p>`,
      );
      $("wavimportName").title = plan.pending.name;
      notes.push(`<p class="hint">Stored as <code>${escapeHtml(plan.pending.name)}</code>.</p>`);
    } else {
      notes.push(`<p class="warn">This geometry cannot be built. Change the numbers.</p>`);
    }

    if (entry.decoded.peak === 0) {
      notes.push(`<p class="warn">This file decoded to silence.</p>`);
    } else if (entry.decoded.cancelled) {
      notes.push(
        `<p class="warn">Mixing the channels to mono lost most of the signal, so they are close to ` +
          `opposite phase. The first channel alone peaks at ` +
          `${entry.decoded.firstChannelPeak.toFixed(3)} and the mix at ` +
          `${entry.decoded.peak.toFixed(3)}.</p>`,
      );
    }
    if (entry.decoded.resampled) {
      notes.push(
        `<p class="warn">The browser decoded this file and may have resampled it, so the sample ` +
          `count may not be the file's own. A WAV is read exactly.</p>`,
      );
    }
    $("wavimportNote").innerHTML = notes.join("");
  }

  /** Draw the staged tables onto the store body the pane just built. */
  function decorate(body: HTMLTableSectionElement): void {
    for (const entry of staged.values()) {
      const row = body.querySelector<HTMLTableRowElement>(`tr[data-slot="${entry.slot}"]`);
      if (!row) continue;
      row.classList.add("pending");
      if (entry.slot === picked) row.classList.add("selected");
      row.draggable = true;
      const cells = row.cells;
      if (cells.length >= 2) {
        cells[1]!.innerHTML =
          `<span class="pendingmark">staged</span> ${escapeHtml(entry.stem)} ` +
          `<span class="hint">${entry.geometry.waves} x ${entry.geometry.points}</span>`;
      }
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(MOVE_TYPE, String(entry.slot));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      // Capture so this runs before the pane's own click handler picks the store slot.
      row.addEventListener(
        "click",
        (event) => {
          event.stopPropagation();
          picked = entry.slot;
          replan();
          renderPanel();
          // Re-mark without a full device read.
          for (const other of body.querySelectorAll("tr.pending.selected")) {
            other.classList.remove("selected");
          }
          row.classList.add("selected");
        },
        true,
      );
    }
  }

  /** Which slots nothing new may be staged on: occupied on the instrument, or already staged. */
  function claimed(): Set<number> {
    const all = new Set<number>(host.occupied());
    for (const slot of staged.keys()) all.add(slot);
    return all;
  }

  async function dropFiles(files: readonly File[], at: number): Promise<void> {
    const audio = files.filter((file) => file.size > 0);
    if (audio.length === 0) {
      host.status("Nothing to import: those files are empty.", "warn");
      return;
    }

    let placed;
    try {
      placed = placeFrom(at, audio.length, claimed());
    } catch (error: unknown) {
      host.status(String(error), "error");
      return;
    }

    const bounds = host.bounds();
    const failed: string[] = [];
    for (let i = 0; i < audio.length; i++) {
      const file = audio[i]!;
      const slot = placed.slots[i]!;
      host.status(`Decoding ${file.name}…`);
      try {
        const decoded = await decodeTableFile(file);
        const proposal = proposeGeometry(decoded.samples.length, bounds);
        staged.set(slot, {
          slot,
          fileName: file.name,
          stem: stemFromFileName(file.name),
          decoded,
          geometry: proposal.geometry,
          proposed: proposal.reason,
        });
        picked ??= slot;
      } catch (error: unknown) {
        failed.push(`${file.name}: ${String(error)}`);
      }
    }

    const skipped =
      placed.skipped.length === 0 ? "" : ` Slots ${placed.skipped.join(", ")} were already taken.`;
    if (failed.length > 0) {
      host.status(`${failed.length} file(s) could not be read. ${failed.join("; ")}`, "error");
    } else {
      host.status(`${audio.length} staged, nothing sent.${skipped}`, "ok");
    }

    replan();
    renderPanel();
    host.redraw();
  }

  /** Move a staged table to another slot, which is how a mis-drop is corrected. */
  async function moveStaged(from: number, to: number): Promise<void> {
    const entry = staged.get(from);
    if (!entry || from === to) return;
    if (claimed().has(to)) {
      host.status(`Slot ${to} is already taken.`, "warn");
      return;
    }
    staged.delete(from);
    staged.set(to, { ...entry, slot: to });
    if (picked === from) picked = to;
    replan();
    renderPanel();
    host.redraw();
  }

  /** The one question, then the writes. */
  async function writeAll(): Promise<void> {
    const device = host.device();
    if (!device) {
      host.status("Connect an instrument first.", "warn");
      return;
    }
    if (writing || staged.size === 0) return;

    const entries = [...staged.values()].sort((a, b) => a.slot - b.slot);

    // Plan every one before asking, so an impossible geometry stops the run at the question
    // rather than four tables in.
    const plans: PlannedImport[] = [];
    for (const entry of entries) {
      try {
        plans.push(
          planImport(
            { bytes: entry.decoded.bytes, samples: entry.decoded.samples },
            { slot: entry.slot, stem: entry.stem, geometry: entry.geometry },
          ),
        );
      } catch (error: unknown) {
        host.status(`Slot ${entry.slot} (${entry.stem}) cannot be built: ${String(error)}`, "error");
        return;
      }
    }

    /*
     * A listing read now, not the one on screen. The claim being made is that these slots are empty
     * at the moment of asking, and the pane's reading may be minutes old.
     */
    host.status("Checking the slots are still empty…");
    let listing;
    try {
      listing = await readStoreListing(apiTransport(device), pageMessageIds);
    } catch (error: unknown) {
      host.status(`Could not read the store listing: ${String(error)}`, "error");
      return;
    }
    const inTheWay = entries
      .map((entry) => listing.find((slot) => slot.slot === entry.slot))
      .filter((slot) => slot?.occupied === true)
      .map((slot) => `${slot!.slot}${slot!.name ? ` (${slot!.name})` : ""}`);
    if (inTheWay.length > 0) {
      host.status(
        `Nothing sent. These slots are no longer empty: ${inTheWay.join(", ")}. Refresh and move ` +
          `the staged tables.`,
        "error",
      );
      return;
    }

    const judgeBounds = host.bounds();
    const unplayable = entries.filter(
      (entry) =>
        unplayableReason(
          { waves: entry.geometry.waves, points: entry.geometry.points },
          judgeBounds,
        ) !== undefined,
    );
    const bytes = plans.reduce((total, one) => total + one.pending.table.length, 0);
    const lines = [
      `${entries.length} ${entries.length === 1 ? "table" : "tables"}, ` +
        `${bytes.toLocaleString()} bytes, one per slot: ` +
        entries.map((entry) => `${entry.stem} to ${entry.slot}`).join(", ") +
        `.`,
      `Every one of those slots is empty in a listing taken just now, so nothing is overwritten ` +
        `and there is no undo to need.`,
      `This is the only question. Each write still checks the WRITE switch, so switching it off ` +
        `stops the rest, and the run stops at the first slot that does not confirm.`,
    ];
    if (unplayable.length > 0) {
      lines.push(
        `${unplayable.length} of them ${unplayable.length === 1 ? "has a geometry" : "have geometries"} ` +
          `this instrument stores but does not play: ` +
          unplayable.map((entry) => `${entry.slot} (${entry.geometry.waves} x ${entry.geometry.points})`).join(", ") +
          `. They will be listed and silent.`,
      );
    }

    const ok = await askConfirm({
      title: `Write ${entries.length} ${entries.length === 1 ? "table" : "tables"} to ${WAVERIDER}?`,
      body: lines,
      confirmLabel: `Write ${entries.length} ${entries.length === 1 ? "table" : "tables"}`,
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled — nothing was sent.", "warn");
      return;
    }

    writing = true;
    $<HTMLButtonElement>("wavimportWrite").disabled = true;
    stopAudition();
    try {
      for (let i = 0; i < plans.length; i++) {
        const pending = plans[i]!.pending;
        host.status(`Writing ${i + 1} of ${plans.length}: ${pending.name} → ${WAVERIDER}/${pending.slot}…`);
        const result = await writeTableToSlot({
          transport: apiTransport(device),
          host: {
            ids: pageMessageIds,
            // Per write, deliberately: this is what makes the WRITE switch a stop button.
            gate: requireWriteEnabled,
            // Already asked, about exactly this set. Local and unexported; see the module note.
            confirm: () => Promise.resolve(true),
          },
          table: pending,
          timeoutMs: 60_000,
        });

        if (result.cancelled || result.problem !== undefined || !result.listed) {
          host.status(
            `Stopped at ${i + 1} of ${plans.length}. ${i} written. ` +
              `Slot ${pending.slot}: ${result.problem ?? "cancelled"}. ` +
              `${plans.length - i} not sent.`,
            "error",
          );
          return;
        }
        staged.delete(pending.slot);
        if (picked === pending.slot) picked = undefined;
      }
      host.status(
        `Wrote ${plans.length} ${plans.length === 1 ? "table" : "tables"}. ` +
          `${plans.length === 1 ? "It is" : "They are"} in the store and in no pool yet: click ` +
          `${plans.length === 1 ? "it" : "one"} on the right, then a pool slot on the left, and ` +
          `press Add to pool.`,
        "ok",
      );
    } finally {
      writing = false;
      $<HTMLButtonElement>("wavimportWrite").disabled = false;
      replan();
      renderPanel();
      await host.reread();
    }
  }

  function bind(): void {
    if (bound) return;
    bound = true;
    const store = $("wavestoreGrid");

    store.addEventListener("dragover", (event) => {
      const kinds = event.dataTransfer?.types ?? [];
      if (!kinds.includes("Files") && !kinds.includes(MOVE_TYPE)) return;
      // Required: without it the browser navigates to the dropped file.
      event.preventDefault();
      store.classList.add("dropping");
    });
    store.addEventListener("dragleave", (event) => {
      if (event.target === store) store.classList.remove("dropping");
    });
    store.addEventListener("drop", (event) => {
      event.preventDefault();
      store.classList.remove("dropping");

      const row = (event.target as Element | null)?.closest?.("tr[data-slot]");
      const at = row instanceof HTMLTableRowElement ? Number(row.dataset.slot) : undefined;

      const moving = event.dataTransfer?.getData(MOVE_TYPE);
      if (moving) {
        if (at !== undefined) void moveStaged(Number(moving), at);
        return;
      }
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      if (at === undefined) {
        host.status("Drop the files onto a store slot, so they have somewhere to go.", "warn");
        return;
      }
      void dropFiles(files, at);
    });

    const rebuild = (): void => {
      const entry = picked === undefined ? undefined : staged.get(picked);
      if (!entry) return;
      entry.stem = nameBox().value.trim() || entry.stem;
      const waves = Number(wavesBox().value);
      const points = Number(pointsBox().value);
      if (Number.isInteger(waves) && waves > 0 && Number.isInteger(points) && points > 0) {
        entry.geometry = { waves, points };
      }
      replan();
      renderPanel();
    };
    for (const id of ["wavimportName", "wavimportWaves", "wavimportPoints"]) {
      $(id).addEventListener("change", rebuild);
    }

    $("wavimportPlay").addEventListener("click", () => {
      if (!plan) {
        host.status("Nothing to play: this geometry cannot be built.", "warn");
        return;
      }
      const entry = staged.get(picked!)!;
      void audition(entry, false);
    });
    $("wavimportSweep").addEventListener("click", () => {
      if (!plan) return;
      void audition(staged.get(picked!)!, true);
    });
    $("wavimportStop").addEventListener("click", () => {
      stopAudition();
    });
    $("wavimportRemove").addEventListener("click", () => {
      if (picked === undefined) return;
      staged.delete(picked);
      picked = staged.keys().next().value as number | undefined;
      stopAudition();
      replan();
      renderPanel();
      host.redraw();
    });
    $("wavimportClear").addEventListener("click", () => {
      staged.clear();
      picked = undefined;
      stopAudition();
      replan();
      renderPanel();
      host.redraw();
    });
    $("wavimportWrite").addEventListener("click", () => {
      void writeAll();
    });
  }

  /**
   * Audition the **converted** table rather than the fitted floats.
   *
   * What the instrument will hold is int16, peak-normalised and quantised, and that is what the
   * preview should sound like. Playing the floats would audition something nobody will ever hear.
   */
  async function audition(entry: Staged, sweep: boolean): Promise<void> {
    if (!plan) return;
    const started = await auditionTable(
      {
        samples: readTableSamples(plan.pending.table),
        waves: entry.geometry.waves,
        points: entry.geometry.points,
        fullScale: 32_767,
      },
      { sweep },
    );
    if (!started) {
      host.status("The browser would not start audio. Click the page and try again.", "warn");
    }
  }

  return {
    show(on: boolean): void {
      if (on) {
        bind();
        renderPanel();
        return;
      }
      // Leaving the mode discards the staging. Nothing was sent, and a staged set that survived a
      // trip through Sounds mode would be a set of decisions nobody can see while they are away
      // from the pane that shows them.
      staged.clear();
      picked = undefined;
      plan = undefined;
      stopAudition();
      panel().hidden = true;
    },
    decorate,
    staged: () => new Set(staged.keys()),
  };
}
