/**
 * The Samples mode of the Library page: the samples in digikit's card store.
 *
 * **One job: the sample half of this page.** It mirrors the Wavetables mode. The left pane is for
 * a project's sample pool and the right pane for the store. The pool is not built yet, so the
 * left pane says so. The store pane lists one folder at a time, with the free space above it.
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
 * ## The writes
 *
 * New folder and Delete write to the store. Each needs the WRITE switch, and Delete asks first.
 * **A delete keeps no copy.** A copy would need a download, and the owner has not approved one
 * yet. So the question says to keep the original file. Rename, move, import and the pool are not
 * here: import comes next, and the rest wait on the owner and digikit.
 */

import { askConfirm, askText } from "../dialog.js";
import { claimDevice, deviceJobRefusal } from "../devicejob.js";
import { type ConnectedDevice } from "../devicesource.js";
import { $, escapeHtml } from "../dom.js";
import { installHelpMarkers } from "../helpmarker.js";
import { type StatusWriter } from "../statusbar.js";
import { requireWriteEnabled } from "../writeenable.js";
import { whileWriting } from "../writing.js";
import {
  DkError,
  dkTransport,
  hasCap,
  openDigikitStore,
  storeSpace,
  type DkEntry,
  type DkInfoFull,
} from "@noiseandmatter/dnx-core/sample/digikitstore.js";
import {
  STORE_FOLDER,
  type StoreFile,
  type StoreFolder,
  type StoreListing,
  folderNameProblem,
  folderPath,
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
const OURS = ["samplepoolNote", "samplestoreBar", "samplestoreNote", "samplestoreGrid"] as const;

/** Controls that reach the instrument, off together while a session runs. */
const WHILE_BUSY = ["kind", "samplestoreRefresh", "samplestoreUp", "samplestoreVerify", "samplestoreMkdir", "samplestoreDelete"] as const;

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
  /** Another instrument answered: forget what the last one said. */
  reconnected(): Promise<void>;
}

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
  /** The folder on screen, relative to `samples/`. */
  let folder = "";
  /** The selected row's store path. */
  let picked: string | undefined;
  const hiddenBefore = new Map<string, boolean>();
  const titlesBefore = new Map<string, string>();
  const helpBefore = new Map<HTMLElement, string>();

  function listing(): StoreListing | undefined {
    return reading ? listFolder(reading.entries, folder) : undefined;
  }

  function pickedRow(): StoreFile | StoreFolder | undefined {
    const shownNow = listing();
    if (!shownNow || picked === undefined) return undefined;
    return [...shownNow.folders, ...shownNow.files].find((row) => row.path === picked);
  }

  const isFile = (row: StoreFile | StoreFolder): row is StoreFile => "sha256" in row;

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
    if (!on) controls();
  }

  /** Each control's own state, from what is on screen. */
  function controls(): void {
    if (busy) return;
    const connected = host.device() !== undefined;
    const row = pickedRow();
    $<HTMLButtonElement>("samplestoreRefresh").disabled = !connected;
    $<HTMLButtonElement>("samplestoreUp").disabled = !reading || folder === "";

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
        ? `Make a folder in ${folderPath(folder)}/.`
        : `digikit ${runtimeName(reading.info.runtime)} cannot make an empty folder.`;

    const remove = $<HTMLButtonElement>("samplestoreDelete");
    const empty = row !== undefined && !isFile(row) && row.files === 0 && row.entry;
    remove.disabled = !row || (!isFile(row) && !empty);
    remove.title = !row
      ? "Click a sample or an empty folder first."
      : isFile(row)
        ? `Delete ${row.name} from the instrument. No copy is kept.`
        : empty
          ? `Delete the empty folder ${row.name}.`
          : `${row.name} holds samples. Delete them first.`;
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

  function render(): void {
    if (!shown) return;
    $("samplepoolNote").hidden = false;
    $("samplestoreBar").hidden = false;
    $("samplestorePath").textContent = `${folderPath(folder)}/`;
    const grid = $("samplestoreGrid");
    controls();

    if (!host.device()) {
      heading("Sample pool", "", "Sample store", "— connect an instrument");
      note("<p><b>Connect an instrument.</b> The samples are read from its card store.</p>");
      grid.hidden = true;
      return;
    }
    if (!reading) {
      heading("Sample pool", "", "Sample store", problem ? "— not read" : "");
      note(problem ? `<p class="warn">${escapeHtml(problem)}</p>` : "");
      grid.hidden = true;
      return;
    }

    const shownNow = listFolder(reading.entries, folder);
    const count = shownNow.files.length;
    heading("Sample pool", "", "Sample store", `— ${count} ${count === 1 ? "sample" : "samples"} here`);
    note(
      `<p>Free: <b>${mib(reading.free)}</b>${reading.total === null ? "" : ` of ${mib(reading.total)}`}. ` +
        `digikit ${escapeHtml(runtimeName(reading.info.runtime))}.</p>` +
        (reading.info.safe_mode ? `<p class="warn">digikit is in safe mode.</p>` : ""),
    );
    grid.hidden = false;
    grid.innerHTML = "";

    const table = document.createElement("table");
    table.className = "libtable";
    table.innerHTML = "<thead><tr><th>Name</th><th>Size</th><th>sha256</th></tr></thead>";
    const body = document.createElement("tbody");

    for (const row of [...shownNow.folders, ...shownNow.files]) {
      const tr = document.createElement("tr");
      tr.className = isFile(row) ? "occupied" : "occupied folder";
      if (row.path === picked) {
        tr.classList.add("selected");
        tr.setAttribute("aria-selected", "true");
      }
      tr.innerHTML = isFile(row)
        ? `<td class="name">${escapeHtml(row.name)}</td><td class="n">${kib(row.size)}</td>` +
          `<td class="use"><code title="${row.sha256}">${row.sha256.slice(0, 12)}</code></td>`
        : `<td class="name">${escapeHtml(row.name)}/</td>` +
          `<td class="n">${row.files === 0 ? "empty" : `${row.files} ${row.files === 1 ? "sample" : "samples"}`}</td>` +
          `<td class="use"><span class="hint">folder</span></td>`;
      tr.addEventListener("click", () => {
        if (busy) return;
        picked = row.path;
        render();
      });
      if (!isFile(row)) {
        tr.title = "Double-click to open";
        tr.addEventListener("dblclick", () => {
          if (busy) return;
          open(row.path.slice(STORE_FOLDER.length + 1));
        });
      }
      body.append(tr);
    }
    if (body.childElementCount === 0) {
      body.innerHTML = `<tr class="free"><td class="name" colspan="3"><span class="hint">No samples in this folder.</span></td></tr>`;
    }
    table.append(body);
    grid.append(table);
  }

  function open(next: string): void {
    folder = next;
    picked = undefined;
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
    // A folder that went away (deleted, or emptied of its last file) is left for the nearest one that remains.
    while (folder !== "" && !entries.some((e) => e.path.startsWith(`${folderPath(folder)}/`) || e.path === folderPath(folder))) {
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

  async function makeFolder(): Promise<void> {
    if (!reading) return;
    const name = await askText({
      title: `New folder in ${folderPath(folder)}/`,
      body: ["Use letters, digits, spaces and ASCII punctuation."],
      confirmLabel: "Make the folder",
    });
    if (name === undefined) return;
    const why = folderNameProblem(folder, name);
    if (why) {
      host.status(why, "warn");
      return;
    }
    const inside = folder === "" ? name : `${folder}/${name}`;
    try {
      requireWriteEnabled();
      await withStore((store) => whileWriting(async () => {
        await store.samples.mkdir(inside);
        await read(store);
      }));
      open(inside);
      host.status(`Made ${folderPath(inside)}/.`, "ok");
    } catch (error) {
      host.status(`The folder was not made. ${messageOf(error)}`, "error");
    }
  }

  async function remove(): Promise<void> {
    const row = pickedRow();
    if (!row) return;
    const file = isFile(row);
    const ok = await askConfirm({
      title: file ? `Delete ${row.name}?` : `Delete the folder ${row.name}?`,
      body: file
        ? [
            `${row.path} is removed from the instrument's card store.`,
            "DNX keeps no copy. Keep your original file if you want this sample again.",
          ]
        : [`The empty folder ${row.path} is removed.`],
      confirmLabel: file ? "Delete the sample" : "Delete the folder",
      danger: true,
    });
    if (!ok) {
      host.status("Cancelled. Nothing was sent.", "warn");
      return;
    }
    try {
      requireWriteEnabled();
      const gone = await withStore((store) => whileWriting(async () => {
        await store.session.delete(row.path);
        await read(store);
        return !reading?.entries.some((e) => e.path === row.path);
      }));
      if (gone === undefined) return;
      picked = undefined;
      render();
      host.status(gone ? `Deleted ${row.path}.` : `${row.path} is still in the store.`, gone ? "ok" : "error");
    } catch (error) {
      host.status(`The delete failed. ${messageOf(error)}`, "error");
      render();
    }
  }

  $("samplestoreRefresh").addEventListener("click", () => void refresh());
  $("samplestoreUp").addEventListener("click", () => {
    if (folder !== "") open(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "");
  });
  $("samplestoreVerify").addEventListener("click", () => void verify());
  $("samplestoreMkdir").addEventListener("click", () => void makeFolder());
  $("samplestoreDelete").addEventListener("click", () => void remove());

  async function show(on: boolean): Promise<void> {
    if (on) {
      for (const id of SOUNDS_ONLY) {
        hiddenBefore.set(id, $(id).hidden);
        $(id).hidden = true;
      }
      for (const id of TITLES) titlesBefore.set(id, $(id).textContent ?? "");
      helpFor("leftTitle", "library/sample-pool");
      helpFor("libraryTitle", "library/sample-store");
      shown = true;
      render();
      await refresh();
      return;
    }
    for (const id of SOUNDS_ONLY) $(id).hidden = hiddenBefore.get(id) ?? false;
    for (const id of TITLES) $(id).textContent = titlesBefore.get(id) ?? "";
    for (const id of OURS) $(id).hidden = true;
    restoreHelp();
    shown = false;
  }

  async function reconnected(): Promise<void> {
    reading = undefined;
    problem = undefined;
    folder = "";
    picked = undefined;
    if (shown) await refresh();
  }

  return { show, refresh, reconnected };
}
