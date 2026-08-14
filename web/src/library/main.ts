/**
 * The library: a project's preset pool beside the instrument's +Drive library.
 *
 * ## Why these two things are on one page
 *
 * They are the two halves of one question. The manual is blunt about the difference — *"the primary
 * benefit of presets loaded to the pool is the possibility for them to be preset locked. This
 * feature is not available for the presets in the +Drive library"* — so the pool is where a preset
 * has to be for a trig to reach it, and the library is where 2,048 of them live.
 *
 * Every operation anyone wants here crosses that line: add a preset to the pool, keep one back,
 * load a kit into a pattern. **A tool showing one side could describe the work but never do it.**
 *
 * ## What it writes, and what it does not
 *
 * Dragging a preset from the library into the pool **edits the project held in this page**. The
 * instrument is not written to at all, and the file on disk is untouched until *Export project* is
 * pressed — so a mistake costs a reload, not a recording.
 *
 * That split is deliberate rather than temporary. Writing a *project* back to the +Drive is a
 * different operation from reading a preset out of it, and the two should not arrive together in a
 * page whose whole job is moving things between collections.
 *
 * `auditPool` reads Digitone II patterns, so a DN1 project is refused rather than shown with DN2
 * offsets over DN1 bytes.
 */

import { auditPool, describePoolAudit, type PoolAudit } from "../../../src/librarian/poolaudit.js";
import {
  BANKS,
  type LibraryBank,
  type LibraryKind,
  listLibraryBank,
  readLibraryObject,
} from "../../../src/device/library.js";
import {
  applyAddPreset,
  describeAddPreset,
  planAddPreset,
} from "../../../src/librarian/poolwrite.js";
import {
  applyLoadKit,
  describeLoadKit,
  planLoadKit,
  readPatternKitName,
} from "../../../src/librarian/kitwrite.js";
import { summariseTracks } from "../../../src/librarian/tracksummary.js";
import { patternName } from "../../../src/sheet/naming.js";
import { patternSlotView } from "../slotview.js";
import { buildProjectBlob, download } from "../project.js";
import { deviceFor } from "../../../src/librarian/device.js";
import { ProductId } from "../../../src/sysex/devices.js";
import { $, escapeHtml } from "../dom.js";
import { GridDrag, type GridDropHint, renderGrid, type SlotView } from "../grid.js";
import { statusBar } from "../statusbar.js";
import { askConfirm } from "../dialog.js";
import {
  type LibraryFilter,
  type LibraryRow,
  NO_FILTER,
  filterRows,
  toggleTag,
} from "./filter.js";
import { renderRows, renderTagChips, summarise } from "./librarytable.js";
import { readBankTags } from "./slottags.js";
import {
  type BankCache,
  type SlotFacts,
  cacheKey,
  forget,
  planBankRead,
  remember,
} from "./bankcache.js";
import { type TagName } from "../../../src/project/tags.js";
import { renderToolNav } from "../toolnav.js";
import { openProject, type LoadedProject } from "../project.js";
import {
  type ConnectedDevice,
  DeviceSourceError,
  apiTransport,
  connectDevice,
  listDeviceProjects,
  openDeviceProject,
} from "../devicesource.js";
import { type DriveProject } from "../../../src/device/drive.js";

const status = statusBar();
renderToolNav($("toolnav"), "library");

interface State {
  project?: LoadedProject;
  audit?: PoolAudit;
  device?: ConnectedDevice;
  bank?: LibraryBank;
  bankLetter: string;
  /** The rows behind the table, tags filled in as the reads land. */
  rows: LibraryRow[];
  filter: LibraryFilter;
  /**
   * Which tag read is current.
   *
   * Bumped **at the start of every browse**. A read in flight compares against it and stops when it
   * no longer matches — otherwise switching bank mid-read fills the new bank's rows with the old
   * bank's tags, silently and plausibly, because both are lists of real tag names.
   */
  tagRun: number;
  /**
   * The tag read in flight, so a new one can wait for it to let go of the device.
   *
   * **Two conversations must not share one instrument.** `apiTransport` builds a fresh `DeviceLink`
   * per call, each with its own in-flight table and its own message ids from 1, and both listen to
   * the same MIDI input — so a listing issued while a tag read is running sees the read's replies
   * and matches one by id. Observed on hardware while switching bank mid-load:
   *
   *     expected 0xd3 to a listing and got 0xd4
   *
   * `0xd3` is the directory reply and `0xd4` is a file open's. The listing was handed the tag
   * reader's answer. The probe learned this in 2026-08 and wrote it down — *"two presses produced
   * two sessions numbering their messages from 1, on a transport with a single reply slot, so each
   * stole the other's answers"* — and the library reproduced it because a bank switch is a second
   * press by another name.
   */
  reading?: Promise<unknown>;
}

