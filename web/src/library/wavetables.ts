/**
 * The Wavetables mode of the Library page: a project's pool beside the +Drive's wavetable store.
 *
 * **One job: the wavetable half of this page.** The preset pool, the banks, the tags and the drag
 * all stay in `main.ts`; this module owns a mode of the same two panes and nothing else, because
 * the two collections answer the same two questions — *what is in use* and *where is the one I made
 * last week* — and the page already has the shape for that.
 *
 * It is a mode rather than a fifth tool because the owner chose that placement (option 1 of four,
 * 2026-10-06), and rather than a third `LibraryKind` because the preset machinery does not fit:
 * the store is not banked, there are no tags, and the pool is not in the project file at all.
 *
 * ## Two writes, and neither of them lives in this file
 *
 * The mode shipped read-only, which is what let the reading arrive before the confirmation path
 * existed. It now has two writes, and both sit in neighbours: `importstage.ts` puts tables into the
 * **store**, and `poolwrite.ts` puts a stored table into this project's **pool**. Keeping the
 * renderer itself free of them is what makes two entry points reviewable instead of a handful
 * scattered through the drawing code, and `test/librarywavetables.test.ts` holds that line.
 *
 * CLEAR SLOT, DELETE and Rename are still not built. Clearing in particular is argued against in
 * `poolview.ts`: it digs a hole the next add falls into.
 *
 * ## The pool is not in the project file
 *
 * A preset pool is read out of the open project's bytes. **A wavetable pool is a record on the
 * +Drive**, one per project slot, so this mode asks the instrument rather than the open project —
 * and it can show the pool of a project nobody has opened, including the working one. That is why
 * there is a project selector here and none in Sounds mode.
 *
 * ## Three states before anything is drawn
 *
 * `askWaveriderSupport` answers *supported*, *not supported* or *could not ask*, and the third is
 * the one that earns the gate: a held port read as "this instrument has no wavetables" would send
 * somebody away from a feature their instrument has. Each state gets its own sentence.
 */

import { claimDevice, deviceJobRefusal } from "../devicejob.js";
import { type ConnectedDevice, apiTransport, listDeviceProjects } from "../devicesource.js";
import { $, escapeHtml } from "../dom.js";
import { installHelpMarkers } from "../helpmarker.js";
import { GridDrag, renderGrid, type SlotView } from "../grid.js";
import { IDS_FOR, pageMessageIds, reserveMessageIds } from "../messageids.js";
import { type StatusWriter } from "../statusbar.js";
import {
  type PoolReading,
  readPool,
} from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import {
  type WaveriderSupport,
  askWaveriderSupport,
} from "@noiseandmatter/dnx-core/device/waveridersupport.js";
import { type PoolCell, describePool } from "@noiseandmatter/dnx-core/waverider/poolview.js";
import { type SlotFile, readSlotFile } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { waterfall } from "@noiseandmatter/dnx-core/waverider/waterfall.js";
import { readStoredFile } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { paintWaterfall } from "./waterfallview.js";
import { POOL_ENTRIES } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { STOCK_BOUNDS, type FitBounds } from "@noiseandmatter/dnx-core/waverider/fit.js";
import { wireImport } from "./importstage.js";
import { wirePoolWrite } from "./poolwrite.js";
import { wireTableDelete } from "./tabledelete.js";
import { provideWaveriderSupport } from "../wavetableerase.js";
import { type ListedProject, WORKING_PROJECT, renderProjectList } from "./projectlist.js";
import {
  auditionFrame,
  auditionTable,
  auditionVolume,
  setAuditionVolume,
  stopAudition,
} from "./tableaudio.js";
import { readTableSamples } from "@noiseandmatter/dnx-core/waverider/convert.js";

/**
 * Elements that belong to Sounds mode and have no meaning in this one.
 *
 * Their visibility is **saved on the way in and restored on the way out**, rather than unhidden.
 * Most of them are hidden by Sounds mode's own rules — a bank nobody has browsed, a project nobody
 * has opened — and unhiding them all on the way back would show an empty table under a heading
 * that describes a bank, which is a claim about an instrument nobody asked.
 */
const SOUNDS_ONLY = [
  "browse",
  /*
   * **The project group's verbs, not its picker.** Since 2026-10-14 the toolbar's project list is
   * the page's only one: this mode reads the chosen project's pool from it, and has nothing to
   * open and no file to load, so *From file…*, *From +Drive…* and *Open* go while it is on. The
   * dropdown beside Browse stays — it is how somebody leaves this mode now the tabs are gone.
   */
  "projectFileButton",
  "driveBrowse",
  "driveOpen",
  "poolGrid",
  "patternGrid",
  "findings",
  "libraryTabs",
  "libraryFind",
  "libraryTags",
  "libraryGrid",
  "soundsLegend",
] as const;

/** Elements this mode owns. */
const OURS = [
  "wavepoolBar",
  "wavepoolGrid",
  "wavepoolNote",
  "wavestoreGrid",
  "wavePreview",
  "wavimport",
] as const;

export interface WavetableHost {
  /** The instrument, when one is connected. */
  device(): ConnectedDevice | undefined;
  status: StatusWriter;
}

export interface WavetableMode {
  /** Enter or leave. Entering asks the instrument; leaving hands the panes back. */
  show(on: boolean): Promise<void>;
  /** Read the pool and the store again. */
  refresh(): Promise<void>;
  /** Another instrument answered: forget what the last one said, and ask this one. */
  reconnected(): Promise<void>;
}

