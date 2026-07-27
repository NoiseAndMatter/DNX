/**
 * The manager: one project open, patterns moved between slots, exported once.
 *
 * This is the first slice from `docs/ui-plan.md` and nothing more — open, rearrange, export.
 * Kits, sound explorers and cross-project copying come later, and every one of them is easier
 * to add on top of a session that already works than to design around now.
 *
 * ## What it reuses, and why that matters
 *
 * Every decision here was made and tested in the CLI first. This module holds **no rules**:
 * `shuffle.ts` says what a move means, `rearrange.ts` plans and verifies it, `session.ts`
 * holds the history, `device.ts` reports which family is open. A UI that re-implemented any
 * of those would drift from the thing 295 tests cover.
 *
 * The one thing the browser adds is *choosing* — which slots, which operation, which target.
 * So that is all this file does.
 *
 * ## Collisions ask, always
 *
 * `applyRearrange` refuses to overwrite without `confirmOverwrite`, and the plan lists exactly
 * what would be lost. The UI shows that list and requires a yes. For most people the +Drive is
 * the only copy of that work, and an undo they have to discover after the fact is not consent.
 */

import { deviceFor, type Device } from "../../../src/librarian/device.js";
import { planRearrange, applyRearrange } from "../../../src/librarian/rearrange.js";
import { clear, copyMany, moveMany, swap, type Shuffle } from "../../../src/librarian/shuffle.js";
import { Session, tag } from "../../../src/librarian/session.js";
import { patternName } from "../../../src/sheet/naming.js";
import { buildProjectBlob, download, openProject, type LoadedProject } from "../project.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

type Kind = "info" | "error" | "warn" | "ok";
function status(message: string, kind: Kind = "info"): void {
  const bar = $("status");
  bar.textContent = message;
  bar.className = `status ${kind === "info" ? "" : kind}`;
}

interface State {
  file?: LoadedProject;
  session?: Session;
  device?: Device;
  bank: number;
  /** Selected slot indices, in the order they were clicked — a batch lands in this order. */
  selection: number[];
  /** Anchor for shift-click ranges. */
  anchor?: number;
}

const state: State = { bank: 0, selection: [] };

const BANKS = "ABCDEFGH";

// --- rendering ----------------------------------------------------------------------------

function bankCount(device: Device): number {
  return Math.ceil(device.patternCount / 16);
}

function renderTabs(): void {
  const { device, session } = state;
  if (!device || !session) return;

  const tabs = $("tabs");
  tabs.hidden = false;
  tabs.innerHTML = "";

  for (let bank = 0; bank < bankCount(device); bank++) {
    const occupied = countOccupied(bank);
    const button = document.createElement("button");
    button.className = "tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(bank === state.bank));
    button.innerHTML = `${BANKS[bank]}<span class="n">${occupied || ""}</span>`;
    button.addEventListener("click", () => {
      state.bank = bank;
      render();
    });
    tabs.append(button);
  }
}

function countOccupied(bank: number): number {
  const { device, session } = state;
  if (!device || !session) return 0;
  let n = 0;
  for (let i = bank * 16; i < Math.min((bank + 1) * 16, device.patternCount); i++) {
    if (device.summarise(session.image, i).occupied) n++;
  }
  return n;
}