const state: State = { bankLetter: "A", rows: [], filter: { ...NO_FILTER }, tagRun: 0 };

/**
 * What each bank turned out to hold, for as long as the page is open.
 *
 * Deliberately **not** persisted beyond the session. It is a cache of what an instrument had in it
 * a moment ago, and an instrument that was unplugged and edited in between is exactly the case a
 * stored copy would get wrong with the most confidence. `bankcache.ts` explains what invalidates it.
 */
const banks: BankCache = new Map();

/**
 * Which kit went into which pattern, this session.
 *
 * **A kit load is otherwise untraceable.** It replaces sixteen presets and changes nothing a
 * pattern cell displayed, so once the confirmation was dismissed there was no way to tell which
 * patterns had been touched — the grid, correctly, looked exactly as it had.
 *
 * Cleared when another project is opened, because it describes edits to *that* image and would
 * otherwise claim a fresh project had kits loaded into it.
 */
const applied = new Map<number, string>();

/** The +Drive listing, so Open can resolve the chosen slot without listing again. */
let driveProjects: DriveProject[] = [];

// --- the pool ------------------------------------------------------------------------------------

async function loadProject(file: File): Promise<void> {
  status(`Reading ${file.name}…`);
  adopt(await openProject(file), file.name);
}

/**
 * Take a project as the one being edited, wherever it came from.
 *
 * **Extracted when the +Drive became a second source.** A file and a stored slot arrive by very
 * different routes — a picker and a 12.9 MB read — and converge here, so the family check, the
 * audit, the cleared history and the rendering happen once. Two copies of this would be two answers
 * to "is this project usable", and the one that drifted would be the one nobody was looking at.
 */
function adopt(loaded: LoadedProject, label: string): void {
  const device = deviceFor(loaded.image);

  // Refused rather than shown wrongly: the audit walks Digitone II patterns, and DN2 offsets over
  // DN1 bytes would produce names and counts that are all invented.
  if (device.kind !== "dn2") {
    throw new DeviceSourceError(
      `${label} is a ${device.name} project. The pool audit reads Digitone II patterns; the ` +
        `Digitone 1's preset locks are read elsewhere and are not joined up yet.`,
    );
  }

  state.project = loaded;
  state.audit = auditPool(loaded.image, device);
  // This described edits to the previous image. Kept, it would claim a freshly opened project had
  // kits loaded into patterns nobody has touched.
  applied.clear();
  $("poolInfo").hidden = false;
  $("poolInfo").textContent = label;
  renderDestination();
  status(`${label} open. ${describePoolAudit(state.audit)[0]}`, "ok");
}

function poolSlotView(index: number): Omit<SlotView, "index"> {
  const slot = state.audit!.slots[index]!;
  return {
    id: String(index),
    name: slot.occupied ? slot.name || "—" : "—",
    ...(slot.machine === undefined ? {} : { machine: slot.machine }),
    // **The lock count is the point.** A preset in the pool that nothing locks is occupying one of
    // 128 places for no reason, and that is invisible on the instrument.
    detail: !slot.occupied
      ? "free"
      : slot.lockCount === 0
        ? "no locks"
        : `${slot.lockCount} lock(s) · ${slot.patterns.length} pattern(s)`,
    occupied: slot.occupied,
    supported: true,
    ...(slot.occupied && slot.lockCount === 0 ? { classes: ["unused"] } : {}),
  };
}

/**
 * Show whichever destination the current library selection can actually be dropped on.
 *
 * A preset goes into the pool and a kit goes into a pattern. Leaving the pool on screen while
 * kits are being browsed would offer a drop that has no meaning, and the hint would have to spend
 * its one line explaining why nothing happens.
 */
function renderDestination(): void {
  if (!state.project) return;
  if (kind() === "kit") renderPatterns();
  else renderPool();
}

