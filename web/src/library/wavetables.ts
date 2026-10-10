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
 * ## Read-only, deliberately, and not for long
 *
 * Nothing here writes. ADD TO POOL, CLEAR SLOT, DELETE and Rename each need the confirmation and
 * backup path every write in DNX goes through, and the gate's own answer about whether this build
 * serves them — which `features` already carries. Shipping the reading first means the thing that
 * can tell somebody *your sound plays Prim. because that table was deleted* arrives without
 * waiting for the half that can break something.
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

import { type ConnectedDevice, apiTransport, listDeviceProjects } from "../devicesource.js";
import { $, escapeHtml } from "../dom.js";
import { installHelpMarkers } from "../helpmarker.js";
import { renderGrid, type SlotView } from "../grid.js";
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

/**
 * Elements that belong to Sounds mode and have no meaning in this one.
 *
 * Their visibility is **saved on the way in and restored on the way out**, rather than unhidden.
 * Most of them are hidden by Sounds mode's own rules — a bank nobody has browsed, a project nobody
 * has opened — and unhiding them all on the way back would show an empty table under a heading
 * that describes a bank, which is a claim about an instrument nobody asked.
 */
const SOUNDS_ONLY = [
  "kind",
  "browse",
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
] as const;

export interface WavetableHost {
  /** The instrument, when one is connected. */
  device(): ConnectedDevice | undefined;
  /** The open project's +Drive slot, when it came from the +Drive rather than from a file. */
  openSlot(): number | undefined;
  status: StatusWriter;
}

export interface WavetableMode {
  /** Enter or leave. Entering asks the instrument; leaving hands the panes back. */
  show(on: boolean): Promise<void>;
  /** Read the pool and the store again. */
  refresh(): Promise<void>;
}

