/**
 * The Samples mode of the Library page: the samples in digikit's card store.
 *
 * **One job: the sample half of this page.** It mirrors the Wavetables mode. The left pane is for
 * The right pane shows the store as one outline, with the free space above it. The pool is not
 * built yet, so the left pane holds the files to send. The pool takes that pane when it exists.
 *
 * ## The store is digikit's
 *
 * On 2026-10-30 the owner chose digikit's card store as the sample storage for every sample
 * machine. Only digikit's runtime writes the store, through digikit's own client
 * (`vendor/digikit/`, through `sample/digikitstore.ts`). An instrument without the runtime does
 * not answer, and the mode says so.
 *
 * ## One session per operation
 *
 * Each press opens a session on the page's port and closes it at the end. The session takes the
 * page's device claim, so a +Drive job and a store job cannot run at once. The transport passes
 * only digikit's messages, so the stock API's replies cannot reach it.
 *
 * ## The plan
 *
 * New folder, Delete and the files to send do not write. They wait in the plan, in the left pane,
 * where each one has Undo. **Send plan** asks once, with every step listed, and needs the WRITE
 * switch. `sample/sendplan.ts` gives the order: new folders, then uploads, then deletes, unless the
 * uploads need the space the deletes give back. A send that stops says which steps finished.
 *
 * Delete on a folder takes everything listed in it. **A delete keeps no copy.** A copy would need
 * a download, and the owner has not approved one yet. So the question says to keep the original
 * files. Rename, move and the pool are not here: they wait on the owner and digikit.
 *
 * ## Import
 *
 * Import WAV converts the chosen files on this computer with digikit's converter
 * (`web/vendor/dksample.wasm`, 16-bit 48 kHz, mono or stereo as the file is). Nothing is sent yet.
 * The page shows each file with a preview of the converted audio, and what its upload does
 * (`sample/importplan.ts`). **Each file keeps the folder that was open when it was chosen.** Opening
 * another folder does not move it, and a second Import adds to the list, so one Upload can fill
 * several folders. A drop goes to the folder under it and keeps the folders it came in, and a row
 * of the list can be dragged to another folder. Send plan sends the files one by one, and VERIFY
 * and LIST prove each one (`putAndVerify`).
 *
 * ## Only where the store answers
 *
 * The Samples entry of the dropdown is hidden until the instrument answers digikit's INFO. The
 * page asks once when an instrument connects (`reconnected`), with a one-second try. Firmware
 * without digikit's runtime does not answer, and the entry stays hidden.
 */

import { askConfirm, askText } from "../dialog.js";
import { claimDevice, deviceJobRefusal } from "../devicejob.js";
import { type ConnectedDevice } from "../devicesource.js";
import { $, escapeHtml } from "../dom.js";
import { installHelpMarkers } from "../helpmarker.js";
import { type DropEntry, type DroppedFile, droppedEntries, readDropped } from "./droppedfiles.js";
import { type StatusWriter } from "../statusbar.js";
import { requireWriteEnabled } from "../writeenable.js";
import { whileWriting } from "../writing.js";
import {
  DkError,
  dkTransport,
  hasCap,
  loadConverter,
  openDigikitStore,
  prepareWav,
  putAndVerify,
  storeSpace,
  type DkEntry,
  type DkInfoFull,
} from "@noiseandmatter/dnx-core/sample/digikitstore.js";
import { type SendPlan, type SendStep, describeDone, planSend } from "@noiseandmatter/dnx-core/sample/sendplan.js";
import { readNative } from "@noiseandmatter/dnx-core/sample/nativepcm.js";
import { type OutlineRow, storeOutline, storeSearch } from "@noiseandmatter/dnx-core/sample/storeoutline.js";
import {
  STORE_FOLDER,
  type StoreFile,
  type StoreFolder,
  folderNameProblem,
  folderPath,
  isFolderEntry,
  listFolder,
  verifyTimeoutMs,
} from "@noiseandmatter/dnx-core/sample/storelisting.js";