function renderPatterns(): void {
  const project = state.project;
  if (!project) return;
  const device = deviceFor(project.image);

  $("poolGrid").hidden = true;
  $("patternGrid").hidden = false;
  $("leftTitle").textContent = "Patterns";
  $("poolSub").textContent = "— a kit goes into a pattern; a pattern owns exactly one";

  renderGrid(
    $("patternGrid"),
    Array.from({ length: 128 }, (_, index) => {
      const view = patternSlotView(device, project.image, index);
      // **The kit name replaces the trig count, on this grid only.**
      //
      // `patternSlotView` reports what a pattern *is* — its name and how many trigs it holds — and
      // that is the right summary in the manager, where patterns are being moved about. Here the
      // question is which sixteen presets a pattern is wearing, because that is what a drop changes
      // and what was invisible: a kit load rewrites all sixteen and touches nothing the standard
      // cell displays, so the grid correctly showed an unchanged pattern over a replaced kit.
      //
      // Overridden here rather than added to the shared view, so the manager's cells are untouched.
      // **Shown whenever there is a name, not only on occupied patterns.** Gating it on occupancy
      // was the first version and it hid the case that matters most: a kit dropped onto an *empty*
      // pattern leaves it still empty — a kit is the sound, not the sequence — so the cell would
      // have gone on saying "empty" with sixteen presets freshly loaded into it.
      //
      // Falling back to the standard detail rather than printing "kit unnamed" everywhere: the
      // device names a kit lazily, so a blank is the normal state of a project nobody has edited,
      // and 128 cells announcing it would bury the ones that have something to say.
      const kit = readPatternKitName(project.image, device, index);
      const marks = [...(view.classes ?? []), ...(applied.has(index) ? ["justApplied"] : [])];
      return {
        index,
        ...view,
        ...(kit ? { detail: `kit ${kit}` } : {}),
        ...(marks.length > 0 ? { classes: marks } : {}),
      };
    }),
    {
      selected: [],
      onClick: (index) => describePattern(index),
      drag: { controller: drag, grid: "patterns" },
    },
  );

  renderApplied();
}

/**
 * What has been loaded where, this session.
 *
 * The per-track findings from a drop are worth reading once and gone by the next click. **Which kit
 * went into which pattern is worth keeping**, because it is the only record that this project now
 * differs from the file it came from — nothing else on the page says so until the export.
 *
 * A poor relation of real undo history, which is queued. This is deliberately just a list: it says
 * what happened, and makes no offer to reverse it.
 */
function renderApplied(): void {
  if (applied.size === 0) {
    $("findings").innerHTML =
      `<p class="none">Drop a kit on a pattern to see what it would change, track by track. ` +
      `The trigs stay where they are — a kit is the sound, not the sequence.</p>`;
    return;
  }

  const lines = [...applied.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pattern, what]) => `<li>${escapeHtml(`${patternName(pattern)} ← ${what}`)}</li>`)
    .join("");
  $("findings").innerHTML =
    `<p class="none">Loaded this session — nothing reaches disk until <b>Export project</b>:</p>` +
    `<ul class="applied">${lines}</ul>`;
}

function describePattern(index: number): void {
  const project = state.project;
  if (!project) return;
  const tracks = summariseTracks(project.image, index).filter((t) => !t.empty);
  status(
    tracks.length === 0
      ? `${patternName(index)} is empty.`
      : `${patternName(index)}: ${tracks.length} track(s) — ` +
        tracks.map((t) => `${t.label} ${t.presetName || "unnamed"}`).join(", "),
  );
}

function renderPool(): void {
  const audit = state.audit;
  if (!audit) return;
  const grid = $("poolGrid");
  $("patternGrid").hidden = true;
  grid.hidden = false;
  $("leftTitle").textContent = "Preset pool";

  const occupied = audit.slots.filter((s) => s.occupied).length;
  $("poolSub").textContent = `— ${occupied} of ${audit.slots.length} used, ${audit.free.length} free`;

  renderGrid(
    grid,
    audit.slots.map((s) => ({ index: s.index, ...poolSlotView(s.index) })),
    {
      selected: [],
      onClick: (index) => describeSlot(index),
      drag: { controller: drag, grid: "pool" },
    },
  );

  const lines = describePoolAudit(audit).slice(1);
  $("findings").innerHTML = lines.length
    ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
    : `<p class="none">Nothing to report — every preset is locked to, and none is duplicated.</p>`;
}

function describeSlot(index: number): void {
  const slot = state.audit!.slots[index]!;
  if (!slot.occupied) {
    status(`Slot ${index} is free.`);
    return;
  }
  status(
    `Slot ${index}: ${slot.name || "unnamed"} · ${slot.machine ?? "unknown machine"} · ` +
      (slot.lockCount === 0
        ? "nothing locks it"
        : `${slot.lockCount} trig(s) across pattern(s) ${slot.patterns.join(", ")}`),
  );
}

/**
 * List the projects stored on the instrument.
 *
 * One message, and it is the cheap half. Reading one of them is 12.9 MB.
 */