export function wireWavetables(host: WavetableHost): WavetableMode {
  let support: WaveriderSupport | undefined;
  let reading: PoolReading | undefined;
  /** The pool index last clicked, so its note stays on screen. */
  let picked: number | undefined;
  /** The store slot last clicked. Rename and Delete will act on this. */
  let pickedSlot: number | undefined;
  let busy = false;
  /** What Sounds mode had hidden when this mode took the panes. See `SOUNDS_ONLY`. */
  const hiddenBefore = new Map<string, boolean>();
  /**
   * And what the two panes were called.
   *
   * Restored for the same reason the visibility is: Sounds mode writes its headings when a project
   * is opened or a bank is browsed, so with neither done, coming back out left the page headed
   * *Wavetable pool* over the preset pool. Found by opening the page and pressing both tabs.
   */
  const titlesBefore = new Map<string, string>();
  /**
   * And where the two panes' `?` markers pointed.
   *
   * Same bug as the titles, one layer down. The marker on the left heading opened *Why both are on
   * one page*, about the preset pool, under a heading reading **Wavetable pool**.
   */
  const helpBefore = new Map<HTMLElement, string>();

  const projects = (): HTMLSelectElement => $<HTMLSelectElement>("wavepoolProject");

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
  function controls(on: boolean): void {
    $<HTMLSelectElement>("wavepoolProject").disabled = !on;
    $<HTMLButtonElement>("wavepoolRefresh").disabled = !on;
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
        `<p><b>This instrument has no wavetable store.</b> ${escapeHtml(answer.why)}.</p>` +
          `<p>Wavetables need a Waverider build. Nothing is wrong with the instrument or with ` +
          `DNX.</p>`,
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
        `<p><b>This build reports no wavetable store.</b> ${escapeHtml(answer.why)}.</p>` +
          `<p>DNX takes the record's word for it rather than offering a pane whose route may not ` +
          `answer.</p>`,
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
      `<p><b>DNX could not find out.</b> ${escapeHtml(answer.why)}.</p>` +
        `<p>This is not the same as the instrument not having wavetables. Another application ` +
        `holding the MIDI port is the usual cause: close Elektron Transfer and Overbridge, then ` +
        `press Refresh.</p>`,
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
      // The shown slot, 1..128. The built-ins Prim. and Harm. sit outside this numbering, and the
      // coarse value a sound stores is this number plus one. See 8w on the three numbers.
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
            ? "table deleted"
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
      },
    });

    const cell = picked === undefined ? undefined : summary.cells[picked];
    const chosen =
      cell === undefined
        ? ""
        : `<p><b>Slot ${cell.shown}</b> — ` +
          (cell.state === "empty"
            ? "nothing here. ADD TO POOL on the instrument fills the first free slot."
            : `store slot ${cell.storeSlot}${cell.name === undefined ? "" : ` · ${escapeHtml(cell.name)}`}` +
              `. A sound reaches it as coarse ${cell.coarse}.`) +
          `${cell.note === undefined ? "" : ` ${escapeHtml(cell.note)}`}</p>`;

    note(
      `<p>${escapeHtml(describePool(summary))}</p>` +
        (summary.missing === 0
          ? ""
          : `<p class="warn"><b>${summary.missing} slot(s) name a table that is gone.</b> Each ` +
            `plays the built-in Prim. Only clearing the slot frees it, and DNX will not do that ` +
            `on its own: clearing one digs a hole the next add falls into, and every sound still ` +
            `pointing at it would then play an unrelated table.</p>`) +
        (summary.repeated.length === 0
          ? ""
          : `<p>${
              summary.repeated.length === 1
                ? `Store slot ${summary.repeated[0]} is`
                : `Store slots ${summary.repeated.join(", ")} are`
            } named by more than one pool slot, which is legal.</p>`) +
        chosen,
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
      if (slot.slot === pickedSlot) {
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
      tr.addEventListener("click", () => {
        pickedSlot = slot.slot;
        renderStore();
        void showPreview(slot.slot);
      });
      body.append(tr);
    }
    table.append(body);
    where.append(table);

    const used = reading.store.filter((slot) => slot.occupied).length;
    heading(
      "Wavetable pool",
      `— ${reading.summary.tables} of ${POOL_ENTRIES} used`,
      "+Drive wavetables",
      `— ${used} of ${reading.store.length} slots used, shared by every project`,
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
    } catch (error) {
      // A table whose geometry does not measure its bytes is a real thing on a +Drive, and the
      // view refuses it by name rather than drawing a wave that is not there.
      previewMessage(`This table cannot be drawn. ${String(error)}`);
    }
  }

  /** Read one store slot's table and draw it. */
  async function showPreview(slot: number): Promise<void> {
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
    }
  }

  async function fillProjects(device: ConnectedDevice): Promise<void> {
    const select = projects();
    const open = host.openSlot();
    select.innerHTML = "";

    // **The working project first, and it is slot 0.** The only number here where 0 is not "the
    // first of 128": it is the project the instrument has loaded, the one the front panel edits,
    // and the one whose pool has a second writer.
    const working = document.createElement("option");
    working.value = "0";
    working.textContent = "Working project";
    select.append(working);

    try {
      for (const project of await listDeviceProjects(device)) {
        const option = document.createElement("option");
        option.value = String(project.index);
        option.textContent = `${String(project.index).padStart(3, "0")} ${project.name}`;
        select.append(option);
      }
    } catch (error) {
      // A pool can still be read without the names, so this is a worse list rather than a failure.
      host.status(`Could not list the projects, so only the working project is offered: ${String(error)}`, "warn");
    }

    select.value = open === undefined ? "0" : String(open);
  }

  async function refresh(): Promise<void> {
    const device = host.device();
    if (!device) return;
    if (busy) return;

    const projectSlot = Number(projects().value);
    busy = true;
    $<HTMLButtonElement>("wavepoolRefresh").disabled = true;
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
      busy = false;
      $<HTMLButtonElement>("wavepoolRefresh").disabled = false;
    }
  }

  async function show(on: boolean): Promise<void> {
    if (on) {
      for (const id of SOUNDS_ONLY) {
        hiddenBefore.set(id, $(id).hidden);
        $(id).hidden = true;
      }
      for (const id of TITLES) titlesBefore.set(id, $(id).textContent ?? "");
      helpFor(headingOf("leftTitle"), "library/wavetable-modes");
      helpFor(headingOf("libraryTitle"), "library/wavetable-limits");
    } else {
      for (const id of SOUNDS_ONLY) $(id).hidden = hiddenBefore.get(id) ?? false;
      for (const id of TITLES) $(id).textContent = titlesBefore.get(id) ?? "";
      restoreHelp();
      hideOurs();
      return;
    }

    $("wavepoolBar").hidden = false;
    const device = host.device();
    if (!device) {
      hideOurs();
      controls(false);
      $("wavepoolBar").hidden = false;
      heading("Wavetable pool", "— connect an instrument", "+Drive wavetables", "");
      note(
        `<p><b>Connect an instrument.</b> A wavetable pool is a record on the +Drive, one per ` +
          `project slot, so unlike a preset pool it is not in the project file: there is nothing ` +
          `to show until an instrument is here to ask.</p>`,
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

  projects().addEventListener("change", () => {
    void refresh();
  });
  $("wavepoolRefresh").addEventListener("click", () => {
    void refresh();
  });
  // `input` rather than `change`, so dragging the slider sweeps the stack instead of jumping once
  // on release. Redrawing is local arithmetic on a table already in hand; nothing is asked of the
  // instrument here.
  slider().addEventListener("input", () => {
    if (previewSlot === undefined) return;
    frameOf.set(previewSlot, Number(slider().value) - 1);
    drawPreview();
  });

  return { show, refresh };
}