/** Elements of Sounds mode with no meaning here. Saved on the way in, restored on the way out. */
const SOUNDS_ONLY = [
  "browse",
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
const OURS = ["samplestageZone", "samplestoreBar", "samplestoreNote", "samplestoreGrid"] as const;

/** Controls that reach the instrument, off together while a session runs. */
const WHILE_BUSY = [
  "kind",
  "samplestoreRefresh",
  "samplestoreVerify",
  "samplestoreMkdir",
  "samplestoreDelete",
  "samplestoreImport",
  "samplestoreClear",
  "samplestoreUpload",
] as const;

const TITLES = ["leftTitle", "poolSub", "libraryTitle", "librarySub"] as const;

export interface SampleHost {
  /** The instrument, when one is connected. */
  device(): ConnectedDevice | undefined;
  status: StatusWriter;
}

export interface SampleMode {
  /** Enter or leave. Entering reads the store. Leaving hands the panes back. */
  show(on: boolean): Promise<void>;
  /** Read the store again. */
  refresh(): Promise<void>;
  /**
   * Another instrument answered, or none is chosen: forget what the last one said, and ask the new
   * one whether it has the store. True when it answered.
   */
  reconnected(): Promise<boolean>;
}

/** The sha256 the store lists for a folder. */
const ZERO_SHA = "0".repeat(64);

/** The drag type for a row of the list, so a drop can tell one from a file. */
const STAGED_TYPE = "application/x-dnx-staged-sample";

/** A converted file waiting for Upload, and the folder that gets it. */
type Staged = ReturnType<typeof prepareWav> & { folder: string };

/** What the last read found. */
interface StoreReading {
  info: DkInfoFull;
  entries: DkEntry[];
  free: number;
  total: number | null;
}

/** A store session for `work`, on the instrument's port. */
type Store = ReturnType<typeof openDigikitStore>;

/** An error's own words, without the "Error: " that `String` adds. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const mib = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MiB`;
const kib = (bytes: number): string => `${Math.ceil(bytes / 1024).toLocaleString()} KiB`;
const runtimeName = (packed: number): string =>
  `${packed >>> 16}.${(packed >>> 8) & 255}.${packed & 255}`;

export function wireSamples(host: SampleHost): SampleMode {
  let shown = false;
  let busy = false;
  let reading: StoreReading | undefined;
  /** Why the store could not be read, when it could not. */
  let problem: string | undefined;
  /** The selected folder, relative to `samples/`. New files and new folders go here. */
  let folder = "";
  /** The selected row's store path. */
  let picked: string | undefined;
  /** The folders open in the outline, relative to `samples/`. */
  const opened = new Set<string>();
  /** What the search box holds. */
  let query = "";
  /** The row that takes the focus after the next draw, because each draw rebuilds the table. */
  let focused: string | undefined;
  /** The row of the list being dragged. */
  let draggedFile: Staged | undefined;
  const hiddenBefore = new Map<string, boolean>();
  const titlesBefore = new Map<string, string>();
  const helpBefore = new Map<HTMLElement, string>();
  /** The converted files waiting for Upload, and the files that could not be converted. */
  let staged: Staged[] = [];
  let unconverted: { name: string; why: string }[] = [];
  /** The folders to make when the plan is sent, relative to `samples/`. */
  const newFolders = new Set<string>();
  /** The store paths to delete when the plan is sent. */
  const deletes = new Set<string>();
  let converter: ReturnType<typeof loadConverter> | undefined;
  let audio: AudioContext | undefined;
  let playing: { file: Staged; source: AudioBufferSourceNode } | undefined;

  function pickedRow(): StoreFile | StoreFolder | undefined {
    if (!reading || picked === undefined) return undefined;
    // The row's parent folder: its path without `samples/` and without its own name.
    const inside = picked.slice(STORE_FOLDER.length + 1);
    const parent = inside.includes("/") ? inside.slice(0, inside.lastIndexOf("/")) : "";
    const shownNow = listFolder(shownEntries(), parent);
    return [...shownNow.folders, ...shownNow.files].find((row) => row.path === picked);
  }

  const isFile = (row: StoreFile | StoreFolder): row is StoreFile => "sha256" in row;

  /** The store's listing, with the folders of the plan as empty folders. */
  function shownEntries(): DkEntry[] {
    if (!reading) return [];
    const planned = [...newFolders].map((inside) => ({ path: folderPath(inside), size: 0, sha256: ZERO_SHA }));
    return [...reading.entries, ...planned];
  }

  /** Something waits to be sent: a folder, a file or a delete. */
  const planned = (): boolean => newFolders.size + deletes.size + staged.length > 0;

  /** Run `work` in a session of its own. Undefined when nothing ran. */
  async function withStore<T>(
    work: (store: Store) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T | undefined> {
    const device = host.device();
    if (!device) {
      host.status("Connect an instrument first.", "warn");
      return undefined;
    }
    const release = claimDevice("The sample store");
    if (!release) {
      host.status(deviceJobRefusal(), "warn");
      return undefined;
    }
    setBusy(true);
    const transport = dkTransport(device.io);
    try {
      return await work(openDigikitStore(transport, timeoutMs === undefined ? undefined : { timeoutMs }));
    } finally {
      transport.close();
      release();
      setBusy(false);
    }
  }

  function setBusy(on: boolean): void {
    busy = on;
    for (const id of WHILE_BUSY) {
      const control = document.getElementById(id);
      if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) control.disabled = on;
    }
    const grid = $("samplestoreGrid");
    grid.classList.toggle("locked", on);
    grid.setAttribute("aria-busy", String(on));
    for (const button of $("samplestoreStageList").querySelectorAll<HTMLButtonElement>(".stageRemove")) button.disabled = on;
    if (!on) controls();
  }

  /** Each control's own state, from what is on screen. */
  function controls(): void {
    if (busy) return;
    const connected = host.device() !== undefined;
    const row = pickedRow();
    $<HTMLButtonElement>("samplestoreRefresh").disabled = !connected;

    const verify = $<HTMLButtonElement>("samplestoreVerify");
    verify.disabled = !row || !isFile(row);
    verify.title = row && isFile(row)
      ? `Read ${row.name} from the card again and compare its sha256 with the store's.`
      : "Click a sample first.";

    const mkdir = $<HTMLButtonElement>("samplestoreMkdir");
    const folders = reading !== undefined && hasCap(reading.info, "FOLDERS");
    mkdir.disabled = !folders;
    mkdir.title = !reading
      ? "Read the store first."
      : folders
        ? `Add a new folder in ${folderPath(folder)}/ to the plan.`
        : `digikit ${runtimeName(reading.info.runtime)} cannot make an empty folder.`;

    const remove = $<HTMLButtonElement>("samplestoreDelete");
    const undo = row !== undefined && isMarked(row.path);
    remove.textContent = undo ? "Undo delete" : "Delete";
    remove.disabled = !row;
    remove.title = !row
      ? "Click a sample or a folder first."
      : undo
        ? `Take ${row.name} off the plan's deletes.`
        : newFolders.has(row.path.slice(STORE_FOLDER.length + 1))
          ? `Take the new folder ${row.name} off the plan.`
          : isFile(row)
            ? `Add ${row.name} to the plan's deletes. No copy is kept.`
            : `Add ${row.name} and everything in it to the plan's deletes. No copy is kept.`;

    const pick = $<HTMLButtonElement>("samplestoreImport");
    pick.disabled = !reading;
    pick.title = reading ? `Choose WAV files for ${folderPath(folder)}/.` : "Read the store first.";

    const plan = currentPlan();
    const send = $<HTMLButtonElement>("samplestoreUpload");
    send.disabled = !plan || plan.problem !== undefined;
    send.title = !plan ? "The plan is empty." : plan.problem ?? `Run the ${plan.steps.length} steps of the plan.`;
    $<HTMLButtonElement>("samplestoreClear").disabled = busy || (!planned() && unconverted.length === 0);
  }

  function currentPlan(): SendPlan | undefined {
    if (!reading || !planned()) return undefined;
    return planSend({
      entries: reading.entries,
      folders: [...newFolders],
      uploads: staged,
      deletes: [...deletes],
      free: reading.free,
    });
  }

  /** The store entries at `path` and under it. */
  function subtree(path: string): DkEntry[] {
    return (reading?.entries ?? []).filter((e) => e.path === path || e.path.startsWith(`${path}/`));
  }

  /** The path is in the plan's deletes: the path itself, or all that is listed under a folder. */
  function isMarked(path: string): boolean {
    if (deletes.has(path)) return true;
    const under = subtree(path);
    return under.length > 0 && under.every((e) => deletes.has(e.path));
  }

  /** Where the sendable files go: one folder by name, or how many folders. */
  function destination(): string {
    const plan = currentPlan();
    const folders = new Set(staged.filter((_, i) => !plan?.uploads.files[i]?.problem).map((file) => file.folder));
    return folders.size === 1 ? `${folderPath([...folders][0]!)}/` : `${folders.size} folders`;
  }

  /** A remove button for a row of the import list. */
  function removeButton(remove: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "btn stageRemove";
    button.textContent = "Remove";
    button.title = "Take this file off the list. Nothing is sent.";
    button.disabled = busy;
    button.addEventListener("click", () => {
      if (busy) return;
      remove();
      render();
    });
    return button;
  }

  function heading(left: string, leftSub: string, right: string, rightSub: string): void {
    $("leftTitle").textContent = left;
    $("poolSub").textContent = leftSub;
    $("libraryTitle").textContent = right;
    $("librarySub").textContent = rightSub;
  }

  function helpFor(titleId: string, target: string): void {
    const h2 = $(titleId).closest("h2");
    if (!(h2 instanceof HTMLElement)) return;
    if (!helpBefore.has(h2)) helpBefore.set(h2, h2.dataset["help"] ?? "");
    h2.dataset["help"] = target;
    h2.querySelector(":scope > .helpq")?.remove();
    installHelpMarkers(h2.parentElement ?? h2);
  }

  function restoreHelp(): void {
    for (const [h2, was] of helpBefore) {
      h2.dataset["help"] = was;
      h2.querySelector(":scope > .helpq")?.remove();
      installHelpMarkers(h2.parentElement ?? h2);
    }
    helpBefore.clear();
  }

  function note(html: string): void {
    const where = $("samplestoreNote");
    where.hidden = html === "";
    where.innerHTML = html;
  }

  function renderStage(): void {
    const stage = $("samplestoreStage");
    const plan = currentPlan();
    stage.hidden = !planned() && unconverted.length === 0;
    $("samplestageHint").hidden = !stage.hidden || !reading;
    if (stage.hidden) return;
    const list = $("samplestoreStageList");
    list.innerHTML = "";
    list.append(...planSection("New folders", [...newFolders].sort().map((inside) => ({
      text: `${folderPath(inside)}/`,
      undo: () => dropNewFolder(inside),
    }))));
    list.append(...planSection("Delete", [...deletes].sort().map((path) => ({
      text: reading?.entries.some((e) => e.path === path && isFolderEntry(e)) ? `${path}/` : path,
      undo: () => {
        deletes.delete(path);
      },
    }))));
    if (staged.length + unconverted.length > 0 && list.childElementCount > 0) {
      const send = document.createElement("h3");
      send.className = "planhead";
      send.textContent = "Send";
      list.append(send);
    }
    const table = document.createElement("table");
    table.className = "libtable";
    table.innerHTML = "<thead><tr><th>File</th><th>Folder</th><th>Audio</th><th>Size</th><th></th><th></th></tr></thead>";
    const body = document.createElement("tbody");
    staged.forEach((file, i) => {
      const row = plan?.uploads.files[i];
      const info = file.info;
      const tr = document.createElement("tr");
      tr.className = "occupied";
      tr.draggable = true;
      tr.title = "Drag to a folder of the store to send this file there.";
      tr.addEventListener("dragstart", (event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        draggedFile = file;
        event.dataTransfer?.setData(STAGED_TYPE, file.name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      tr.addEventListener("dragend", () => {
        draggedFile = undefined;
      });
      const audioText = info
        ? `${info.channels === 2 ? "stereo" : "mono"}, ${(info.frames / 48_000).toFixed(2)} s`
        : "";
      const state = row?.problem
        ? `<span class="warn">${escapeHtml(row.problem)}</span>`
        : row?.replaces
          ? `<span class="warn">replaces the sample of this name</span>`
          : "";
      tr.innerHTML =
        `<td class="name">${escapeHtml(file.name)}</td>` +
        `<td class="use"><code>${escapeHtml(folderPath(file.folder))}/</code></td><td class="use">${audioText}</td>` +
        `<td class="n">${kib(file.stored.length)}</td><td>${state}</td><td></td>`;
      const play = document.createElement("button");
      play.className = "btn";
      play.textContent = playing?.file === file ? "Stop" : "Play";
      play.title = "Play the converted audio on this computer.";
      play.addEventListener("click", () => preview(file));
      tr.lastElementChild!.append(
        play,
        " ",
        removeButton(() => {
          if (playing?.file === file) stopPreview();
          staged = staged.filter((other) => other !== file);
        }),
      );
      body.append(tr);
    });
    for (const bad of unconverted) {
      const tr = document.createElement("tr");
      tr.className = "occupied";
      tr.innerHTML =
        `<td class="name">${escapeHtml(bad.name)}</td><td class="use"></td><td class="use"></td><td class="n"></td>` +
        `<td><span class="warn">${escapeHtml(bad.why)}</span></td><td></td>`;
      tr.lastElementChild!.append(removeButton(() => {
        unconverted = unconverted.filter((other) => other !== bad);
      }));
      body.append(tr);
    }
    table.append(body);
    if (body.childElementCount > 0) list.append(table);
    $("samplestoreStageSum").textContent = plan ? plan.problem ?? planSummary(plan) : "No file can be sent.";
  }

  /** The plan in one line: what it sends, what it frees, and the free space after. */
  function planSummary(plan: SendPlan): string {
    const sent = plan.uploads.sent;
    return [
      ...(sent > 0 ? [`${sent} ${sent === 1 ? "sample" : "samples"}, ${mib(plan.bytes)}, to ${destination()}`] : []),
      ...(plan.freed > 0 ? [`${mib(plan.freed)} freed`] : []),
      `${mib(plan.freeAfter)} free after`,
    ].join(" · ");
  }

  /** A heading and one row per change, each with an Undo button. Nothing when there are no changes. */
  function planSection(title: string, rows: { text: string; undo: () => void }[]): HTMLElement[] {
    if (rows.length === 0) return [];
    const head = document.createElement("h3");
    head.className = "planhead";
    head.textContent = title;
    const ul = document.createElement("ul");
    ul.className = "planlist";
    for (const row of rows) {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = row.text;
      const undo = document.createElement("button");
      undo.className = "btn stageRemove";
      undo.textContent = "Undo";
      undo.title = "Take this change off the plan. Nothing is sent.";
      undo.disabled = busy;
      undo.addEventListener("click", () => {
        if (busy) return;
        row.undo();
        render();
      });
      li.append(code, " ", undo);
      ul.append(li);
    }
    return [head, ul];
  }

  /** Take a new folder, and the new folders in it, off the plan. Files staged for it stay, and their upload makes it. */
  function dropNewFolder(inside: string): void {
    for (const other of [...newFolders]) if (other === inside || other.startsWith(`${inside}/`)) newFolders.delete(other);
  }

  function render(): void {
    if (!shown) return;
    renderStage();
    $("samplestageZone").hidden = false;
    $("samplestoreBar").hidden = false;
    $("samplestorePath").textContent = `${folderPath(folder)}/`;
    const grid = $("samplestoreGrid");
    controls();

    if (!host.device()) {
      heading("Plan", "", "Sample store", "— connect an instrument");
      note("<p><b>Connect an instrument.</b> The samples are read from its card store.</p>");
      grid.hidden = true;
      return;
    }
    if (!reading) {
      heading("Plan", "", "Sample store", problem ? "— not read" : "");
      note(problem ? `<p class="warn">${escapeHtml(problem)}</p>` : "");
      grid.hidden = true;
      return;
    }

    const count = reading.entries.filter((entry) => !isFolderEntry(entry)).length;
    const waiting = newFolders.size + deletes.size + staged.length + unconverted.length;
    heading(
      "Plan",
      waiting === 0 ? "" : `— ${waiting} ${waiting === 1 ? "change" : "changes"}`,
      "Sample store",
      `— ${count} ${count === 1 ? "sample" : "samples"}`,
    );
    note(
      `<p>Free: <b>${mib(reading.free)}</b>${reading.total === null ? "" : ` of ${mib(reading.total)}`}. ` +
        `digikit ${escapeHtml(runtimeName(reading.info.runtime))}.</p>` +
        (reading.info.safe_mode ? `<p class="warn">digikit is in safe mode.</p>` : ""),
    );
    grid.hidden = false;
    grid.innerHTML = "";

    const table = document.createElement("table");
    table.className = "libtable";
    table.innerHTML = "<thead><tr><th>Name</th><th>Size</th><th></th></tr></thead>";
    const body = document.createElement("tbody");
    const searching = query.trim() !== "";
    if (!searching) body.append(topRow());
    const rows = searching ? storeSearch(shownEntries(), query) : storeOutline(shownEntries(), opened);
    for (const row of rows) body.append(outlineRow(row));
    if (searching && rows.length === 0) {
      body.innerHTML = `<tr class="free"><td class="name" colspan="3"><span class="hint">Nothing matches.</span></td></tr>`;
    }
    table.append(body);
    grid.append(table);
    if (focused !== undefined) {
      body.querySelector<HTMLElement>(`tr[data-path="${CSS.escape(focused)}"]`)?.focus();
      focused = undefined;
    }
  }

  /** A row's button that makes a folder in `parent`. */
  function folderButton(parent: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "btn";
    button.textContent = "+ folder";
    button.title = `Make a folder in ${folderPath(parent)}/.`;
    button.disabled = busy || !reading || !hasCap(reading.info, "FOLDERS");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void makeFolder(parent);
    });
    return button;
  }

  /** The events every row shares: selected by a click or by Enter, and a drop target for its folder. */
  function rowEvents(tr: HTMLTableRowElement, path: string, target: string, clicked: () => void): void {
    tr.dataset["path"] = path;
    tr.dataset["folder"] = target;
    tr.tabIndex = 0;
    tr.addEventListener("click", () => {
      if (busy) return;
      clicked();
      render();
    });
    tr.addEventListener("keydown", (event) => {
      if (event.target !== tr || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      if (busy) return;
      focused = path;
      clicked();
      render();
    });
  }

  /** The row of the store's top folder. */
  function topRow(): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.className = "occupied folder";
    if (folder === "" && picked === undefined) tr.classList.add("selected");
    tr.innerHTML = `<td class="name">${escapeHtml(STORE_FOLDER)}/</td><td class="n"></td><td class="acts"></td>`;
    tr.lastElementChild!.append(folderButton(""));
    rowEvents(tr, STORE_FOLDER, "", () => {
      folder = "";
      picked = undefined;
    });
    return tr;
  }

  function outlineRow(row: OutlineRow): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.className = row.kind === "folder" ? "occupied folder" : "occupied";
    if (row.path === picked) {
      tr.classList.add("selected");
      tr.setAttribute("aria-selected", "true");
    }
    const inset = `padding-left: calc(.5rem + ${row.depth + 1} * 1em)`;
    const marked = isMarked(row.path);
    const isNew = row.kind === "folder" && newFolders.has(row.folder);
    if (marked) tr.classList.add("gone");
    if (isNew) tr.classList.add("planned");
    const tag = marked ? `<span class="tag bad">to delete</span>` : isNew ? `<span class="tag new">new</span>` : "";
    if (row.kind === "file") {
      tr.title = `sha256 ${row.sha256}`;
      tr.innerHTML =
        `<td class="name" style="${inset}"><span class="caret"></span>${escapeHtml(row.name)}${tag}</td>` +
        `<td class="n">${kib(row.size)}</td><td class="acts"></td>`;
      rowEvents(tr, row.path, row.folder, () => {
        picked = row.path;
        folder = row.folder;
      });
      return tr;
    }
    const searching = query.trim() !== "";
    const closed = !searching && !row.open;
    const empty = row.folders === 0 && row.files === 0;
    tr.setAttribute("aria-expanded", String(row.open));
    tr.innerHTML =
      `<td class="name" style="${inset}"><span class="caret">${searching || empty ? "" : row.open ? "▾" : "▸"}</span>${escapeHtml(row.name)}/${tag}</td>` +
      `<td class="n">${row.files === 0 ? "empty" : `${row.files} ${row.files === 1 ? "sample" : "samples"}`}</td>` +
      `<td class="acts"></td>`;
    tr.lastElementChild!.append(folderButton(row.folder));
    rowEvents(tr, row.path, row.folder, () => {
      // A closed folder opens. An open folder closes only when it is already the selected one.
      if (closed && !empty) opened.add(row.folder);
      else if (picked === row.path) opened.delete(row.folder);
      picked = row.path;
      folder = row.folder;
    });
    return tr;
  }

  /** Select `next` and open the folders down to it. */
  function reveal(next: string): void {
    folder = next;
    picked = undefined;
    query = "";
    $<HTMLInputElement>("samplestoreFind").value = "";
    const parts = next === "" ? [] : next.split("/");
    parts.forEach((_, i) => opened.add(parts.slice(0, i + 1).join("/")));
    render();
  }

  /** Read INFO, the listing and the free space. */
  async function read(store: Store): Promise<void> {
    let info: DkInfoFull;
    try {
      info = await store.session.info(true);
    } catch (error) {
      reading = undefined;
      problem = error instanceof DkError && error.kind === "timeout"
        ? "This instrument did not answer digikit. The sample store needs firmware with the digikit runtime."
        : `The store could not be read. ${messageOf(error)}`;
      return;
    }
    const entries = await store.session.list(`${STORE_FOLDER}/`);
    const space = await storeSpace(store.session, info);
    reading = { info, entries, free: space.free, total: space.total };
    problem = undefined;
    // A change the store already shows is no longer a change.
    for (const path of [...deletes]) if (!entries.some((e) => e.path === path)) deletes.delete(path);
    for (const inside of [...newFolders]) if (entries.some((e) => e.path === folderPath(inside))) newFolders.delete(inside);
    // A folder that went away (deleted, or emptied of its last file) is left for the nearest one that remains.
    const here = shownEntries();
    while (folder !== "" && !here.some((e) => e.path.startsWith(`${folderPath(folder)}/`) || e.path === folderPath(folder))) {
      folder = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    }
    if (picked !== undefined && !pickedRow()) picked = undefined;
  }

  async function refresh(): Promise<void> {
    if (!shown) return;
    host.status("Reading the sample store…");
    const ran = await withStore(async (store) => {
      await read(store);
      return true;
    }).catch((error: unknown) => {
      reading = undefined;
      problem = `The store could not be read. ${messageOf(error)}`;
      return true;
    });
    render();
    // Nothing ran: `withStore` has already said why.
    if (ran === undefined) return;
    host.status(problem ?? "Read the sample store.", problem ? "warn" : "ok");
  }

  async function verify(): Promise<void> {
    const row = pickedRow();
    if (!row || !isFile(row)) return;
    host.status(`Reading ${row.name} from the card…`);
    try {
      const card = await withStore((store) => store.session.verify(row.path), verifyTimeoutMs(row.size));
      if (card === undefined) return;
      if (card === row.sha256) host.status(`${row.name}: the card holds the bytes the store lists.`, "ok");
      else host.status(`${row.name}: the card's sha256 is ${card.slice(0, 12)}, not ${row.sha256.slice(0, 12)}.`, "error");
    } catch (error) {
      host.status(`The verify failed. ${messageOf(error)}`, "error");
    }
  }

  async function makeFolder(parent: string): Promise<void> {
    if (!reading || busy) return;
    const name = await askText({
      title: `New folder in ${folderPath(parent)}/`,
      body: ["Use letters, digits, spaces and ASCII punctuation."],
      confirmLabel: "Make the folder",
    });
    if (name === undefined) return;
    const why = folderNameProblem(parent, name);
    if (why) {
      host.status(why, "warn");
      return;
    }
    const inside = parent === "" ? name : `${parent}/${name}`;
    const path = folderPath(inside);
    if (shownEntries().some((e) => e.path === path || e.path.startsWith(`${path}/`))) {
      host.status(`${path}/ is already in the store or the plan.`, "warn");
      return;
    }
    newFolders.add(inside);
    reveal(inside);
    host.status(`${path}/ is in the plan. Push Send plan to make it.`, "ok");
  }

  /**
   * Add the selected row to the plan's deletes, or take it off. A folder takes everything listed
   * in it. A new folder of the plan leaves the plan. Nothing is sent.
   */
  function remove(): void {
    const row = pickedRow();
    if (!row || busy) return;
    const inside = row.path.slice(STORE_FOLDER.length + 1);
    if (newFolders.has(inside)) {
      dropNewFolder(inside);
      render();
      host.status(`${row.path}/ is off the plan.`, "ok");
      return;
    }
    const paths = isFile(row) ? [row.path] : subtree(row.path).map((e) => e.path);
    if (isMarked(row.path)) {
      for (const path of paths) deletes.delete(path);
      render();
      host.status(`${row.name} is off the plan's deletes.`, "ok");
      return;
    }
    for (const path of paths) deletes.add(path);
    render();
    host.status(
      `${row.name} is in the plan's deletes${paths.length > 1 ? `, with ${paths.length - 1} more` : ""}. Push Send plan to delete.`,
      "ok",
    );
  }

  function stopPreview(): void {
    if (!playing) return;
    const { source } = playing;
    playing = undefined;
    source.onended = null;
    source.stop();
  }

  /** Play `file`'s converted audio here, or stop it when it is the one playing. */
  function preview(file: Staged): void {
    const same = playing?.file === file;
    stopPreview();
    if (same) {
      renderStage();
      return;
    }
    try {
      const pcm = readNative(file.stored);
      audio ??= new AudioContext();
      const buffer = audio.createBuffer(pcm.channels, Math.max(1, pcm.frames), pcm.rate);
      pcm.channelData.forEach((data, c) => buffer.getChannelData(c).set(data));
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.onended = () => {
        if (playing?.source === source) playing = undefined;
        renderStage();
      };
      playing = { file, source };
      void audio.resume();
      source.start();
    } catch (error) {
      host.status(`${file.name} cannot be played. ${messageOf(error)}`, "error");
    }
    renderStage();
  }

  /**
   * Convert the chosen WAV files and add them to the list, for `into` and the folders each one came
   * in. Nothing is sent.
   */
  async function choose(files: readonly DroppedFile[], into: string): Promise<void> {
    if (files.length === 0) return;
    stopPreview();
    host.status(`Converting ${files.length} ${files.length === 1 ? "file" : "files"}…`);
    try {
      converter ??= fetch("vendor/dksample.wasm").then(async (response) => {
        if (!response.ok) throw new Error(`the converter did not load (${response.status})`);
        return loadConverter(await response.arrayBuffer());
      });
      const sample = await converter;
      for (const { file, folder: from } of files) {
        const target = into === "" || from === "" ? into || from : `${into}/${from}`;
        try {
          staged.push({ ...prepareWav(sample, file.name, new Uint8Array(await file.arrayBuffer())), folder: target });
        } catch (error) {
          unconverted.push({ name: file.name, why: messageOf(error) });
        }
      }
    } catch (error) {
      converter = undefined;
      host.status(`The files were not converted. ${messageOf(error)}`, "error");
      return;
    }
    render();
    const plan = currentPlan();
    host.status(
      plan && !plan.problem
        ? `Converted. ${plan.uploads.sent} ${plan.uploads.sent === 1 ? "file is" : "files are"} in the plan for ${destination()}.`
        : "Converted. Some files cannot be sent. The list says why.",
      plan && !plan.problem ? "ok" : "warn",
    );
  }

  /** Take a drop of files from this computer, for `into`. */
  async function takeDrop(entries: readonly DropEntry[], into: string): Promise<void> {
    const { wavs, skipped } = await readDropped(entries);
    if (wavs.length === 0) {
      host.status("The drop holds no WAV file.", "warn");
      return;
    }
    await choose(wavs, into);
    if (skipped > 0) host.status(`Added ${wavs.length}. ${skipped} ${skipped === 1 ? "file was" : "files were"} not WAV.`, "warn");
  }

  /**
   * The two places that take a drop. A row of the store takes it for its folder, and the rest of
   * the store and the list take it for the selected folder. A row of the list can go only to the
   * store.
   */
  function wireDrops(): void {
    const grid = $("samplestoreGrid");
    const zone = $("samplestageZone");
    const clear = (): void => {
      for (const on of document.querySelectorAll(".dropon")) on.classList.remove("dropon");
    };
    const wanted = (event: DragEvent): boolean => {
      const kinds = event.dataTransfer?.types ?? [];
      return shown && !busy && reading !== undefined && kinds.includes("Files");
    };
    const rowUnder = (event: DragEvent): HTMLElement | null =>
      (event.target as HTMLElement).closest<HTMLElement>("tr[data-folder]");

    grid.addEventListener("dragover", (event) => {
      const moving = event.dataTransfer?.types.includes(STAGED_TYPE) === true && draggedFile !== undefined;
      if (!moving && !wanted(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = moving ? "move" : "copy";
      clear();
      (rowUnder(event) ?? grid).classList.add("dropon");
    });
    grid.addEventListener("dragleave", (event) => {
      if (!grid.contains(event.relatedTarget as Node | null)) clear();
    });
    grid.addEventListener("drop", (event) => {
      clear();
      const into = rowUnder(event)?.dataset["folder"] ?? folder;
      if (draggedFile) {
        event.preventDefault();
        const file = draggedFile;
        draggedFile = undefined;
        if (busy) return;
        file.folder = into;
        render();
        host.status(`${file.name} goes to ${folderPath(into)}/.`, "ok");
        return;
      }
      if (!wanted(event) || !event.dataTransfer) return;
      event.preventDefault();
      void takeDrop(droppedEntries(event.dataTransfer), into);
    });

    zone.addEventListener("dragover", (event) => {
      if (!wanted(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      zone.classList.add("dropon");
    });
    zone.addEventListener("dragleave", (event) => {
      if (!zone.contains(event.relatedTarget as Node | null)) clear();
    });
    zone.addEventListener("drop", (event) => {
      clear();
      if (!wanted(event) || !event.dataTransfer) return;
      event.preventDefault();
      void takeDrop(droppedEntries(event.dataTransfer), folder);
    });
  }

  /** Take every change off the plan. Nothing is sent. */
  function discardPlan(): void {
    stopPreview();
    staged = [];
    unconverted = [];
    newFolders.clear();
    deletes.clear();
    render();
  }

  /** One step of the plan as a line of the confirmation, and of the status when it stops. */
  function stepText(plan: SendPlan, step: SendStep): string {
    if (step.kind === "mkdir") return `Make ${folderPath(step.folder)}/`;
    if (step.kind === "delete") return `Delete ${step.path}${step.folder ? "/" : ""}`;
    const file = plan.uploads.files[step.index]!;
    return `Send ${file.path}, ${kib(file.size)}${file.replaces ? ", replaces the sample" : ""}`;
  }

  /** Run the plan's steps in their order, after one confirmation. */
  async function sendPlan(): Promise<void> {
    const plan = currentPlan();
    if (!plan || plan.problem) return;
    const deleting = plan.steps.some((step) => step.kind === "delete");
    const ok = await askConfirm({
      title: `Send the plan? ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}`,
      body: [
        "DNX checks each file on the card after it is sent.",
        ...(deleting ? ["DNX keeps no copy of a sample that it deletes. Keep your original files."] : []),
        ...(plan.deletesFirst ? ["The deletes run first, because the files to send need their space."] : []),
        "Do not load a project on the instrument until the plan is done.",
      ],
      list: plan.steps.map((step) => stepText(plan, step)),
      confirmLabel: "Send the plan",
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled. Nothing was sent.", "warn");
      return;
    }
    stopPreview();
    const done: SendStep[] = [];
    const sentFiles = (): Staged[] => done.flatMap((step) => (step.kind === "upload" ? [staged[step.index]!] : []));
    let failed: SendStep | undefined;
    try {
      requireWriteEnabled();
      const ran = await withStore((store) => whileWriting(async () => {
        try {
          const uploads = plan.steps.filter((step) => step.kind === "upload").length;
          let n = 0;
          for (const step of plan.steps) {
            failed = step;
            if (step.kind === "mkdir") {
              host.status(`Making ${folderPath(step.folder)}/…`);
              await store.samples.mkdir(step.folder);
            } else if (step.kind === "delete") {
              host.status(`Deleting ${step.path}…`);
              await store.session.delete(step.path);
            } else {
              const file = staged[step.index]!;
              n += 1;
              const at = n;
              await putAndVerify(store, file.folder, file, (sent, total) =>
                host.status(`Sending ${file.name} (${at} of ${uploads}): ${Math.round((100 * sent) / Math.max(1, total))} %`));
            }
            done.push(step);
          }
          failed = undefined;
        } finally {
          await read(store).catch(() => {});
        }
        return true;
      }));
      if (ran === undefined) return;
      // A file that could not go stays on the list, with its reason.
      const sent = sentFiles();
      staged = staged.filter((file) => !sent.includes(file));
      unconverted = [];
      render();
      host.status(`Sent the plan: ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}. Each file is verified on the card.`, "ok");
    } catch (error) {
      const sent = sentFiles();
      staged = staged.filter((file) => !sent.includes(file));
      render();
      host.status(
        `The plan stopped${failed ? ` at "${stepText(plan, failed)}"` : ""}. ${messageOf(error).replace(/([^.])$/, "$1.")} ` +
          describeDone(done, (index) => plan.uploads.files[index]!.name),
        "error",
      );
    }
  }

  $("samplestoreRefresh").addEventListener("click", () => void refresh());
  $("samplestoreVerify").addEventListener("click", () => void verify());
  $("samplestoreMkdir").addEventListener("click", () => void makeFolder(folder));
  $("samplestoreDelete").addEventListener("click", () => remove());
  $("samplestoreImport").addEventListener("click", () => {
    const input = $<HTMLInputElement>("samplestoreFiles");
    input.value = "";
    input.click();
  });
  $("samplestoreFiles").addEventListener("change", (event) => {
    const files = [...((event.target as HTMLInputElement).files ?? [])];
    void choose(files.map((file) => ({ file, folder: "" })), folder);
  });
  $("samplestoreFind").addEventListener("input", (event) => {
    query = (event.target as HTMLInputElement).value;
    render();
  });
  wireDrops();
  $("samplestoreClear").addEventListener("click", () => discardPlan());
  $("samplestoreUpload").addEventListener("click", () => void sendPlan());

  async function show(on: boolean): Promise<void> {
    if (on) {
      for (const id of SOUNDS_ONLY) {
        hiddenBefore.set(id, $(id).hidden);
        $(id).hidden = true;
      }
      for (const id of TITLES) titlesBefore.set(id, $(id).textContent ?? "");
      helpFor("leftTitle", "library/sample-import");
      helpFor("libraryTitle", "library/sample-store");
      shown = true;
      render();
      await refresh();
      return;
    }
    for (const id of SOUNDS_ONLY) $(id).hidden = hiddenBefore.get(id) ?? false;
    for (const id of TITLES) $(id).textContent = titlesBefore.get(id) ?? "";
    for (const id of OURS) $(id).hidden = true;
    stopPreview();
    restoreHelp();
    shown = false;
  }

  /** Whether this instrument answers digikit, from one quick INFO. */
  async function answers(): Promise<boolean> {
    if (!host.device()) return false;
    try {
      return (await withStore((store) => store.session.info(true).then(() => true))) === true;
    } catch {
      return false;
    }
  }

  async function reconnected(): Promise<boolean> {
    reading = undefined;
    problem = undefined;
    folder = "";
    picked = undefined;
    opened.clear();
    query = "";
    $<HTMLInputElement>("samplestoreFind").value = "";
    discardPlan();
    const has = await answers();
    if (shown && has) await refresh();
    return has;
  }

  return { show, refresh, reconnected };
}