async function browseDriveProjects(): Promise<void> {
  const device = state.device;
  if (!device) throw new DeviceSourceError("connect a Digitone II first");

  status(`Listing the +Drive on ${device.name}…`);
  driveProjects = await listDeviceProjects(device);

  const select = $<HTMLSelectElement>("driveProjects");
  select.replaceChildren(
    ...driveProjects.map((p) => {
      const option = document.createElement("option");
      option.value = String(p.index);
      // Slot number first: it is what addresses the project and what the instrument's own screen
      // shows. A name alone is ambiguous — a +Drive can hold two projects called NEW PROJECT.
      option.textContent = `${p.index}. ${p.name}`;
      return option;
    }),
  );
  select.hidden = false;
  $("driveOpen").hidden = false;
  status(`${driveProjects.length} project(s) on the +Drive. Choose one and press Open.`, "ok");
}

/**
 * Read one stored project and edit it here.
 *
 * **The long one.** A Digitone II project is 12,889,647 bytes — some 6,294 chunks — so this reports
 * progress and cannot be allowed to overlap anything else talking to the instrument.
 *
 * Abandoning the bank's tag read to do it is the right trade rather than a regrettable one: opening
 * a project is a deliberate foreground action, the bank is cached, and revisiting it costs a listing
 * rather than another 256 reads.
 */
async function openDriveProject(): Promise<void> {
  const device = state.device;
  if (!device) throw new DeviceSourceError("connect a Digitone II first");

  const index = Number($<HTMLSelectElement>("driveProjects").value);
  const project = driveProjects.find((p) => p.index === index);
  if (!project) {
    status("That slot is no longer in the listing. Browse again.", "warn");
    return;
  }

  // Same discipline as `browse`, and for the same reason: two conversations must not share one
  // instrument. See the note on `State.reading` — a listing issued over a running read was handed
  // that read's reply, and a 12.9 MB read is the worst possible thing to have racing.
  state.tagRun++;
  const outstanding = state.reading;
  if (outstanding) {
    status("Finishing the read in progress…");
    await outstanding.catch(() => undefined);
  }

  status(`Reading ${project.name} from slot ${project.index}…`);
  const opened = await openDeviceProject(device, project, (chunks, bytes) => {
    if (chunks % 64 === 0) {
      status(`Reading ${project.name}: ${bytes.toLocaleString()} bytes…`);
    }
  });

  // **No manifest, no project.** The +Drive sends no `manifest.json`; it is rebuilt from the payload
  // and the device's firmware string, and without that string there is no honest one. Refusing is
  // better than opening something that cannot be exported — export is this tool's only way out.
  if (!opened.manifest) {
    throw new DeviceSourceError(
      `${project.name} was read, but the instrument did not report its firmware, so the project ` +
        `file cannot be rebuilt honestly. Nothing was opened — this tool's only output is an ` +
        `exported file, and one without a manifest would not load.`,
    );
  }

  adopt(
    {
      fileName: `${project.name}.dn2prj`,
      manifest: opened.manifest,
      payload: opened.payload,
      image: opened.image,
    },
    `${project.name} · slot ${project.index}`,
  );
  $<HTMLButtonElement>("export").disabled = false;
}

// --- the library ---------------------------------------------------------------------------------

async function connect(): Promise<void> {
  status("Looking for a Digitone II…");
  state.device = await connectDevice({ want: ProductId.DN2 });
  $("deviceInfo").hidden = false;
  $("deviceInfo").textContent = state.device.name;
  $<HTMLSelectElement>("kind").disabled = false;
  $<HTMLButtonElement>("browse").disabled = false;
  $<HTMLButtonElement>("driveBrowse").disabled = false;
  status(`${state.device.name} connected. Choose presets or kits, then Browse.`, "ok");
}

function kind(): LibraryKind {
  return $<HTMLSelectElement>("kind").value === "kit" ? "kit" : "preset";
}

