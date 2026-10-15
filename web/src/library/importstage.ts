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
import { WAVERIDER } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import {
  type BatchWriteOutcome, writeTablesToSlots,
} from "@noiseandmatter/dnx-core/device/waveriderbatch.js";
import { importOutcome } from "./importoutcome.js";
import { readTableSamples } from "@noiseandmatter/dnx-core/waverider/convert.js";
import {
  type PendingSlot,
  pendingFromSlotFile,
} from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { type FitBounds, type Geometry, proposeGeometry } from "@noiseandmatter/dnx-core/waverider/fit.js";
import {
  type ImportChoice,
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
   * Hold the pane while this module talks to the instrument, and let it go afterwards.
   *
   * The +Drive takes one conversation at a time, and the pane's controls can start a second.
   * Released **before** `reread`, because the mode's own refresh is the next conversation and a
   * lock still held would make it refuse itself.
   */
  lock(on: boolean): void;
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
/**
 * A table waiting to be written, from one of the two kinds of file this pane accepts.
 *
 * **A union rather than optional fields, because the two are not the same thing.** An import has
 * audio behind it and a geometry somebody can change; a restore has an instrument's own slot file
 * behind it and a geometry that must not be touched — changing it would resample a table that is
 * already in the instrument's form. Optional fields would have let the geometry boxes edit a
 * restore, which is the one thing a restore must not allow.
 */
type Staged =
  | {
      kind: "audio";
      slot: number;
      fileName: string;
      stem: string;
      decoded: DecodedFile;
      geometry: Geometry;
      /**
       * The shape the file already is, when its sample count divides into one exactly.
       *
       * Kept from the proposal so a resample can say what it started from: *from 15 x 2048 to
       * 64 x 2048* is the change somebody made, where *resampled to 64 x 2048* hides half of it.
       * Absent when nothing divided, and the panel then names the sample count instead.
       */
      source?: Geometry;
      /**
       * Blend up from `source` instead of re-cutting the file. Off unless somebody turns it on:
       * the re-cut is the default the owner chose to keep. Only offered when `source` exists.
       */
      blend: boolean;
    }
  | {
      kind: "copy";
      slot: number;
      fileName: string;
      stem: string;
      /** Straight from the saved file. Nothing is converted and nothing is recomputed. */
      pending: PendingSlot;
    };

/** What would be written for a staged entry, whichever kind it is. */
function pendingFor(entry: Staged, plan: PlannedImport | undefined): PendingSlot | undefined {
  return entry.kind === "copy" ? { ...entry.pending, slot: entry.slot } : plan?.pending;
}

/** The shape a staged entry will be written at: chosen for an import, fixed for a restore. */
function geometryOf(entry: Staged): Geometry {
  return entry.kind === "copy"
    ? { waves: entry.pending.waves, points: entry.pending.points }
    : entry.geometry;
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
  const blendBox = (): HTMLInputElement => $<HTMLInputElement>("wavimportBlend");

  /** Rebuild `plan` for the picked table, or clear it and say why. */
  /**
   * What to build from a staged file, in one place, so the panel and the write plan the same table.
   *
   * The blend applies only when it is on **and** the file has a shape to blend from: a file that
   * divides into nothing has no cycles to keep, and the toggle is disabled for it anyway.
   */
  function choiceFor(entry: Extract<Staged, { kind: "audio" }>): ImportChoice {
    return {
      slot: entry.slot,
      stem: entry.stem,
      geometry: entry.geometry,
      ...(entry.blend && entry.source ? { blendFrom: entry.source } : {}),
    };
  }

  function replan(): void {
    plan = undefined;
    const entry = picked === undefined ? undefined : staged.get(picked);
    if (!entry) return;
    // A restore is already a slot file. There is no fit to compute and nothing to convert.
    if (entry.kind === "copy") return;
    try {
      plan = planImport(
        { bytes: entry.decoded.bytes, samples: entry.decoded.samples },
        choiceFor(entry),
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

    /*
     * **A restore is not an import, and the panel has to stop offering to change it.** The
     * geometry boxes resample; a saved copy is already in the instrument's own form, so editing
     * it would convert a table that needs no converting. They are disabled rather than hidden so
     * the shape is still there to read.
     */
    const isCopy = entry.kind === "copy";
    const geometry = isCopy
      ? { waves: entry.pending.waves, points: entry.pending.points }
      : entry.geometry;
    wavesBox().value = String(geometry.waves);
    pointsBox().value = String(geometry.points);
    wavesBox().disabled = isCopy;
    pointsBox().disabled = isCopy;
    nameBox().disabled = isCopy;
    const blend = blendBox();
    blend.checked = entry.kind === "audio" && entry.blend;
    blend.disabled = entry.kind !== "audio" || entry.source === undefined;

    const bounds = host.bounds();
    const notes: string[] = [];

    if (entry.kind === "copy") {
      notes.push(
        `<p><strong>${escapeHtml(entry.fileName)}</strong> — a saved copy of a table, going back ` +
          `to store slot <strong>${entry.slot}</strong> exactly as it was.</p>`,
        `<p>${geometry.waves} waves x ${geometry.points} points · ` +
          `${entry.pending.table.length.toLocaleString()} bytes · stored as ` +
          `<code>${escapeHtml(entry.pending.name)}</code>.</p>`,
        `<p class="hint">Nothing is converted and nothing is re-normalised: this is the table the ` +
          `instrument wrote, so the name and the shape are not yours to change here.</p>`,
      );
      const unplayable = unplayableReason(geometry, bounds);
      notes.push(
        unplayable === undefined
          ? `<p class="ok">The pool plays this geometry.</p>`
          : `<p class="warn">${escapeHtml(unplayable)}</p>`,
      );
      $("wavimportNote").innerHTML = notes.join("");
      return;
    }

    notes.push(
      `<p><strong>${escapeHtml(entry.fileName)}</strong> — ${escapeHtml(entry.decoded.describedAs)}, ` +
        `${entry.decoded.channels === 1 ? "mono" : `${entry.decoded.channels} channels mixed to mono`}, ` +
        `${entry.decoded.samples.length.toLocaleString()} samples.</p>`,
    );
    if (plan) {
      /*
       * **The shape, and whether the file had to be changed to get there.** The panel used to
       * print the proposal's grounds and the fit's method as two sentences, which read as an
       * argument for a decision nobody had questioned. What somebody needs is the geometry and a
       * yes or no on resampling; the help explains how the shape is chosen.
       */
      const fitted = plan.fit.geometry;
      // What it was, so a resample names both ends: the shape the file divides into, or its
      // sample count when it divides into nothing.
      const from = entry.source
        ? `${entry.source.waves} x ${entry.source.points}`
        : `${entry.decoded.samples.length.toLocaleString()} samples`;
      notes.push(
        `<p>Going to store slot <strong>${entry.slot}</strong>` +
          (plan.fit.method === "exact"
            ? ` as ${fitted.waves} x ${fitted.points} — no resample required.</p>`
            : ` — ${plan.fit.method === "blended" ? "blended" : "resampled"} from ${from} to ` +
              `${fitted.waves} x ${fitted.points}.</p>`),
      );
      const gain = plan.converted.gain;
      if (gain > 1.001) {
        notes.push(`<p class="warn">Normalised by ${gain.toFixed(2)}x to full level.</p>`);
      }
      // The instrument's own bounds, not the fallback: judging the staged shape against a
      // narrower rule than the one it was proposed under would contradict the proposal.
      const unplayable = unplayableReason(geometry, bounds);
      notes.push(
        unplayable === undefined
          ? `<p class="ok">The pool plays this geometry.</p>`
          : `<p class="warn">${escapeHtml(unplayable)}</p>`,
      );
      $("wavimportName").title = plan.pending.name;
      notes.push(`<p class="hint">Stored as <code>${escapeHtml(plan.pending.name)}</code>.</p>`);
    } else {
      notes.push(
        `<p>Going to store slot <strong>${entry.slot}</strong>.</p>`,
        `<p class="warn">This geometry cannot be built. Change the numbers.</p>`,
      );
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
          `<span class="pendingmark">${entry.kind === "copy" ? "restore" : "staged"}</span> ` +
          `${escapeHtml(entry.stem)} ` +
          `<span class="hint">${geometryOf(entry).waves} x ${geometryOf(entry).points}</span>`;
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
    /** Saved copies among the dropped files, so the status can say what kind of staging this is. */
    let restored = 0;
    for (let i = 0; i < audio.length; i++) {
      const file = audio[i]!;
      const slot = placed.slots[i]!;
      host.status(`Reading ${file.name}…`);
      try {
        /*
         * **A saved copy goes back as it is; anything else is audio to convert.**
         *
         * Recognised by the bytes, not the extension: `pendingFromSlotFile` refuses anything that
         * is not an Elektron container holding a slot file, and a rename cannot fool it. A .wav
         * that somehow parsed as one would be a container, which no audio file is.
         *
         * This is the other half of the door the owner asked for on 2026-10-14. Deleting a table
         * saves exactly these bytes; before this, nothing in DNX could read one back and the copy
         * was a file only a hex editor could use.
         */
        const raw = new Uint8Array(await file.arrayBuffer());
        let pending: PendingSlot | undefined;
        try {
          pending = pendingFromSlotFile(raw, slot);
        } catch {
          pending = undefined;
        }

        if (pending) {
          staged.set(slot, {
            kind: "copy",
            slot,
            fileName: file.name,
            stem: pending.name || stemFromFileName(file.name),
            pending,
          });
          restored += 1;
          picked ??= slot;
          continue;
        }

        const decoded = await decodeTableFile(file);
        const proposal = proposeGeometry(decoded.samples.length, bounds);
        staged.set(slot, {
          kind: "audio",
          slot,
          fileName: file.name,
          stem: stemFromFileName(file.name),
          decoded,
          geometry: proposal.geometry,
          ...(proposal.exact ? { source: proposal.geometry } : {}),
          blend: false,
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
      host.status(
        restored === 0
          ? `${audio.length} staged, nothing sent.${skipped}`
          : restored === audio.length
            ? `${restored} saved table(s) ready to restore, nothing sent.${skipped}`
            : `${audio.length} staged — ${restored} restored from copies — nothing sent.${skipped}`,
        "ok",
      );
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
    const pendings: PendingSlot[] = [];
    for (const entry of entries) {
      try {
        // A restore is already a slot file; only an import has a conversion that can fail here.
        const built =
          entry.kind === "copy"
            ? pendingFor(entry, undefined)
            : planImport(
                { bytes: entry.decoded.bytes, samples: entry.decoded.samples },
                choiceFor(entry),
              ).pending;
        if (!built) throw new Error("nothing to write");
        pendings.push(built);
      } catch (error: unknown) {
        host.status(`Slot ${entry.slot} (${entry.stem}) cannot be built: ${String(error)}`, "error");
        return;
      }
    }

    const judgeBounds = host.bounds();
    const ask = (tables: readonly PendingSlot[]): Promise<boolean> => {
      const unplayable = entries.filter(
        (entry) => unplayableReason(geometryOf(entry), judgeBounds) !== undefined,
      );
      const bytes = tables.reduce((total, one) => total + one.table.length, 0);
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
            unplayable.map((entry) => `${entry.slot} (${geometryOf(entry).waves} x ${geometryOf(entry).points})`).join(", ") +
            `. They will be listed and silent.`,
        );
      }
      return askConfirm({
        title: `Write ${entries.length} ${entries.length === 1 ? "table" : "tables"} to ${WAVERIDER}?`,
        body: lines,
        confirmLabel: `Write ${entries.length} ${entries.length === 1 ? "table" : "tables"}`,
        danger: true,
      });
    };

    writing = true;
    host.lock(true);
    $<HTMLButtonElement>("wavimportWrite").disabled = true;
    stopAudition();
    host.status("Checking the slots are still empty…");
    let outcome: BatchWriteOutcome;
    try {
      outcome = await writeTablesToSlots({
        transport: apiTransport(device),
        host: { ids: pageMessageIds, gate: requireWriteEnabled, ask },
        tables: pendings,
        ...(judgeBounds === undefined ? {} : { playable: judgeBounds }),
        onWriting: (done, total, table) =>
          host.status(`Writing ${done + 1} of ${total}: ${table.name} → ${WAVERIDER}/${table.slot}…`),
      });
      const written = outcome.kind === "done" || outcome.kind === "stopped" ? outcome.written : [];
      for (const one of written) {
        staged.delete(one.slot);
        if (picked === one.slot) picked = undefined;
      }
    } finally {
      writing = false;
      host.lock(false);
      $<HTMLButtonElement>("wavimportWrite").disabled = false;
      replan();
      renderPanel();
    }
    // After the lock is released: the re-read is the mode's own, and it takes the pane itself.
    // It writes its own status line, so the outcome goes out after it and is the line that stays.
    await host.reread();
    host.status(...importOutcome(outcome, pendings.length));
  }

  function bind(): void {
    if (bound) return;
    bound = true;
    const store = $("wavestoreGrid");

    /*
     * **Where the drop would land, marked on the slots themselves.**
     *
     * The owner asked for this at the instrument on 2026-10-14: an outline round the whole store
     * said the files would be taken and nothing said where they would go. The marks come from
     * `placeFrom`, the rule the drop itself runs, so what lights up is what will happen — the
     * slots that take a file, the occupied ones it steps over, and a refusal when there is no
     * room from here. Marking rows was once passed over as "256 listeners"; it needs none, since
     * the one delegated listener can read the row under the pointer.
     */
    let markedAt: number | undefined;
    let markedCount = 0;

    const rowFor = (slot: number): Element | null =>
      store.querySelector(`tr[data-slot="${slot}"]`);

    function clearMarks(): void {
      for (const row of store.querySelectorAll(".dropland, .dropskip, .dropfull")) {
        row.classList.remove("dropland", "dropskip", "dropfull");
      }
      markedAt = undefined;
      markedCount = 0;
    }

    function mark(at: number, count: number, moving: boolean): void {
      if (markedAt === at && markedCount === count) return;
      clearMarks();
      markedAt = at;
      markedCount = count;
      // A move goes to the slot under the pointer or nowhere: `moveStaged` refuses a taken one
      // rather than looking further down, so the mark must not promise a search.
      if (moving) {
        rowFor(at)?.classList.add(claimed().has(at) ? "dropfull" : "dropland");
        return;
      }
      try {
        const placed = placeFrom(at, count, claimed());
        for (const slot of placed.slots) rowFor(slot)?.classList.add("dropland");
        for (const slot of placed.skipped) rowFor(slot)?.classList.add("dropskip");
      } catch {
        rowFor(at)?.classList.add("dropfull");
      }
    }

    store.addEventListener("dragover", (event) => {
      const kinds = event.dataTransfer?.types ?? [];
      if (!kinds.includes("Files") && !kinds.includes(MOVE_TYPE)) return;
      // Required: without it the browser navigates to the dropped file.
      event.preventDefault();
      store.classList.add("dropping");

      const row = (event.target as Element | null)?.closest?.("tr[data-slot]");
      if (!(row instanceof HTMLTableRowElement)) {
        clearMarks();
        return;
      }
      /*
       * **`items`, not `files`.** A drag in flight hides the files themselves — `files` is empty
       * until the drop — but the item list is there and its length is the count, which is all the
       * placement needs. A browser that gives neither falls back to one, so the row under the
       * pointer still lights up.
       */
      const moving = kinds.includes(MOVE_TYPE);
      const count = moving
        ? 1
        : [...(event.dataTransfer?.items ?? [])].filter((item) => item.kind === "file").length || 1;
      mark(Number(row.dataset.slot), count, moving);
    });
    store.addEventListener("dragleave", (event) => {
      if (event.target === store) {
        store.classList.remove("dropping");
        clearMarks();
      }
    });
    store.addEventListener("drop", (event) => {
      event.preventDefault();
      store.classList.remove("dropping");
      clearMarks();

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
      // A restore has no name or shape to edit: it is the instrument's own slot file, and the
      // boxes are disabled for it. Guarded here too, so a stray event cannot reach the fields.
      if (entry.kind === "copy") return;
      entry.stem = nameBox().value.trim() || entry.stem;
      entry.blend = blendBox().checked && entry.source !== undefined;
      const waves = Number(wavesBox().value);
      const points = Number(pointsBox().value);
      if (Number.isInteger(waves) && waves > 0 && Number.isInteger(points) && points > 0) {
        entry.geometry = { waves, points };
      }
      replan();
      renderPanel();
      // The row in the store says the shape too, and it went on saying the old one: the panel was
      // redrawn and the store was not.
      host.redraw();
    };
    for (const id of ["wavimportName", "wavimportWaves", "wavimportPoints", "wavimportBlend"]) {
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
      writeAll().catch((error: unknown) => host.status(`Write failed: ${String(error)}`, "error"));
    });
  }

  /**
   * Audition the **converted** table rather than the fitted floats.
   *
   * What the instrument will hold is int16, peak-normalised and quantised, and that is what the
   * preview should sound like. Playing the floats would audition something nobody will ever hear.
   */
  async function audition(entry: Staged, sweep: boolean): Promise<void> {
    // Whichever kind: a restore has its table already, an import has one once the plan builds.
    const pending = pendingFor(entry, plan);
    if (!pending) return;
    const shape = geometryOf(entry);
    const started = await auditionTable(
      {
        samples: readTableSamples(pending.table),
        waves: shape.waves,
        points: shape.points,
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