function renderGrid(): void {
  const { device, session } = state;
  if (!device || !session) return;

  const grid = $("grid");
  grid.hidden = false;
  $("legend").hidden = false;
  $("dropzone").hidden = true;
  grid.innerHTML = "";

  const from = state.bank * 16;
  const to = Math.min(from + 16, device.patternCount);

  for (let index = from; index < to; index++) {
    const summary = device.summarise(session.image, index);
    const cell = document.createElement("button");
    cell.className = "slot";
    if (!summary.supported) cell.classList.add("unsupported");
    else if (summary.occupied) cell.classList.add("occupied");
    cell.setAttribute("aria-selected", String(state.selection.includes(index)));

    const name = summary.supported ? summary.name || "—" : `v${summary.version}`;
    const detail = summary.supported
      ? summary.occupied
        ? `${summary.trigCount} trigs${summary.soundLockCount ? ` · ${summary.soundLockCount} locks` : ""}`
        : "empty"
      : "unreadable version";

    cell.innerHTML =
      `<span class="id">${patternName(index)}</span>` +
      `<span class="nm">${escapeHtml(name)}</span>` +
      `<span class="tc">${detail}</span>`;

    cell.addEventListener("click", (event) => {
      onSlotClick(index, event);
    });
    grid.append(cell);
  }

  $("bankTitle").textContent = `Bank ${BANKS[state.bank]} — patterns ${from + 1}–${to}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSelection(): void {
  const { selection } = state;
  const box = $("selection");
  if (selection.length === 0) {
    box.className = "hint";
    box.textContent = "Nothing selected.";
  } else {
    box.className = "";
    box.innerHTML =
      `<strong>${selection.length}</strong> selected: ` +
      `<span style="font-family:ui-monospace,Consolas,monospace">${selection.map(patternName).join(" ")}</span>`;
  }

  // Swap is deliberately not batched: many sources against many targets has no single obvious
  // meaning, so it takes exactly two. Same rule as the CLI.
  $<HTMLButtonElement>("opSwap").disabled = selection.length !== 2;
  $<HTMLButtonElement>("opClear").disabled = selection.length === 0;
  $<HTMLButtonElement>("opMove").disabled = selection.length === 0;
  $<HTMLButtonElement>("opCopy").disabled = selection.length === 0;
}

function renderHistory(): void {
  const list = $("history");
  const session = state.session;
  const entries = session?.history() ?? [];

  if (entries.length === 0) {
    list.innerHTML = `<li class="hint">Nothing done yet.</li>`;
  } else {
    list.innerHTML = entries
      .slice(0, 12)
      .map(
        (e) =>
          `<li>${escapeHtml(e.label)}<span class="b">${(e.bytes / 1024).toFixed(0)} KB</span></li>`,
      )
      .join("");
  }

  $<HTMLButtonElement>("undo").disabled = !session?.canUndo;
  $<HTMLButtonElement>("redo").disabled = !session?.canRedo;
  $<HTMLButtonElement>("undo").textContent = session?.undoLabel ? `Undo ${session.undoLabel}` : "Undo";
  $<HTMLButtonElement>("redo").textContent = session?.redoLabel ? `Redo ${session.redoLabel}` : "Redo";
}

function render(): void {
  renderTabs();
  renderGrid();
  renderSelection();
  renderHistory();
}

// --- selection ----------------------------------------------------------------------------

function onSlotClick(index: number, event: MouseEvent): void {
  if (event.shiftKey && state.anchor !== undefined) {
    const [lo, hi] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
    state.selection = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  } else if (event.ctrlKey || event.metaKey) {
    const at = state.selection.indexOf(index);
    if (at === -1) state.selection.push(index);
    else state.selection.splice(at, 1);
    state.anchor = index;
  } else {
    state.selection = [index];
    state.anchor = index;
  }
  render();
}

// --- operations ---------------------------------------------------------------------------

/**
 * Run a shuffle through plan, confirm, apply, verify.
 *
 * The order matters and is the CLI's: plan first so the user is told what would be destroyed,
 * ask, and only then apply — which verifies its own work before the session records it.
 */
function run(label: string, shuffle: Shuffle): void {
  const session = state.session;
  if (!session) return;

  const plan = planRearrange(session.image, shuffle);

  const blockers = plan.findings.filter((f) => f.severity === "blocker");
  if (blockers.length > 0) {
    status(blockers.map((f) => f.message).join(" "), "error");
    return;
  }

  if (plan.destructive.length > 0) {
    const lines = plan.destructive
      .map(
        (c) =>
          `  ${patternName(c.slot)}${c.name ? ` "${c.name}"` : ""} — ${c.trigCount} trigs` +
          (c.replacedBy !== undefined ? `, replaced by ${patternName(c.replacedBy)}` : ""),
      )
      .join("\n");
    if (!confirm(`This destroys work that cannot be recovered from the file:\n\n${lines}\n\nContinue?`)) {
      status("Cancelled — nothing changed.");
      return;
    }
  }

  const changed = session.apply(tag(label), (image) => {
    const result = applyRearrange(image, shuffle, { confirmOverwrite: true });
    if (!result.verification.ok) {
      throw new Error(`verification failed: ${result.verification.problems.join("; ")}`);
    }
    return result.image;
  });

  if (!changed) {
    status(`${label} changed nothing.`, "warn");
    return;
  }

  const warnings = plan.findings.filter((f) => f.severity === "warning");
  status(
    `${label}. ${warnings.length ? warnings.map((w) => w.message).join(" ") : "Verified."}`,
    warnings.length ? "warn" : "ok",
  );
  state.selection = [];
  render();
}

/** Ask for a destination slot, accepting the device's own names. */
function askTarget(what: string): number | undefined {
  const device = state.device;
  if (!device) return undefined;
  const answer = prompt(`${what} — destination slot (A1 … ${patternName(device.patternCount - 1)})`);
  if (answer === null) return undefined;

  const wanted = answer.trim().toUpperCase();
  for (let i = 0; i < device.patternCount; i++) if (patternName(i) === wanted) return i;

  status(`Not a slot: "${answer}".`, "error");
  return undefined;
}

function wireOperations(): void {
  $("opMove").addEventListener("click", () => {
    const to = askTarget(`Move ${state.selection.map(patternName).join(" ")}`);
    if (to === undefined) return;
    run(`move ${state.selection.map(patternName).join(" ")} to ${patternName(to)}`, moveMany(state.selection, to));
  });

  $("opCopy").addEventListener("click", () => {
    const to = askTarget(`Copy ${state.selection.map(patternName).join(" ")}`);
    if (to === undefined) return;
    run(`copy ${state.selection.map(patternName).join(" ")} to ${patternName(to)}`, copyMany(state.selection, to));
  });

  $("opSwap").addEventListener("click", () => {
    const [a, b] = state.selection as [number, number];
    run(`swap ${patternName(a)} and ${patternName(b)}`, swap(a, b));
  });

  $("opClear").addEventListener("click", () => {
    run(`clear ${state.selection.map(patternName).join(" ")}`, clear(...state.selection));
  });

  $("undo").addEventListener("click", () => {
    const label = state.session?.undo();
    if (label) status(`Undid ${label}.`);
    state.selection = [];
    render();
  });

  $("redo").addEventListener("click", () => {
    const label = state.session?.redo();
    if (label) status(`Redid ${label}.`);
    state.selection = [];
    render();
  });

  $("export").addEventListener("click", () => {
    void exportProject();
  });
}

// --- open and export ----------------------------------------------------------------------

async function load(file: File): Promise<void> {
  status(`Reading ${file.name}…`);
  const loaded = await openProject(file);
  const device = deviceFor(loaded.image);

  state.file = loaded;
  state.device = device;
  state.session = new Session(loaded.image);
  state.selection = [];
  state.bank = 0;

  $("device").hidden = false;
  $("device").textContent = device.name;
  $("projname").textContent = device.projectName(loaded.image);
  $<HTMLButtonElement>("export").disabled = false;

  render();

  // The DN2's song table has never been located, so a rearrangement cannot be checked against
  // songs. Say so once, on open, rather than after the work is done.
  const songs = device.songState(loaded.image);
  if (songs === "unknown") {
    status(
      `${file.name} open. Songs cannot be checked on the ${device.name} — its song table has ` +
        `never been located, so verify any songs after loading.`,
      "warn",
    );
  } else if (songs === "occupied") {
    status(`${file.name} open. This project has songs; moving patterns may desync them.`, "warn");
  } else {
    status(`${file.name} open.`, "ok");
  }
}

async function exportProject(): Promise<void> {
  const { file, session, device } = state;
  if (!file || !session || !device) return;

  const blob = await buildProjectBlob(file, session.image);
  const base = device.projectName(session.image).replace(/[^\w -]/g, "_") || "PROJECT";
  download(blob, `${base}${device.kind === "dn2" ? ".dn2prj" : ".dnprj"}`);
  status(`Exported ${base}. The original file is untouched.`, "ok");
}

// --- wiring -------------------------------------------------------------------------------

$<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  load(file).catch((error: unknown) =>
    status(error instanceof Error ? error.message : String(error), "error"),
  );
});

document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === "z" && !event.shiftKey) {
    event.preventDefault();
    $("undo").click();
  } else if (event.key === "y" || (event.key === "z" && event.shiftKey)) {
    event.preventDefault();
    $("redo").click();
  }
});

wireOperations();