async function browse(options: { force?: boolean } = {}): Promise<void> {
  const device = state.device;
  if (!device) throw new DeviceSourceError("connect a Digitone II first");

  // **Stop the previous read before saying a word to the device.** Bumping the run makes the loop
  // exit before its next request, and awaiting the promise waits for the one already in flight to
  // land — a single round trip, so this is milliseconds, not the rest of the bank.
  //
  // Both halves are needed. Without the bump the old loop never stops; without the wait, its last
  // request is still outstanding when the listing goes out, which is the case that crossed replies.
  state.tagRun++;
  const outstanding = state.reading;
  if (outstanding) {
    status("Finishing the read in progress…");
    // Never rejects — `loadTags` catches — but awaited defensively: a throw here would leave the
    // page unable to browse again, which is a worse failure than the one being prevented.
    await outstanding.catch(() => undefined);
  }

  status(`Listing ${kind()}s in bank ${state.bankLetter}…`);
  // **Always re-listed, never cached.** One message, and the only thing that can tell us whether
  // anything changed — which is what decides how many *bodies* have to be read. `bankcache.ts` has
  // the asymmetry: 1 round trip to list, 256 to read.
  const bank = await listLibraryBank(apiTransport(device), kind(), state.bankLetter);
  state.bank = bank;

  const plan = planBankRead(
    banks.get(cacheKey(kind(), bank.bank)),
    bank,
    options.force === undefined ? {} : { force: options.force },
  );

  // Rows first, from the listing alone — everything except tags and machine is already here, and
  // the table appears at once rather than after a bank's worth of round trips. Anything the cache
  // still vouches for arrives already filled in, so a revisited bank never blinks back to
  // "reading…" for rows nothing has happened to.
  state.rows = bank.entries.map((e) => {
    const known = plan.reuse.get(e.index);
    return {
      index: e.index,
      name: e.name,
      occupied: e.occupied,
      writable: e.writable,
      size: e.size,
      ...(known ? { tags: known.tags, machine: known.machine } : {}),
    };
  });

  renderLibrary();
  renderDestination();

  if (plan.toRead.length === 0) {
    status(
      `Bank ${bank.bank}: ${bank.used} of ${bank.entries.length} ${kind()}(s), unchanged — ` +
        `nothing to read again.`,
      "ok",
    );
    return;
  }

  status(
    `Bank ${bank.bank}: ${bank.used} of ${bank.entries.length} ${kind()}(s). ` +
      `Reading ${plan.toRead.length} slot(s)…`,
    "ok",
  );

  // Not awaited. See `loadTags`.
  loadTags(bank, plan.toRead, plan.reuse);
}

function renderLibrary(): void {
  const bank = state.bank;
  if (!bank) return;

  const tabs = $("libraryTabs");
  tabs.hidden = false;
  tabs.innerHTML = "";
  for (const letter of BANKS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(letter === bank.bank));
    // No count on the other tabs: we have not listed them, and a blank is honest where a zero
    // would be a claim.
    button.innerHTML = `${letter}${letter === bank.bank ? `<span class="n">${bank.used}</span>` : ""}`;
    button.addEventListener("click", () => {
      state.bankLetter = letter;
      browse().catch(report);
    });
    tabs.append(button);
  }

  $("libraryFind").hidden = false;
  $("libraryTags").hidden = false;
  $("libraryGrid").hidden = false;
  $("librarySub").textContent = `— ${bank.path}, ${bank.used} of ${bank.entries.length} used`;

  renderTable();
}

/**
 * Draw the table from the current rows and filter.
 *
 * Called on every keystroke and every arriving tag, so it does the least it can: filtering is a
 * single pass over at most 256 rows, and rebuilding the table is a few hundred short cells. Nothing
 * here is worth memoising and a stale row is worse than a repaint.
 */
function renderTable(): void {
  const bank = state.bank;
  if (!bank) return;

  const result = filterRows(state.rows, state.filter);
  const filtered =
    state.filter.query !== "" || state.filter.tags.length > 0 || state.filter.occupiedOnly;

  renderRows($("libraryGrid"), result, {
    drag,
    onToggleTag: (tag) => toggleTagAndRender(tag),
    onSelect: (index) => {
      const row = state.rows.find((r) => r.index === index);
      status(
        row
          ? `${bank.path}/${index} — ${row.name || "unnamed"}, ${row.size.toLocaleString()} bytes` +
              (row.tags?.length ? ` · ${row.tags.join(" ")}` : "")
          : `${bank.path}/${index}`,
      );
    },
  });

  renderTagChips($("libraryTags"), state.rows, state.filter, toggleTagAndRender);
  $("librarySub").textContent =
    `— ${bank.path}, ${summarise(result, state.rows.length, filtered)}`;
}

function toggleTagAndRender(tag: TagName): void {
  state.filter = { ...state.filter, tags: toggleTag(state.filter.tags, tag) };
  renderTable();
}

/**
 * At most one repaint per frame.
 *
 * Tags arrive one slot at a time and each one used to redraw the whole table. For a bank that is
 * 256 rebuilds of 256 rows — about 65,000 rows of DOM inside six seconds — and the main thread had
 * no time left to answer a click. **The page was not blocked on the device; it was blocked on
 * itself**, which is worth stating because it looked exactly like a protocol limitation.
 *
 * `requestAnimationFrame` rather than a timer: the work is painting, so the browser already knows
 * when it is worth doing, and a hidden tab correctly stops doing it at all.
 */
let paintQueued = false;
function schedulePaint(): void {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    renderTable();
  });
}