export function wireWavetables(host: WavetableHost): WavetableMode {
  let support: WaveriderSupport | undefined;
  let reading: PoolReading | undefined;
  /** The pool index last clicked, so its note stays on screen. */
  let picked: number | undefined;
  /**
   * The store slots selected, in the house gesture: click, shift-click for a run, ctrl-click to
   * add or remove one.
   *
   * A set rather than one slot because the owner asked for the same gesture the manager uses to
   * move patterns between projects — select several, drag them onto a destination. A pane with
   * one selection and a button is a second vocabulary for the same idea, and
   * `one-visual-language-across-tools` is the rule it was breaking.
   */
  const pickedSlots = new Set<number>();
  /** Where a shift-click measures its run from: the last slot clicked without shift. */
  let anchorSlot: number | undefined;
  /**
   * Whether a conversation with the instrument owns the pane.
   *
   * **Found at the instrument on 2026-10-14**: clicking anything while a read was in flight
   * stopped the read. The +Drive takes one conversation at a time, and every control here can
   * start a second — a row click reads a 512 KiB table, Refresh reads the store and a pool, the
   * two write buttons write. So the controls go off and the grids stop taking clicks for the
   * duration, rather than leaving somebody to find out by losing a read.
   */
  let busy = false;
  /** Whether the panes are ours. `reconnected` re-asks only while they are. */
  let shown = false;
  /** What Sounds mode had hidden when this mode took the panes. See `SOUNDS_ONLY`. */
  const hiddenBefore = new Map<string, boolean>();
  /**
   * Whether the toolbar's project list was hidden when this mode took it.
   *
   * Presets and Kits show it only once *From +Drive…* has listed the projects; this mode fills it
   * and shows it on entry. Leaving puts it back as it was, so Presets does not inherit a list
   * nobody asked it for.
   */
  let pickerHiddenBefore = true;
  /**
   * And what the two panes were called.
   *
   * Restored for the same reason the visibility is: Sounds mode writes its headings when a project
   * is opened or a bank is browsed, so with neither done, coming back out left the page headed
   * *Wavetable pool* over the preset pool. Found by opening the page and pressing both tabs.
   */
  const titlesBefore = new Map<string, string>();

  /** The two grids a drag can cross. Named, because `GridDrag` judges a drop by where it began. */
  const STORE_GRID = "wavestore";
  const POOL_GRID = "wavepool";

  /**
   * Dragging tables out of the store and onto a pool slot.
   *
   * **The same controller the manager moves patterns with**, which is the point: the owner asked
   * for this gesture by comparing it to moving patterns between projects, and a second drag
   * implementation would be a second set of rules about what a drop means.
   *
   * Store to pool only. A drop anywhere else is refused by returning no hint, which leaves the
   * browser's own "no" cursor — clearer than a message, and nothing has to draw it.
   */
  const drag = new GridDrag({
    onDragStart: (grid, index) => {
      if (grid !== STORE_GRID) return [index];
      // Dragging one of several selected drags the whole selection; dragging anything else takes
      // the selection with it, so the two can never disagree about what is in flight.
      if (!pickedSlots.has(index)) {
        pickedSlots.clear();
        pickedSlots.add(index);
        anchorSlot = index;
        renderStore();
        poolWriting.redraw();
      }
      return chosenSlots();
    },
    hintFor: (from, grid, index) => {
      if (from.grid !== STORE_GRID || grid !== POOL_GRID) return undefined;
      // What was dragged, unfiltered. Which of it can go into a pool is one decision and it is
      // not taken here — `describeDrop` and the write both ask `planAdd`, so the hint and the
      // result cannot describe different writes.
      const described = poolWriting.describeDrop(from.indices, index);
      if (!described) return undefined;
      // `copy`, not `move`: the table stays in the store and every other project keeps it. Saying
      // "move" would be the page claiming something the instrument does not do.
      return { action: "copy", label: described.label, status: described.status };
    },
    onDrop: (from, grid, index) => {
      if (from.grid !== STORE_GRID || grid !== POOL_GRID) return;
      // `addAt` drops the empty slots and says so if nothing is left.
      void poolWriting.addAt(from.indices, index);
    },
    onStatus: (message, kind) => {
      if (message !== "") host.status(message, kind ?? "info");
    },
  });

  /**
   * Staging imports onto the store, which is the only thing in this mode that writes.
   *
   * Handed accessors rather than the reading itself, so it cannot hold a stale copy of a listing
   * this module re-reads on every Refresh.
   */
  const staging = wireImport({
    device: () => host.device(),
    occupied: () =>
      new Set((reading?.store ?? []).filter((slot) => slot.occupied).map((slot) => slot.slot)),
    bounds: (): FitBounds => storeBounds(),
    status: host.status,
    lock,
    redraw: () => {
      renderStore();
    },
    // The mode's own refresh, which reads the pool and the store from the instrument. A write
    // changes what is out there, so redrawing the reading in hand would show the slots that were
    // just written as still free.
    reread: refresh,
  });

  /**
   * Placing a stored table into this project's pool, which is the mode's second write.
   *
   * Handed the same kind of accessors as the staging for the same reason, and the two selections
   * as well: the control's label and whether it can be pressed are decided by what the panes have
   * selected, so it has to read that from here rather than keep its own copy.
   */
  const poolWriting = wirePoolWrite({
    device: () => host.device(),
    reading: () => reading,
    projectSlot: () => Number(projects().value),
    pickedSlots: () => chosenSlots(),
    pickedIndex: () => picked,
    status: host.status,
    lock,
    reread: refresh,
  });

  /**
   * Deleting a stored table, which is the mode's third write and the only destructive one.
   *
   * Takes the **previewed** slot rather than the selected row: the control sits in the preview's
   * own header, under the name and the geometry of the table it would remove, so the thing being
   * deleted is the thing on screen. A row selected and then not read — which happens while a read
   * is in flight — is not a table anybody has looked at.
   */
  const tableDeleting = wireTableDelete({
    device: () => host.device(),
    reading: () => reading,
    projectSlot: () => Number(projects().value),
    previewSlot: () => previewSlot,
    status: host.status,
    lock,
    reread: refresh,
  });

  /**
   * Lend the application what this mode already knows about the instrument.
   *
   * **The erase lives in the settings sheet and belongs to the whole application**, since the
   * owner's rule of 2026-10-14: a command about the instrument does not depend on which tool you
   * are sitting in. It asks the gate for itself anywhere else; here the gate has already been
   * asked to draw these panes, so the answer is lent and the press does not ask twice.
   *
   * Only while a device is still connected: a gate answer outliving the instrument it describes
   * is a claim about whatever is plugged in next. `reconnected` drops it as well, so the next
   * instrument is asked rather than inheriting this one's answer.
   */
  provideWaveriderSupport(() => (host.device() ? support : undefined));

  /**
   * What this instrument will play, as the instrument reported it.
   *
   * `support.features.playable` is absent on a build that does not report the capability, and the
   * fallback is then the one `unplayableReason` applies with no bounds: 16 x 512 and nothing else.
   * **Taking the same fallback is what keeps the two from disagreeing** — proposing a shape this
   * pane would then call unplayable is the failure this function exists to avoid, and it is the
   * failure that was live while the capability reader was unmerged.
   */
  function storeBounds(): FitBounds {
    return support?.state === "supported" ? support.features.playable ?? STOCK_BOUNDS : STOCK_BOUNDS;
  }
  /**
   * And where the two panes' `?` markers pointed.
   *
   * Same bug as the titles, one layer down. The marker on the left heading opened *Why both are on
   * one page*, about the preset pool, under a heading reading **Wavetable pool**.
   */
  const helpBefore = new Map<HTMLElement, string>();

  /** The toolbar's project list, which this mode shares with Presets and Kits. */
  const projects = (): HTMLSelectElement => $<HTMLSelectElement>("driveProjects");

  /** The selection in slot order, which is the order a drop lays them into the pool. */
  function chosenSlots(): number[] {
    return [...pickedSlots].sort((a, b) => a - b);
  }

  /**
   * Apply a click to the selection, the same way every other grid on this page does.
   *
   * Plain click replaces it, ctrl or cmd toggles one, shift takes the run from the anchor. The
   * anchor only moves on a plain or toggling click, so shift-clicking twice re-measures from the
   * same place rather than growing the run each time.
   */
  function selectStore(slot: number, event: MouseEvent): void {
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && anchorSlot !== undefined) {
      const lo = Math.min(anchorSlot, slot);
      const hi = Math.max(anchorSlot, slot);
      if (!additive) pickedSlots.clear();
      for (let at = lo; at <= hi; at++) pickedSlots.add(at);
      return;
    }
    if (additive) {
      if (pickedSlots.has(slot)) pickedSlots.delete(slot);
      else pickedSlots.add(slot);
      anchorSlot = slot;
      return;
    }
    pickedSlots.clear();
    pickedSlots.add(slot);
    anchorSlot = slot;
  }

  function note(html: string): void {
    const box = $("wavepoolNote");
    box.hidden = false;
    box.innerHTML = html;
    // The note's own `?` is a child of the box, so writing `innerHTML` deletes it. Put it back
    // here: this is the only place the box's contents are set.
    installHelpMarkers(box.parentElement ?? box);
  }

  function hideOurs(): void {
    for (const id of OURS) $(id).hidden = true;
  }

  /**
   * The two controls that talk to the instrument.
   *
   * Off until the gate has said *supported*, because a Refresh that answers nothing is a control
   * telling somebody the page is broken when the page is waiting for an instrument.
   */
  /**
   * Every control in this mode that can reach the instrument, switched off together.
   *
   * The mode buttons are in it because leaving mid-read abandons a conversation the pane would
   * no longer be watching. The grids are not controls, so they take a class instead: the clicks
   * are on their rows and cells, and refusing the pointer is one rule rather than a guard in
   * each handler.
   */
  const WHILE_BUSY = [
    "driveProjects",
    "wavepoolRefresh",
    "wavepoolAdd",
    "wavepoolRemove",
    "waveTableDelete",
    "wavimportWrite",
    "wavimportClear",
    "wavimportRemove",
    "kind",
  ] as const;

  /**
   * Lock the panes while one job talks to the instrument, and hold the instrument for the page.
   * See `devicejob.ts`: a Settings backup or erase running underneath is refused here, and the
   * panes are refused there.
   */
  let releaseDevice: (() => void) | undefined;
  function lock(on: boolean): boolean {
    if (on) {
      const release = claimDevice("The library");
      if (!release) {
        host.status(deviceJobRefusal(), "warn");
        return false;
      }
      releaseDevice = release;
    } else {
      releaseDevice?.();
      releaseDevice = undefined;
    }
    busy = on;
    for (const id of WHILE_BUSY) {
      const control = document.getElementById(id);
      if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) {
        control.disabled = on;
      }
    }
    for (const id of ["wavepoolGrid", "wavestoreGrid"]) {
      const pane = document.getElementById(id);
      pane?.classList.toggle("locked", on);
      pane?.setAttribute("aria-busy", String(on));
    }
    // On the way out, back to whatever each control's own state allows — which is its question,
    // not this one. `controls` does the same thing for the same reason.
    if (!on) {
      poolWriting.redraw();
      tableDeleting.redraw();
    }
    return true;
  }

  function controls(on: boolean): void {
    $<HTMLSelectElement>("driveProjects").disabled = !on;
    $<HTMLButtonElement>("wavepoolRefresh").disabled = !on;
    // Off with them, and back on only where the panes' own state allows it, which is the write's
    // own question rather than this one.
    if (on) {
      poolWriting.redraw();
      tableDeleting.redraw();
    } else {
      for (const id of ["wavepoolAdd", "wavepoolRemove", "waveTableDelete"]) {
        $<HTMLButtonElement>(id).disabled = true;
      }
    }
  }

  /**
   * The gate's reason, started as a sentence of its own.
   *
   * `why` is written to be read after a colon, so it begins in lower case — and each of the three
   * notes below puts it after a full stop, which read "no wavetable store. the root listing
   * offers…". Capitalised here rather than in the core, because where it sits is the caller's
   * decision and the next caller may want it mid-sentence.
   */
  function asSentence(why: string): string {
    return why.charAt(0).toUpperCase() + why.slice(1);
  }

  /** The sentence for a state that is not *supported*, and the reason it is not a failure. */
  function explain(answer: WaveriderSupport): void {
    hideOurs();
    controls(false);
    $("wavepoolBar").hidden = false;
    const titles = { left: "Wavetable pool", right: "+Drive wavetables" };
    heading(titles.left, "", titles.right, "");

    if (answer.state === "unsupported") {
      note(
        `<p><b>This instrument has no wavetable store.</b> ${escapeHtml(asSentence(answer.why))}.</p>` +
          `<p>Wavetables need a Waverider build.</p>`,
      );
      host.status("No wavetable store on this instrument.", "info");
      return;
    }

    if (answer.state === "supported") {
      /*
       * The listing offered the root and the record says the store capability is off. A real
       * answer, and not the same as the two above: the instrument was asked and said no.
       */
      note(
        `<p><b>This build reports no wavetable store.</b> ${escapeHtml(asSentence(answer.why))}.</p>`,
      );
      host.status("This build reports no wavetable store.", "info");
      return;
    }

    /*
     * **Could not ask, said as itself.** This is the state the gate exists for: a timeout, a busy
     * port or two answers that disagree. Calling it *not supported* would be a wrong answer wearing
     * the clothes of a considered one, and somebody would stop looking.
     */
    note(
      `<p><b>DNX could not find out.</b> ${escapeHtml(asSentence(answer.why))}.</p>` +
        `<p>Close Elektron Transfer and Overbridge, then press Refresh.</p>`,
    );
    host.status("Could not ask the instrument about its wavetable store.", "warn");
  }

  const TITLES = ["leftTitle", "poolSub", "libraryTitle", "librarySub"] as const;

  /** The `h2` a pane's title span sits in, which is what carries the `?`. */
  function headingOf(titleId: string): HTMLElement {
    const h2 = $(titleId).closest("h2");
    if (!(h2 instanceof HTMLElement)) {
      throw new Error(`#${titleId} is no longer inside a heading, so its ? cannot be retargeted`);
    }
    return h2;
  }

  /**
   * Point one block's `?` somewhere else, remembering where it pointed.
   *
   * The marker is rebuilt. `installHelpMarkers` closes over the target when it makes the button, so
   * changing the attribute on its own leaves a `?` that still opens the old section.
   */
  function helpFor(host: HTMLElement, target: string): void {
    if (!helpBefore.has(host)) helpBefore.set(host, host.dataset["help"] ?? "");
    host.dataset["help"] = target;
    host.querySelector(":scope > .helpq")?.remove();
    installHelpMarkers(host.parentElement ?? host);
  }

  /** And put each of them back, on the way out. */
  function restoreHelp(): void {
    for (const [host, was] of helpBefore) {
      host.dataset["help"] = was;
      host.querySelector(":scope > .helpq")?.remove();
      installHelpMarkers(host.parentElement ?? host);
    }
    helpBefore.clear();
  }

  function heading(left: string, leftSub: string, right: string, rightSub: string): void {
    $("leftTitle").textContent = left;
    $("poolSub").textContent = leftSub;
    $("libraryTitle").textContent = right;
    $("librarySub").textContent = rightSub;
  }

  /** One pool cell, as the shared grid draws it. */
  function cellView(cell: PoolCell): SlotView {
    return {
      index: cell.index,
      // The shown slot, 1..128, which is also what the instrument TBL cell reads: T:005 for
      // slot 5. The built-ins sit outside this numbering and read PRIM and HARM. The value a sound
      // *stores* is this number plus one, and nobody sees it. See 8w on the three numbers.
      id: String(cell.shown),
      name:
        cell.state === "table"
          ? cell.name || "—"
          : cell.state === "missing"
            ? "MISSING"
            : "—",
      detail:
        cell.state === "table"
          ? `store ${cell.storeSlot}`
          : cell.state === "missing"
            ? "not on +Drive"
            : "free",
      occupied: cell.state === "table",
      /*
       * `supported` is the grid's *"there is something here I cannot read"* paint, which is exactly
       * what a missing entry is: an entry that names a table nobody can play. It gets the same
       * treatment a pattern of an unreadable version gets, for the same reason — it must not look
       * like an empty slot, because one of them is somebody's work gone wrong.
       */
      supported: cell.state !== "missing",
      ...(cell.state === "missing" ? { classes: ["missing"] } : {}),
    };
  }

  function renderPool(): void {
    if (!reading) return;
    const summary = reading.summary;

    $("wavepoolGrid").hidden = false;
    renderGrid($("wavepoolGrid"), summary.cells.map(cellView), {
      selected: picked === undefined ? [] : [picked],
      onClick: (index) => {
        picked = index;
        renderPool();
        renderStore();
        // The label says which slot it will write into, so it changes with the selection.
        poolWriting.redraw();
      },
      drag: { controller: drag, grid: POOL_GRID },
    });

    /*
     * **The counts, and the one warning.** Everything else the pane used to print here — what the
     * selected slot holds, its TBL number, which store slots are named twice — is already on the
     * grid or in the help, and the owner read the paragraphs as noise in front of it.
     */
    note(
      `<p>${escapeHtml(describePool(summary))}</p>` +
        /*
         * **A saved project's pool is not what is playing.** The firmware refills what plays only
         * from the working record; a write to any other changes the +Drive and nothing you hear,
         * until that project is next loaded. Said where somebody looks before they edit, because
         * the mix-up that prompted option B looked exactly like a write that did nothing.
         */
        (summary.projectSlot === WORKING_PROJECT
          ? ""
          : `<p class="hint">Saved in this project. Changes play after you next load it on the ` +
            `instrument.</p>`) +
        (summary.missing === 0
          ? ""
          : `<p class="warn"><b>${summary.missing} slot(s) name a table that is missing ` +
            `from the +Drive.</b></p>`),
    );
  }

  function renderStore(): void {
    if (!reading) return;
    const where = $("wavestoreGrid");
    where.hidden = false;
    where.innerHTML = "";

    const table = document.createElement("table");
    table.className = "libtable";
    const head = document.createElement("thead");
    // No geometry and no size: `/waverider` reports every slot's size as the fixed 512 KiB extent,
    // so a size column would be a number that looks like information and is not. Geometry costs a
    // file read per slot.
    head.innerHTML = "<tr><th>#</th><th>Name</th><th>In this pool</th></tr>";
    table.append(head);

    const body = document.createElement("tbody");
    for (const slot of reading.store) {
      const inPool = reading.summary.byStoreSlot.get(slot.slot) ?? [];
      const tr = document.createElement("tr");
      tr.className = slot.occupied ? "occupied" : "free";
      // How `importstage.decorate` finds the row for a staged slot after a re-render.
      tr.dataset.slot = String(slot.slot);
      if (pickedSlots.has(slot.slot)) {
        tr.classList.add("selected");
        tr.setAttribute("aria-selected", "true");
      }
      // The slot a selected pool cell names, marked so clicking a cell answers "which table is
      // that" without reading the number off two panes.
      const cell = picked === undefined ? undefined : reading.summary.cells[picked];
      if (cell?.storeSlot === slot.slot) tr.classList.add("landing");

      tr.innerHTML =
        `<td class="n">${slot.slot}</td>` +
        `<td class="name">${escapeHtml(slot.occupied ? slot.name || "—" : "—")}</td>` +
        `<td class="use">${
          inPool.length === 0
            ? '<span class="hint">—</span>'
            : inPool.map((index) => index + 1).join(", ")
        }</td>`;
      tr.addEventListener("click", (event) => {
        selectStore(slot.slot, event);
        renderStore();
        poolWriting.redraw();
        // The preview follows the clicked row whatever the selection did, because the preview
        // answers "what is this one" and a run of ten is still ten tables somebody clicked last.
        void showPreview(slot.slot);
      });
      /*
       * **Draggable, as the same gesture everywhere else on this page.** A store row is a source
       * only: `hintFor` refuses a drop on one, so dragging a table onto the store does nothing
       * rather than looking like it might move it.
       *
       * **Except a staged row, which already has a drag of its own.** `importstage.decorate`
       * makes it draggable to move the staging to another slot, and binding this on top gave one
       * element two `dragstart` handlers and two meanings. It failed safe only because the pool
       * drop filters to slots the instrument says are occupied, and a staged slot is not one —
       * safety resting on a filter in another module. The same guard `showPreview` uses.
       */
      if (!staging.staged().has(slot.slot)) drag.bind(tr, STORE_GRID, slot.slot);
      body.append(tr);
    }
    // After the rows exist, so a staged table is marked on the row it will land on rather than
    // listed beside the store.
    staging.decorate(body);
    table.append(body);
    where.append(table);

    const used = reading.store.filter((slot) => slot.occupied).length;
    heading(
      "Wavetable pool",
      // The count only. Which kind of pool it is sits in the line under the bar, and the heading
      // used to carry it too — one fact in two places, both of them shortened on 2026-10-14.
      `— ${reading.summary.tables} of ${POOL_ENTRIES} used`,
      "+Drive wavetables",
      /*
       * **Both drops, named where somebody is already looking.** Audio in from the computer, and
       * tables out onto a pool slot — neither has a control that announces itself, and the panel
       * that explains the first does not exist until something is staged.
       */
      `— ${used} of ${reading.store.length} slots used, shared by every project · drag audio ` +
        `files onto a free slot to import · drag tables onto a pool slot to add them`,
    );
  }


  /**
   * Tables already read, by store slot.
   *
   * **Cached because the read is the expensive part and the slot cannot change under us** — a
   * `/waverider` slot is only written by this application, behind the write gate, and Refresh
   * clears this along with everything else. Clicking back and forth between two tables after that
   * costs nothing, which is exactly the comparison the preview is for.
   */
  const tables = new Map<number, SlotFile>();
  /** Which frame each slot's slider is on, so going back to a table returns to where you were. */
  const frameOf = new Map<number, number>();
  /** The slot currently drawn, so the slider knows what it is moving. */
  let previewSlot: number | undefined;
  /** One read at a time, so a fast double click cannot interleave two slot reads. */
  let previewBusy = false;
  /**
   * The animation frame driving the marker while a note sounds, so it can be cancelled.
   *
   * The drawing follows the **audio clock**, not a timer started beside it: a sweep rendered at
   * 3 seconds and a `setInterval` counting to 3 seconds drift apart within one note, and a marker
   * that arrives at the last frame before the sound does reads as a bug in the table.
   */
  let following = 0;
  /** The frame the slider was on before an audition moved it, so it can be put back. */
  let frameBeforeAudition: number | undefined;

  const stage = (): HTMLElement => $("wavePreviewStage");
  const slider = (): HTMLInputElement => $<HTMLInputElement>("wavePreviewPos");

  /** A sentence in the stage instead of a drawing. */
  function previewMessage(text: string): void {
    const box = document.createElement("p");
    box.className = "wfempty";
    box.textContent = text;
    stage().replaceChildren(box);
  }

  /**
   * Draw whatever `previewSlot` names, or say why there is nothing to draw.
   *
   * Separated from the read so moving the slider redraws without asking the instrument again.
   */
  function drawPreview(): void {
    const panel = $("wavePreview");
    const slot = previewSlot;
    if (slot === undefined) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    const file = tables.get(slot);
    const where = $("wavePreviewWhere");
    const geom = $("wavePreviewGeom");
    const label = $("wavePreviewPosLabel");

    if (!file) {
      where.textContent = `store ${slot}`;
      geom.textContent = "";
      label.textContent = "";
      slider().disabled = true;
      return;
    }

    const { entry, table } = file;
    const inPool = reading?.summary.byStoreSlot.get(slot) ?? [];
    where.textContent =
      `store ${slot} · ${entry.name || "unnamed"}` +
      (inPool.length === 0
        ? " · not in this pool"
        : ` · pool slot ${inPool.map((index) => index + 1).join(", ")}`);
    geom.textContent =
      `${entry.waves} waves x ${entry.points} points · ` +
      `${entry.byteLength.toLocaleString()} bytes · gain ${entry.gain.toFixed(2)}`;

    const frame = Math.max(0, Math.min(entry.waves - 1, frameOf.get(slot) ?? 0));
    frameOf.set(slot, frame);

    const control = slider();
    control.disabled = entry.waves < 2;
    control.min = "1";
    control.max = String(Math.max(2, entry.waves));
    control.value = String(frame + 1);
    label.textContent =
      `frame ${frame + 1} / ${entry.waves}` +
      (entry.waves < 2 ? "" : ` · ${(frame / (entry.waves - 1)).toFixed(3)}`);

    try {
      paintWaterfall(stage(), waterfall(table, entry, frame), {
        current: frame,
        waves: entry.waves,
      });
      // The delete acts on whatever is drawn, so it is decided wherever the drawing is.
      tableDeleting.redraw();
    } catch (error) {
      // A table whose geometry does not measure its bytes is a real thing on a +Drive, and the
      // view refuses it by name rather than drawing a wave that is not there.
      previewMessage(`This table cannot be drawn. ${String(error)}`);
    }
  }

  /** Read one store slot's table and draw it. */
  async function showPreview(slot: number): Promise<void> {
    /*
     * **A staged row is not a table on the instrument, and the import panel owns it.**
     *
     * Both this and the staging's own row handler are bound to the same `<tr>`, so which of them
     * runs is a question about event phases rather than about intent. Asking here instead makes it
     * intent: without this, clicking a staged row would ask the instrument for a slot that is
     * empty and report the failure as though the table were missing.
     */
    if (staging.staged().has(slot)) return;

    const device = host.device();
    previewSlot = slot;

    const row = reading?.store.find((entry) => entry.slot === slot);
    if (row && !row.occupied) {
      $("wavePreview").hidden = false;
      $("wavePreviewWhere").textContent = `store ${slot}`;
      $("wavePreviewGeom").textContent = "";
      $("wavePreviewPosLabel").textContent = "";
      slider().disabled = true;
      previewMessage("That slot is empty, so there is no table to draw.");
      return;
    }
    if (tables.has(slot)) {
      drawPreview();
      return;
    }
    if (!device || previewBusy) return;
    if (!lock(true)) return;

    $("wavePreview").hidden = false;
    slider().disabled = true;
    previewMessage(`Reading store slot ${slot}…`);
    previewBusy = true;
    try {
      const file = await readStoredFile(`/waverider/${slot}`, {
        transport: apiTransport(device),
        msgId: reserveMessageIds(IDS_FOR.oneObject),
      });
      tables.set(slot, readSlotFile(file.bytes));
      // Only draw if the chosen slot is still this one: a click during the read wins.
      if (previewSlot === slot) drawPreview();
    } catch (error) {
      if (previewSlot === slot) {
        previewMessage(`Store slot ${slot} could not be read. ${String(error)}`);
      }
      host.status(`Could not read store slot ${slot}: ${String(error)}`, "warn");
    } finally {
      previewBusy = false;
      lock(false);
    }
  }

  async function fillProjects(device: ConnectedDevice): Promise<void> {
    const select = projects();
    let listed: ListedProject[] = [];
    try {
      listed = await listDeviceProjects(device);
    } catch (error) {
      // A pool can still be read without the names, so this is a worse list rather than a failure.
      host.status(`Could not list the projects, so only the working project is offered: ${String(error)}`, "warn");
    }
    /*
     * **Always the working project to start with** — the owner's choice, 2026-10-14 (option B).
     * This started on the project open in Presets, so with project 24 open an edit went to 24's
     * saved record while the instrument went on playing the working one, and nothing changed.
     * The working project is the one being heard, so it is the one a first edit should reach.
     */
    renderProjectList(select, listed, WORKING_PROJECT);
  }

  async function refresh(): Promise<void> {
    const device = host.device();
    if (!device) return;
    if (busy) return;

    const projectSlot = Number(projects().value);
    if (!lock(true)) return;
    try {
      host.status(`Reading the wavetable store and the pool of project slot ${projectSlot}…`);
      picked = undefined;
      previewSlot = undefined;
      tables.clear();
      frameOf.clear();
      $("wavePreview").hidden = true;
      reading = await readPool({
        transport: apiTransport(device),
        ids: pageMessageIds,
        projectSlot,
      });
      renderStore();
      renderPool();
      poolWriting.redraw();
      tableDeleting.redraw();
      host.status(
        `${describePool(reading.summary)}${
          reading.unlisted === 0
            ? ""
            : ` ${reading.unlisted} store slot(s) were not in the listing.`
        }`,
        reading.summary.missing === 0 ? "ok" : "warn",
      );
    } catch (error) {
      hideOurs();
      note(
        `<p><b>The pool could not be read.</b> ${escapeHtml(String(error))}</p>` +
          `<p>The store was reachable a moment ago, so this is about this project's record rather ` +
          `than about the instrument.</p>`,
      );
      host.status(`Could not read the pool: ${String(error)}`, "error");
    } finally {
      lock(false);
    }
  }

  /**
   * Ask the connected instrument what it can do, and draw whatever it says.
   *
   * **Separate from `show` because the panes are handed over once and asked more than once.**
   * The handover saves what Sounds mode had hidden, which may only happen on the way in: running
   * it a second time would record this mode's own state as Sounds mode's, and leaving would then
   * hand back a hidden page. A reconnect needs the asking without the saving.
   */
  async function enter(): Promise<void> {
    staging.show(true);
    $("wavepoolBar").hidden = false;
    const device = host.device();
    if (!device) {
      hideOurs();
      controls(false);
      $("wavepoolBar").hidden = false;
      heading("Wavetable pool", "— connect an instrument", "+Drive wavetables", "");
      note(
        `<p><b>Connect an instrument.</b> The pool is read from the +Drive, not from the ` +
          `project file.</p>`,
      );
      return;
    }

    host.status("Asking the instrument about its wavetable store…");
    support = await askWaveriderSupport({ transport: apiTransport(device), ids: pageMessageIds });
    if (support.state !== "supported" || !support.features.tab) {
      explain(support);
      return;
    }

    if (!support.features.pool) {
      // The store without the pool routes: a build that can hold tables and has no per-project
      // lists. The right pane still works, so it is shown rather than the whole mode refused.
      hideOurs();
      controls(false);
      $("wavepoolBar").hidden = false;
      note(
        `<p><b>This build has the wavetable store and no pool lists.</b> Which tables a project ` +
          `plays cannot be read from it.</p>`,
      );
      host.status("The store is there; this build has no /wavepool route.", "warn");
      return;
    }

    controls(true);
    await fillProjects(device);
    await refresh();
  }

  async function show(on: boolean): Promise<void> {
    if (on) {
      for (const id of SOUNDS_ONLY) {
        hiddenBefore.set(id, $(id).hidden);
        $(id).hidden = true;
      }
      for (const id of TITLES) titlesBefore.set(id, $(id).textContent ?? "");
      pickerHiddenBefore = projects().hidden;
      projects().hidden = false;
      helpFor(headingOf("leftTitle"), "library/wavetable-modes");
      helpFor(headingOf("libraryTitle"), "library/wavetable-limits");
      shown = true;
    } else {
      for (const id of SOUNDS_ONLY) $(id).hidden = hiddenBefore.get(id) ?? false;
      for (const id of TITLES) $(id).textContent = titlesBefore.get(id) ?? "";
      projects().hidden = pickerHiddenBefore;
      restoreHelp();
      staging.show(false);
      hideOurs();
      shown = false;
      return;
    }

    await enter();
  }

  /**
   * Another instrument answered, so nothing the last one said is evidence about this one.
   *
   * **What the gate said is about one instrument.** `support` decides whether the settings sheet
   * offers the erase and what geometry the store will take, `reading` is one instrument's pool and
   * store drawn on the screen, and `tables` caches slots by number — a slot number means something
   * different on the next machine. Connecting a stock Digitone II while this mode was open left a
   * Waverider's pool on screen and the erase on offer, found on 2026-10-14. It is the hazard the
   * preset bank cache is cleared for in `main.ts`, one pane over.
   *
   * Staged files go too: they were placed on free slots of the instrument that has just gone.
   */
  async function reconnected(): Promise<void> {
    support = undefined;
    reading = undefined;
    picked = undefined;
    previewSlot = undefined;
    pickedSlots.clear();
    anchorSlot = undefined;
    tables.clear();
    frameOf.clear();
    staging.show(false);
    $("wavePreview").hidden = true;
    if (!shown) return;
    await enter();
  }

  // The list is shared with Presets and Kits, where choosing waits for Open. Here choosing is
  // the read, so only while this mode has the panes.
  projects().addEventListener("change", () => {
    if (shown) void refresh();
  });
  $("wavepoolRefresh").addEventListener("click", () => {
    void refresh();
  });
  // `input` rather than `change`, so dragging the slider sweeps the stack instead of jumping once
  // on release. Redrawing is local arithmetic on a table already in hand; nothing is asked of the
  // instrument here.
  slider().addEventListener("input", () => {
    if (previewSlot === undefined) return;
    // **Before stopping the note, not after.** The follow loop puts the slider back where the
    // audition found it when the sound ends; a drag is the person taking it over, so the saved
    // position is dropped and the loop has nothing to restore. Without this, dragging mid-sweep
    // moved the marker and then snapped it back a frame later.
    frameBeforeAudition = undefined;
    frameOf.set(previewSlot, Number(slider().value) - 1);
    drawPreview();
    // A slider drag while a note is sounding would otherwise leave the sound on the frame it
    // started from, which reads as the picture and the sound disagreeing.
    stopAudition();
  });

  /**
   * Hear the table that is drawn.
   *
   * **This mode stayed read-only when the preview arrived, and Play was left out because the two
   * things it could mean were a new capability and a device write.** The first is now built, so
   * this synthesises the table in the browser and sends nothing: the instrument does not move, the
   * sequencer does not start, and no pool position changes. Driving the instrument's own position
   * is still a write and still not here.
   *
   * It plays the stored int16 at the geometry the entry declares, which is what the player reads,
   * so what you hear is the table rather than an idealised version of it.
   */
  /**
   * Move the drawing with the sound, until the sound stops.
   *
   * A sweep travels, so the marker and the slider travel with it and the stack lights up frame by
   * frame. A held note does not travel — the frame it is on is the frame it stays on — so what
   * this does there is mark the stage as sounding and leave the marker where it is. Animating a
   * number that is not moving would be a lie about what is coming out of the speakers.
   */
  function followAudition(): void {
    const slot = previewSlot;
    const file = slot === undefined ? undefined : tables.get(slot);
    if (!file) return;

    $("wavePreviewStage").classList.add("sounding");

    const step = (): void => {
      const at = auditionFrame();
      if (at === undefined) {
        // Ended or stopped. Put the slider back where the person left it and redraw once.
        following = 0;
        $("wavePreviewStage").classList.remove("sounding");
        if (frameBeforeAudition !== undefined && slot !== undefined) {
          frameOf.set(slot, frameBeforeAudition);
          frameBeforeAudition = undefined;
          if (previewSlot === slot) drawPreview();
        }
        return;
      }

      const whole = Math.round(at);
      if (slot !== undefined && frameOf.get(slot) !== whole) {
        frameOf.set(slot, whole);
        if (previewSlot === slot) drawPreview();
      }
      following = requestAnimationFrame(step);
    };

    if (following !== 0) cancelAnimationFrame(following);
    following = requestAnimationFrame(step);
  }

  async function auditionDrawn(sweep: boolean): Promise<void> {
    const slot = previewSlot;
    const file = slot === undefined ? undefined : tables.get(slot);
    if (!file) {
      host.status("Click a table in the store first.", "warn");
      return;
    }
    const { entry, table } = file;
    const started = await auditionTable(
      {
        samples: readTableSamples(table),
        waves: entry.waves,
        points: entry.points,
        fullScale: 32_767,
      },
      { sweep, frame: frameOf.get(slot!) ?? 0 },
    );
    if (!started) {
      host.status("The browser would not start audio. Click the page and try again.", "warn");
      return;
    }
    // Remembered before the marker starts moving, so Stop or the end of the note puts the slider
    // back rather than leaving it wherever the sweep happened to finish.
    frameBeforeAudition = frameOf.get(slot!) ?? 0;
    followAudition();
  }

  $("wavePreviewPlay").addEventListener("click", () => {
    void auditionDrawn(false);
  });
  $("wavePreviewSweep").addEventListener("click", () => {
    void auditionDrawn(true);
  });
  $("wavePreviewStop").addEventListener("click", () => {
    stopAudition();
  });

  /*
   * The level, which belongs to the page rather than to a table: it stays where it was put for the
   * next audition and for the staged import's own Play, both of which go through the same gain.
   */
  const volume = $<HTMLInputElement>("wavePreviewVolume");
  volume.value = String(Math.round(auditionVolume() * 100));
  volume.addEventListener("input", () => {
    setAuditionVolume(Number(volume.value) / 100);
  });

  return { show, refresh, reconnected };
}
