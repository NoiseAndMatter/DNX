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
 * ## Read-only, and honestly so
 *
 * Nothing here writes. Writing to the +Drive needs a checksum the device validates; the algorithm is
 * solved and reproduces the instrument's own numbers, but **the device has not yet accepted one we
 * computed for bytes it has never seen** — one hardware check, T26. Until it passes, offering a
 * button that saves would be offering something that may not work.
 *
 * The pool side has a second reason to wait: `auditPool` reads Digitone II patterns, so a DN1's pool
 * is not shown at all rather than shown wrongly.
 */

import { auditPool, describePoolAudit, type PoolAudit } from "../../../src/librarian/poolaudit.js";
import {
  BANKS,
  type LibraryBank,
  type LibraryKind,
  listLibraryBank,
} from "../../../src/device/library.js";
import { deviceFor } from "../../../src/librarian/device.js";
import { ProductId } from "../../../src/sysex/devices.js";
import { $, escapeHtml } from "../dom.js";
import { renderGrid, type SlotView } from "../grid.js";
import { statusBar } from "../statusbar.js";
import { renderToolNav } from "../toolnav.js";
import { openProject, type LoadedProject } from "../project.js";
import {
  type ConnectedDevice,
  DeviceSourceError,
  apiTransport,
  connectDevice,
} from "../devicesource.js";

const status = statusBar();
renderToolNav($("toolnav"), "library");

interface State {
  project?: LoadedProject;
  audit?: PoolAudit;
  device?: ConnectedDevice;
  bank?: LibraryBank;
  bankLetter: string;
}

const state: State = { bankLetter: "A" };

// --- the pool ------------------------------------------------------------------------------------

async function loadProject(file: File): Promise<void> {
  status(`Reading ${file.name}…`);
  const loaded = await openProject(file);
  const device = deviceFor(loaded.image);

  // Refused rather than shown wrongly: the audit walks Digitone II patterns, and DN2 offsets over
  // DN1 bytes would produce names and counts that are all invented.
  if (device.kind !== "dn2") {
    throw new DeviceSourceError(
      `${file.name} is a ${device.name} project. The pool audit reads Digitone II patterns; the ` +
        `Digitone 1's preset locks are read elsewhere and are not joined up yet.`,
    );
  }

  state.project = loaded;
  state.audit = auditPool(loaded.image, device);
  $("poolInfo").hidden = false;
  $("poolInfo").textContent = file.name;
  renderPool();
  status(`${file.name} open. ${describePoolAudit(state.audit)[0]}`, "ok");
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

function renderPool(): void {
  const audit = state.audit;
  if (!audit) return;
  const grid = $("poolGrid");
  grid.hidden = false;

  const occupied = audit.slots.filter((s) => s.occupied).length;
  $("poolSub").textContent = `— ${occupied} of ${audit.slots.length} used, ${audit.free.length} free`;

  renderGrid(
    grid,
    audit.slots.map((s) => ({ index: s.index, ...poolSlotView(s.index) })),
    { selected: [], onClick: (index) => describeSlot(index) },
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

// --- the library ---------------------------------------------------------------------------------

async function connect(): Promise<void> {
  status("Looking for a Digitone II…");
  state.device = await connectDevice({ want: ProductId.DN2 });
  $("deviceInfo").hidden = false;
  $("deviceInfo").textContent = state.device.name;
  $<HTMLSelectElement>("kind").disabled = false;
  $<HTMLButtonElement>("browse").disabled = false;
  status(`${state.device.name} connected. Choose presets or kits, then Browse.`, "ok");
}

function kind(): LibraryKind {
  return $<HTMLSelectElement>("kind").value === "kit" ? "kit" : "preset";
}

async function browse(): Promise<void> {
  const device = state.device;
  if (!device) throw new DeviceSourceError("connect a Digitone II first");

  status(`Listing ${kind()}s in bank ${state.bankLetter}…`);
  state.bank = await listLibraryBank(apiTransport(device), kind(), state.bankLetter);
  renderLibrary();
  status(
    `Bank ${state.bank.bank}: ${state.bank.used} of ${state.bank.entries.length} ${kind()}(s).`,
    "ok",
  );
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

  const grid = $("libraryGrid");
  grid.hidden = false;
  $("librarySub").textContent = `— ${bank.path}, ${bank.used} of ${bank.entries.length} used`;

  renderGrid(
    grid,
    bank.entries.map((e) => ({
      index: e.index,
      id: String(e.index),
      name: e.occupied ? e.name || "—" : "—",
      // The instrument protects saved work, so an occupied slot reads as not writable. Worth
      // showing, because it is what a future save would run into.
      detail: e.occupied ? (e.writable ? "saved" : "saved · protected") : "free",
      occupied: e.occupied,
      supported: true,
    })),
    {
      selected: [],
      onClick: (index) => {
        const entry = bank.entries.find((e) => e.index === index);
        status(
          entry?.occupied
            ? `${bank.path}/${index} — ${entry.name || "unnamed"}, ${entry.size.toLocaleString()} bytes`
            : `${bank.path}/${index} is free.`,
        );
      },
    },
  );
}

function report(error: unknown): void {
  status(error instanceof Error ? error.message : String(error), "error");
}

// --- wiring --------------------------------------------------------------------------------------

$<HTMLInputElement>("projectFile").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) loadProject(file).catch(report);
});

$("connect").addEventListener("click", () => {
  connect().catch(report);
});

$("browse").addEventListener("click", () => {
  browse().catch(report);
});

$("kind").addEventListener("change", () => {
  // The two collections are different sizes and different objects, so a listing of one says nothing
  // about the other. Clearing is more honest than leaving the previous grid under a new heading.
  state.bank = undefined;
  $("libraryGrid").hidden = true;
  $("libraryTabs").hidden = true;
  $("librarySub").textContent = `— press Browse to list ${kind()}s`;
});