/**
 * Read every occupied slot's tags, filling the table as they land.
 *
 * Started after the table is already on screen and deliberately not awaited by `browse` — a bank of
 * 256 is seconds of round trips, and nobody should wait for a tag column to read a name.
 */
function loadTags(bank: LibraryBank, indices: readonly number[], reused: Map<number, SlotFacts>): void {
  const device = state.device;
  if (!device) return;
  if (indices.length === 0) return;

  // **Read, not bumped.** `browse` already advanced the run before it spoke to the device, and
  // bumping again here would abandon this read the moment it started.
  const run = state.tagRun;
  const collection = kind();
  // Starts from what the cache vouched for, so a partial re-read still stores the whole bank —
  // otherwise reading one changed slot would forget the 255 that did not change, and the visit
  // after this one would read everything again.
  const learned = new Map(reused);

  const running = readBankTags({
    transport: apiTransport(device),
    kind: collection,
    bank: bank.bank,
    indices,
    keepGoing: () => state.tagRun === run,
    onSlot: ({ index, tags, machine }) => {
      const row = state.rows.find((r) => r.index === index);
      if (!row) return;
      row.tags = tags;
      row.machine = machine;
      learned.set(index, { tags, machine });
      // **Coalesced to one repaint a frame.** Painting on every slot rebuilt a 256-row table 256
      // times over a bank — some 65,000 rows of DOM in six seconds, which is what made the page
      // feel frozen while it was working perfectly.
      schedulePaint();
    },
  });

  // Published before anything is awaited, so the next `browse` can wait for the device to be free.
  state.reading = running;

  running
    .then(({ read, failed }) => {
      // **Only a run that finished as the current one may store anything.** An abandoned run holds
      // a `learned` map for a bank nobody is looking at, and writing it under the *current* key is
      // how a preset bank's tags would end up cached as a kit bank's.
      if (state.tagRun !== run) return;

      state.reading = undefined;

      // **The last paint is not scheduled, it is done.** `requestAnimationFrame` does not fire in a
      // hidden tab, so a bank that finished loading in the background stayed showing "reading…" on
      // all 256 rows — measured, with the read demonstrably complete. It would have caught up on
      // becoming visible, which is exactly the kind of self-healing nobody should have to rely on:
      // the terminal state of a run has to be painted by the run.
      renderTable();
      remember(banks, collection, bank, learned);
      status(
        failed === 0
          ? `${bank.path}: tags read for ${read} slot(s).`
          : `${bank.path}: tags read for ${read} slot(s); ${failed} could not be read.`,
        failed === 0 ? "ok" : "warn",
      );
    })
    .catch(report);
}

/**
 * Dragging a preset out of the library and into the pool.
 *
 * **One direction only, for now.** Library → pool is what the device calls *ADD TO PRESET POOL*, and
 * it is the operation that makes a preset lockable. Pool → library is a genuine operation too, but
 * it writes to the instrument, and nothing here writes to the instrument yet.
 *
 * The drop lands the preset in the slot it was dropped on — not "the first free slot" — because the
 * gesture chose a place and quietly using a different one would be the tool disagreeing with the
 * hand that made it.
 */
const drag = new GridDrag({
  onDragStart(grid, index) {
    // Only occupied library slots are worth dragging; an empty one has nothing to give.
    if (grid !== "library") return [];
    const entry = state.bank?.entries.find((e) => e.index === index);
    return entry?.occupied ? [index] : [];
  },

  hintFor(from, grid, index) {
    if (from.grid !== "library") return undefined;

    if (grid === "patterns" && state.bank?.kind === "kit") return kitHint(from.indices[0], index);
    if (grid !== "pool" || !state.audit || state.bank?.kind !== "preset") return undefined;

    const slot = state.audit.slots[index];
    if (!slot) return undefined;
    return {
      action: "copy",
      label: slot.occupied ? `REPLACE${slot.lockCount ? ` · ${slot.lockCount} locks` : ""}` : "ADD",
      status: slot.occupied
        ? `${slot.name || "unnamed"} is in slot ${index}` +
          (slot.lockCount ? ` and ${slot.lockCount} trig(s) lock it` : ", locked by nothing")
        : `slot ${index} is free`,
    };
  },

  onDrop(from, grid, index) {
    if (from.grid !== "library") return;
    const source = from.indices[0];
    if (source === undefined) return;
    if (grid === "pool") addToPool(source, index).catch(report);
    if (grid === "patterns") loadKit(source, index).catch(report);
  },

  onStatus: (message) => {
    if (message) status(message);
  },
});

/**
 * What dropping a kit on this pattern would cost, in the one line a hover has room for.
 *
 * Deliberately **not** a preview of the change: that needs the kit's bytes, which means reading
 * 10,795 of them off the instrument, and doing that on hover would fire a read for every pattern
 * the pointer crosses. So the hint says what is *there* — the thing that would be replaced — and
 * the per-track before/after arrives on the drop, before anything is written.
 */
function kitHint(source: number | undefined, index: number): GridDropHint | undefined {
  const project = state.project;
  if (source === undefined || !project) return undefined;
  const tracks = summariseTracks(project.image, index).filter((t) => !t.empty);
  const trigs = tracks.reduce((n, t) => n + t.trigCount, 0);

  return {
    action: "copy",
    label: tracks.length === 0 ? "EMPTY" : `LOAD KIT · ${tracks.length} tracks`,
    status:
      tracks.length === 0
        ? `${patternName(index)} is empty — a kit there changes nothing you can hear`
        : `${patternName(index)} plays ${trigs} trig(s) on ${tracks.length} track(s). ` +
          `The trigs stay; what they play is replaced.`,
  };
}

/**
 * Read one kit off the instrument and load it into a pattern.
 *
 * **Always asks**, unlike a preset going into a free pool slot. There is no such thing as an empty
 * kit to drop onto — a pattern always has one — so every drop replaces sixteen presets, and the
 * per-track before/after is the whole reason this is safe to offer at all.
 */
async function loadKit(index: number, pattern: number): Promise<void> {
  const { device, bank, project } = state;
  if (!device || !bank || !project) return;

  status(`Reading ${bank.path}/${index}…`);
  // `object`, not `body` — a stored body can carry a prefix in front of the object, and what goes
  // into a pattern's kit record is the object. See `objectInStoredBody`.
  const { object: body } = await readLibraryObject(apiTransport(device), "kit", bank.bank, index);

  const projectDevice = deviceFor(project.image);
  const preview = planLoadKit(project.image, projectDevice, body, { pattern });
  const lines = describeLoadKit(preview);

  if (preview.changedTracks.length === 0) {
    status(lines[0]!, "warn");
    return;
  }
  // The per-track before/after is the whole reason this is safe to offer, and `confirm` could only
  // show it as one paragraph with newlines in it. As a list it is what it always was: sixteen
  // findings to scan, of which two or three are the ones that matter.
  const [summary, ...findings] = lines;
  if (
    !(await askConfirm({
      title: `Load kit ${bank.bank}${index} into ${patternName(pattern)}?`,
      body: summary === undefined ? [] : [summary],
      list: findings,
      confirmLabel: "Load kit",
      danger: true,
    }))
  ) {
    status("Not loaded.");
    return;
  }

  const { image, plan } = applyLoadKit(project.image, projectDevice, body, { pattern });
  state.project = { ...project, image };
  state.audit = auditPool(image, projectDevice);

  // Recorded before the render, so the cell can mark itself and the list can name it. The kit's own
  // name is preferred over the slot's — they usually agree, but the kit record is what the pattern
  // now carries and the listing entry is only where it came from.
  applied.set(
    pattern,
    `${plan.name || bank.entries.find((e) => e.index === index)?.name || "an unnamed kit"} ` +
      `(${bank.bank}${index}), ${plan.changedTracks.length} track(s) changed`,
  );

  renderPatterns();
  status(
    `${plan.name || bank.entries.find((e) => e.index === index)?.name || "kit"} → ` +
      `${patternName(pattern)}. ${plan.changedTracks.length} track(s) changed. ` +
      `Export the project to keep this — nothing has been written to the instrument.`,
    "ok",
  );
  $<HTMLButtonElement>("export").disabled = false;
}

/**
 * Read one preset off the instrument and put it in the pool.
 *
 * Reads on every drop rather than caching the bank's bytes. A listing is names and sizes; the object
 * itself is a separate conversation, and 2,048 presets is not something to fetch speculatively.
 */
async function addToPool(index: number, slot: number): Promise<void> {
  const { device, bank, project } = state;
  if (!device || !bank || !project || !state.audit) return;
  if (bank.kind !== "preset") {
    status("Kits go into a pattern, not the pool — that operation is not built yet.", "warn");
    return;
  }

  const entry = bank.entries.find((e) => e.index === index);
  status(`Reading ${bank.path}/${index}…`);
  // **This is the line the drag was failing on.** A DN2 preset's stored body is 364 bytes and a
  // pool slot is 359, so `poolwrite` refused it — correctly, since writing 364 would have run into
  // the neighbouring slot. The five extra are a prefix; `object` is what belongs in the pool.
  const { object: body } = await readLibraryObject(apiTransport(device), "preset", bank.bank, index);

  const projectDevice = deviceFor(project.image);
  // Planned before anything is written, so a refusal — a MIDI preset, an occupied slot with locks —
  // is something you read rather than something you undo.
  const preview = planAddPreset(project.image, projectDevice, body, { slot });
  if (preview.replaces) {
    const replaced = preview.replaces;
    const ok = await askConfirm({
      title: `Replace ${replaced.name || "the preset"} in pool slot ${preview.slot}?`,
      body: [
        describeAddPreset(preview),
        // Said separately because it is the consequence, not the description. A slot with locks is
        // not merely occupied — it is in use, and replacing it changes what those trigs play.
        ...(replaced.lockCount > 0
          ? [
              `${replaced.lockCount} trig${replaced.lockCount === 1 ? "" : "s"} lock to that ` +
                `slot and will play the new preset instead.`,
            ]
          : []),
      ],
      confirmLabel: "Replace it",
      danger: true,
    });
    if (!ok) {
      status("Not added.");
      return;
    }
  }

  const { image, plan } = applyAddPreset(project.image, projectDevice, body, {
    slot,
    confirmOverwrite: true,
  });
  state.project = { ...project, image };
  state.audit = auditPool(image, projectDevice);
  renderPool();
  // Named when it happened. A Digitone 1 preset in a Digitone II pool is a very good likeness
  // rather than the same object, and that is worth one clause of a sentence.
  const converted = plan.converted ? `Converted from a ${plan.converted.from} preset. ` : "";
  status(
    `${converted}${entry?.name || "preset"} → slot ${plan.slot}. ${plan.freeAfter} free. ` +
      `Export the project to keep this — nothing has been written to the instrument.`,
    "ok",
  );
  $<HTMLButtonElement>("export").disabled = false;
}

async function exportProject(): Promise<void> {
  const project = state.project;
  if (!project) return;
  const blob = await buildProjectBlob(project, project.image);
  download(blob, project.fileName);
  status(`Exported ${project.fileName}. The original file is untouched.`, "ok");
}

function report(error: unknown): void {
  status(error instanceof Error ? error.message : String(error), "error");
}

// --- wiring --------------------------------------------------------------------------------------

$<HTMLInputElement>("projectFile").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) loadProject(file).catch(report);
});

$("driveBrowse").addEventListener("click", () => {
  browseDriveProjects().catch(report);
});

$("driveOpen").addEventListener("click", () => {
  openDriveProject().catch(report);
});

$("connect").addEventListener("click", () => {
  connect().catch(report);
});

$("browse").addEventListener("click", () => {
  browse().catch(report);
});

$("export").addEventListener("click", () => {
  exportProject().catch(report);
});

$("kind").addEventListener("change", () => {
  // The two collections are different sizes and different objects, so a listing of one says nothing
  // about the other. Clearing is more honest than leaving the previous table under a new heading.
  //
  // **Bumping `tagRun` is what stops the reads.** Without it, a run started for a bank of presets
  // keeps landing rows into a table now showing kits — and because the tag vocabulary is closed,
  // every one of them would look like a real answer.
  state.tagRun++;
  state.bank = undefined;
  state.rows = [];
  $("libraryGrid").hidden = true;
  $("libraryTabs").hidden = true;
  $("libraryFind").hidden = true;
  $("libraryTags").hidden = true;
  $("librarySub").textContent = `— press Browse to list ${kind()}s`;
});

// --- finding one of 256 --------------------------------------------------------------------------

$<HTMLInputElement>("librarySearch").addEventListener("input", (event) => {
  // No debounce. Filtering is one pass over at most 256 rows and the table is a few hundred short
  // cells; a delay here would be a delay somebody can feel, added to hide work that costs nothing.
  state.filter = { ...state.filter, query: (event.target as HTMLInputElement).value };
  renderTable();
});

$<HTMLInputElement>("libraryOccupied").addEventListener("change", (event) => {
  state.filter = { ...state.filter, occupiedOnly: (event.target as HTMLInputElement).checked };
  renderTable();
});

$("libraryRefresh").addEventListener("click", () => {
  // Drops only the bank on screen. A refresh of one is not a refresh of all of them — the other
  // seven are no more suspect than they were a moment ago.
  const bank = state.bank;
  if (!bank) return;
  forget(banks, kind(), bank.bank);
  browse({ force: true }).catch(report);
});

$("libraryClear").addEventListener("click", () => {
  state.filter = { ...NO_FILTER };
  $<HTMLInputElement>("librarySearch").value = "";
  $<HTMLInputElement>("libraryOccupied").checked = false;
  renderTable();
});
