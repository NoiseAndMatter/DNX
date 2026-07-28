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
import {
  NAME_SIZE,
  applyRename,
  planRename,
  readPatternName,
  verifyRename,
} from "../../../src/librarian/rename.js";
import { clear, copyMany, moveMany, swap, type Shuffle } from "../../../src/librarian/shuffle.js";
import { Session, tag } from "../../../src/librarian/session.js";
import {
  DN2_TRACK_COUNT,
  type TrackScope,
  applyTrackMove,
  planTrackMove,
  verifyTrackMove,
} from "../../../src/librarian/trackmove.js";
import { summariseTracks, trackName } from "../../../src/librarian/tracksummary.js";
import { patternName } from "../../../src/sheet/naming.js";
import { buildProjectBlob, download, openProject, type LoadedProject } from "../project.js";
import {
  type Drag,
  type DropHint,
  type Level,
  type Modifiers,
  actionFor,
  dropHint,
  patternForOperation,
  refuseDrop,
} from "./dragrules.js";

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
  /**
   * Which grid those indices belong to.
   *
   * Both grids are on screen at once, so an index alone is ambiguous: `11` is pattern A12 and
   * track T12 at the same time. The level travels with the selection rather than being
   * inferred from which section is open, because with a stacked layout **both** are open.
   */
  level: Level;
  /** Anchor for shift-click ranges. */
  anchor?: number;
  /**
   * The pattern whose tracks are shown beneath the bank, or `undefined` when none are.
   *
   * The tracks are a *section*, not a separate screen: patterns stay above them, and trigs
   * will stack below in turn. Everything else — the four operation buttons, undo, the status
   * bar — works identically at every level, because a track move *is* a shuffle and only what
   * it indexes changes.
   */
  trackFor?: number;
  /** Which half of a track an operation moves. Only consulted for a track-level selection. */
  scope: TrackScope;
}



const state: State = { bank: 0, selection: [], level: "pattern", scope: "both" };

/** True when the current selection is tracks, which is what decides what an operation does. */
function inTracks(): boolean {
  return state.level === "track";
}

/** How a level names its slots — `A1` for patterns, `T1` for tracks. */
function nameAt(level: Level, index: number): string {
  return level === "track" ? trackName(index) : patternName(index);
}

/** The current selection's names. */
function slotName(index: number): string {
  return nameAt(state.level, index);
}

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

/**
 * The 16 tracks of one pattern.
 *
 * Deliberately the same cell shape as the pattern grid — id, name, detail — so the two levels
 * read as one idea at two scales rather than two screens that happen to be adjacent.
 */
function renderTrackGrid(): void {
  const { session, trackFor } = state;
  const section = $("trackSection");

  // No pattern chosen, or a Digitone 1, and the section is simply not there. Hiding it rather
  // than showing sixteen empty cells keeps the page honest about what it can offer.
  if (!session || trackFor === undefined || state.device?.kind !== "dn2") {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const grid = $("trackGrid");
  grid.innerHTML = "";

  for (const track of summariseTracks(session.image, trackFor)) {
    const cell = document.createElement("button");
    cell.className = "slot";
    if (!track.empty) cell.classList.add("occupied");
    if (track.midi) cell.classList.add("midi");
    cell.setAttribute(
      "aria-selected",
      String(inTracks() && state.selection.includes(track.index)),
    );

    // "empty" would be a lie about a track carrying a preset and no notes — which is exactly
    // what a `--scope preset` copy produces, and it made a working copy look like a no-op.
    // The bottom line describes the *sequence*; the preset is the two lines above it.
    const detail = track.trigCount
      ? `${track.trigCount} trigs${track.lockCount ? ` · ${track.lockCount} locks` : ""}`
      : track.presetName
        ? "no trigs"
        : "empty";

    cell.innerHTML =
      `<span class="id">${track.label}</span>` +
      `<span class="nm">${escapeHtml(track.presetName || "—")}</span>` +
      `<span class="mc">${escapeHtml(track.midi ? "MIDI" : (track.machine ?? "?"))}</span>` +
      `<span class="tc">${detail}</span>`;

    wireSlot(cell, "track", track.index);
    grid.append(cell);
  }

  $("trackTitle").textContent = `${patternName(trackFor)} — tracks 1–${DN2_TRACK_COUNT}`;
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
    if (index === state.trackFor) cell.classList.add("opened");
    cell.setAttribute("aria-selected", String(!inTracks() && state.selection.includes(index)));

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

    wireSlot(cell, "pattern", index);
    grid.append(cell);
  }

  $("bankTitle").textContent = `Bank ${BANKS[state.bank]} — patterns ${from + 1}–${to}`;
  renderTrackGrid();
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
      `<strong>${selection.length}</strong> ${inTracks() ? "track" : "pattern"}` +
      `${selection.length === 1 ? "" : "s"} selected: ` +
      `<span style="font-family:ui-monospace,Consolas,monospace">${selection.map(slotName).join(" ")}</span>`;
  }

  // Swap is deliberately not batched: many sources against many targets has no single obvious
  // meaning, so it takes exactly two. Same rule as the CLI.
  $<HTMLButtonElement>("opSwap").disabled = selection.length !== 2;
  $<HTMLButtonElement>("opClear").disabled = selection.length === 0;
  $<HTMLButtonElement>("opMove").disabled = selection.length === 0;
  $<HTMLButtonElement>("opCopy").disabled = selection.length === 0;

  // Rename takes exactly one pattern. Not a batch, because a batch needs a rule — by position,
  // by selection order, from a base name — and there is no defensible default among those. Not
  // a track either: a track's name *is* its preset's name, which belongs to the sound explorer
  // rather than to a slot operation.
  $<HTMLButtonElement>("opRename").disabled = inTracks() || selection.length !== 1;

  // The scope only means anything to a track operation, so it appears with one.
  $("scopeBox").hidden = !inTracks();
  $("opHint").innerHTML =
    `Drag a ${inTracks() ? "track" : "pattern"} onto another to <strong>move</strong> it. ` +
    `Hold <kbd>Shift</kbd> to copy, <kbd>Ctrl</kbd> to swap — the destination says which.<br>` +
    `Shift-click for a range, Ctrl-click to add to the selection.` +
    (inTracks() ? "" : `<br>Select one pattern and press <kbd>F2</kbd> to rename it.`);
}

const SCOPE_HINTS: Readonly<Record<TrackScope, string>> = {
  // Each says what the device calls the same operation, so the mapping is learnable rather
  // than something we invented.
  both: "Both halves and the track level. The hardware has no single command for this.",
  sequence: "The device's TRACK SEQUENCE copy — [FUNC] + [REC]/[STOP]/[PLAY]. The sound stays.",
  preset: "The device's PRESET copy — [TRK] + [REC]/[STOP]/[PLAY]. The trigs stay. Level stays.",
};

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
  $("scopeHint").textContent = SCOPE_HINTS[state.scope];
}

// --- selection ----------------------------------------------------------------------------

function onSlotClick(level: Level, index: number, event: MouseEvent): void {
  // Clicking into the other section starts a fresh selection there. Carrying indices across
  // would silently reinterpret them: 11 is pattern A12 and track T12 at once.
  const sameLevel = state.level === level;
  state.level = level;

  if (sameLevel && event.shiftKey && state.anchor !== undefined) {
    const [lo, hi] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
    state.selection = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  } else if (sameLevel && (event.ctrlKey || event.metaKey)) {
    const at = state.selection.indexOf(index);
    if (at === -1) state.selection.push(index);
    else state.selection.splice(at, 1);
    state.anchor = index;
  } else {
    state.selection = [index];
    state.anchor = index;
  }

  // Selecting a single pattern opens its tracks below it. That is the whole point of stacking
  // the sections rather than swapping them: the next level down is context, not a new screen.
  if (level === "pattern" && state.device?.kind === "dn2" && state.selection.length === 1) {
    state.trackFor = index;
  }
  render();
}

// --- drag and drop --------------------------------------------------------------------------

/** The drag in flight. Kept here rather than in `dataTransfer`, which cannot be read on hover. */
let dragging: Drag | undefined;

/**
 * The cell the cursor is currently over, and what it is.
 *
 * Needed because **a modifier can change without the mouse moving.** `dragover` only fires while
 * the pointer travels, so holding still and pressing Shift would leave the cell saying MOVE while
 * the drop would copy — the one state this feature exists to make impossible. The key handlers
 * below repaint this cell instead.
 */
let hovering: { cell: HTMLElement; level: Level; index: number } | undefined;

/** Modifiers as of the last event of any kind, so a repaint can use them without an event. */
let modifiers: Modifiers = { shiftKey: false, ctrlKey: false, metaKey: false };

/** Strip the drop decoration from a cell. */
function clearTarget(cell: HTMLElement): void {
  cell.classList.remove("target", "move", "copy", "swap");
  cell.removeAttribute("data-action");
}

/** Decorate the hovered cell, or clear it when the drop would be refused. */
function paintTarget(cell: HTMLElement, hint: DropHint | undefined): void {
  clearTarget(cell);
  if (!hint) return;
  cell.classList.add("target", hint.action);
  // The label is drawn by CSS from the attribute rather than injected as a child, so it cannot
  // disturb the cell's own content or survive a re-render that rebuilds the grid.
  cell.setAttribute("data-action", hint.label);
}

/** Repaint whatever is under the cursor after a modifier changed. */
function repaintHovered(): void {
  if (!hovering || !dragging) return;
  paintTarget(hovering.cell, dropHint(dragging, hovering.level, hovering.index, modifiers));
}

/** Click, drag and drop for one cell. Both grids go through it, so neither can drift. */
function wireSlot(cell: HTMLElement, level: Level, index: number): void {
  cell.addEventListener("click", (event) => {
    onSlotClick(level, index, event);
  });

  cell.draggable = true;

  cell.addEventListener("dragstart", (event) => {
    // Dragging one of several selected slots drags the whole selection; dragging anything else
    // drags just that one, and takes the selection with it so the two never disagree.
    const inSelection = state.level === level && state.selection.includes(index);
    if (!inSelection) {
      state.level = level;
      state.selection = [index];
      state.anchor = index;
      render();
    }
    dragging = { level, indices: [...state.selection] };
    cell.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", state.selection.map((i) => nameAt(level, i)).join(" "));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "all";
  });

  cell.addEventListener("dragend", () => {
    dragging = undefined;
    hovering = undefined;
    for (const el of document.querySelectorAll<HTMLElement>(".slot.dragging, .slot.target")) {
      el.classList.remove("dragging");
      clearTarget(el);
    }
    status("");
  });

  cell.addEventListener("dragover", (event) => {
    modifiers = event;
    const hint = dropHint(dragging, level, index, event);

    // A refused drop is simply not accepted, which leaves the browser's own "no" cursor in
    // place — the clearest possible signal, and one we do not have to draw.
    if (!hint) {
      clearTarget(cell);
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = hint.action === "copy" ? "copy" : "move";
    }
    hovering = { cell, level, index };
    paintTarget(cell, hint);
    status(
      `${hint.action} ${dragging!.indices.map((i) => nameAt(level, i)).join(" ")} → ${nameAt(level, index)}` +
        (level === "track" ? scopeSuffix() : "") +
        `  ·  shift = copy, ctrl = swap`,
    );
  });

  cell.addEventListener("dragleave", () => {
    if (hovering?.cell === cell) hovering = undefined;
    clearTarget(cell);
  });

  cell.addEventListener("drop", (event) => {
    const action = actionFor(event);
    const refused = refuseDrop(dragging, level, index, action);
    hovering = undefined;
    clearTarget(cell);
    if (refused !== undefined) {
      // Only worth saying when something was actually being dragged; otherwise this is a stray
      // drop from outside the page and silence is the right response.
      if (dragging) status(`Not done — ${refused}.`, "warn");
      return;
    }
    event.preventDefault();

    const { indices } = dragging!;
    const names = indices.map((i) => nameAt(level, i)).join(" ");
    dragging = undefined;

    // The level is passed explicitly: what was dragged decides what happens, never what
    // happens to be on screen.
    const suffix = level === "track" ? scopeSuffix() : "";
    const to = nameAt(level, index);
    if (action === "swap") {
      run(`swap ${names} and ${to}${suffix}`, swap(indices[0]!, index), level);
    } else if (action === "copy") {
      run(`copy ${names} to ${to}${suffix}`, copyMany(indices, index), level);
    } else {
      run(`move ${names} to ${to}${suffix}`, moveMany(indices, index), level);
    }
  });
}

// --- operations ---------------------------------------------------------------------------

/**
 * Run a shuffle through plan, confirm, apply, verify.
 *
 * The order matters and is the CLI's: plan first so the user is told what would be destroyed,
 * ask, and only then apply — which verifies its own work before the session records it.
 */
function run(label: string, shuffle: Shuffle, level: Level = state.level): void {
  const session = state.session;
  const device = state.device;
  if (!session || !device) return;

  // The level comes from the operation, never from what happens to be on screen. See
  // `patternForOperation`, which carries the reasoning and the test.
  const tracks = patternForOperation(level, state.trackFor);
  const scope = state.scope;

  // One shape for both levels. `planRearrange` and `planTrackMove` deliberately report the same
  // fields, so everything below this point — blockers, the confirmation, the warnings — is
  // written once. That symmetry is why `trackmove.ts` mirrors the plan shape rather than
  // inventing its own.
  const plan =
    tracks === undefined
      ? planRearrange(session.image, shuffle)
      : planTrackMove(session.image, device, tracks, shuffle, scope);

  const blockers = plan.findings.filter((f) => f.severity === "blocker");
  if (blockers.length > 0) {
    status(blockers.map((f) => f.message).join(" "), "error");
    return;
  }

  if (plan.destructive.length > 0) {
    const lines = plan.destructive
      .map((c) =>
        "slot" in c
          ? `  ${patternName(c.slot)}${c.name ? ` "${c.name}"` : ""} — ${c.trigCount} trigs` +
            (c.replacedBy !== undefined ? `, replaced by ${patternName(c.replacedBy)}` : "")
          : `  ${trackName(c.track)} — ${c.trigCount} trigs`,
      )
      .join("\n");
    if (!confirm(`This destroys work that cannot be recovered from the file:\n\n${lines}\n\nContinue?`)) {
      status("Cancelled — nothing changed.");
      return;
    }
  }

  const changed = session.apply(tag(label), (image) => {
    if (tracks !== undefined) {
      const result = applyTrackMove(image, device, tracks, shuffle, {
        confirmOverwrite: true,
        scope,
      });
      const verification = verifyTrackMove(image, result.image, tracks, shuffle, scope);
      if (!verification.ok) {
        throw new Error(`verification failed: ${verification.problems.join("; ")}`);
      }
      return result.image;
    }
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

/** Ask for a destination, accepting whatever the current level calls its slots. */
function askTarget(what: string): number | undefined {
  const device = state.device;
  if (!device) return undefined;
  const count = inTracks() ? DN2_TRACK_COUNT : device.patternCount;
  const answer = prompt(`${what} — destination (${slotName(0)} … ${slotName(count - 1)})`);
  if (answer === null) return undefined;

  const wanted = answer.trim().toUpperCase();
  for (let i = 0; i < count; i++) if (slotName(i) === wanted) return i;

  status(`Not a ${inTracks() ? "track" : "slot"}: "${answer}".`, "error");
  return undefined;
}

/**
 * Rename one pattern.
 *
 * It does not go through `run()`, and that is the point rather than an omission: `run` is
 * shuffle-shaped, and a rename moves nothing. `Session.apply` takes any image-to-image
 * function, so a rename needed no new machinery at either layer — the seam was already right.
 */
function runRename(pattern: number): void {
  const { session, device } = state;
  if (!session || !device) return;

  const current = readPatternName(session.image, device, pattern);
  const typed = prompt(`Rename ${patternName(pattern)} (up to ${NAME_SIZE} characters)`, current);
  if (typed === null) return;

  const renames = new Map([[pattern, typed]]);
  const plan = planRename(session.image, device, renames);

  const blockers = plan.findings.filter((f) => f.severity === "blocker");
  if (blockers.length > 0) {
    status(blockers.map((f) => f.message).join(" "), "error");
    return;
  }
  if (plan.changes.length === 0) {
    status(`${patternName(pattern)} is already called "${current}".`, "warn");
    return;
  }

  const change = plan.changes[0]!;
  const changed = session.apply(tag(`rename ${patternName(pattern)} to "${change.to}"`), (image) => {
    const result = applyRename(image, device, renames);
    const verification = verifyRename(image, result.image, device, result.plan);
    if (!verification.ok) {
      throw new Error(`verification failed: ${verification.problems.join("; ")}`);
    }
    return result.image;
  });

  if (!changed) {
    status("Rename changed nothing.", "warn");
    return;
  }

  // The warnings carry what happened to the typed name — upper-casing, truncation, a dropped
  // character — so a transformation is never silent.
  const warnings = plan.findings.filter((f) => f.severity === "warning");
  status(
    `${patternName(pattern)} is now "${change.to}". ` +
      (warnings.length ? warnings.map((w) => w.message).join(" ") : "Verified."),
    warnings.length ? "warn" : "ok",
  );
  render();
}

/** The scope, named for the log, so history says which half moved rather than just "move". */
function scopeSuffix(): string {
  if (!inTracks() || state.scope === "both") return "";
  return ` (${state.scope} only)`;
}

function wireOperations(): void {
  $("opMove").addEventListener("click", () => {
    const names = state.selection.map(slotName).join(" ");
    const to = askTarget(`Move ${names}`);
    if (to === undefined) return;
    run(`move ${names} to ${slotName(to)}${scopeSuffix()}`, moveMany(state.selection, to));
  });

  $("opCopy").addEventListener("click", () => {
    const names = state.selection.map(slotName).join(" ");
    const to = askTarget(`Copy ${names}`);
    if (to === undefined) return;
    run(`copy ${names} to ${slotName(to)}${scopeSuffix()}`, copyMany(state.selection, to));
  });

  $("opSwap").addEventListener("click", () => {
    const [a, b] = state.selection as [number, number];
    run(`swap ${slotName(a)} and ${slotName(b)}${scopeSuffix()}`, swap(a, b));
  });

  $("opRename").addEventListener("click", () => {
    const [pattern] = state.selection;
    if (pattern !== undefined) runRename(pattern);
  });

  $("opClear").addEventListener("click", () => {
    run(`clear ${state.selection.map(slotName).join(" ")}${scopeSuffix()}`, clear(...state.selection));
  });

  $("closeTracks").addEventListener("click", () => {
    const was = state.trackFor;
    state.trackFor = undefined;
    // Leave the pattern selected, so closing its tracks is not also a deselection the user
    // then has to undo by clicking again.
    state.level = "pattern";
    state.selection = was === undefined ? [] : [was];
    state.anchor = was;
    render();
  });

  $<HTMLSelectElement>("scope").addEventListener("change", (event) => {
    state.scope = (event.target as HTMLSelectElement).value as TrackScope;
    render();
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
  // A new project is a new set of patterns; staying drilled into slot 7 of the old one would
  // show the right index of the wrong thing.
  state.trackFor = undefined;

  $("device").hidden = false;
  $("device").textContent = device.name;
  $("projname").textContent = device.projectName(loaded.image);
  $<HTMLButtonElement>("export").disabled = false;
  // The dropzone is the empty state and gets hidden for good once a project is open, so
  // without this there is no way to open a second one short of reloading the page.
  $("reopen").hidden = false;

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

/**
 * Wire a file input to `load`.
 *
 * Two inputs reach it: the dropzone's, which is the empty state, and the top bar's, which
 * replaces an open project. Replacing one throws away its undo history — the session lives in
 * memory and nothing has been written — so that route asks first. The empty-state one has
 * nothing to lose and does not.
 */
function wireFileInput(id: string, guard: boolean): void {
  $<HTMLInputElement>(id).addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (guard && state.session?.canUndo) {
      const ok = confirm(
        `Opening ${file.name} discards the edits made to this project and its undo history.\n\n` +
          `Nothing has been written to disk yet — export first if you want to keep them.\n\n` +
          `Open anyway?`,
      );
      if (!ok) {
        // Clear it, or picking the same file again fires no change event and looks broken.
        input.value = "";
        status("Cancelled — the open project is untouched.");
        return;
      }
    }

    load(file)
      .catch((error: unknown) =>
        status(error instanceof Error ? error.message : String(error), "error"),
      )
      .finally(() => {
        input.value = "";
      });
  });
}

wireFileInput("file", false);
wireFileInput("file2", true);

// A modifier pressed or released mid-drag changes what the drop will do, and `dragover` does not
// fire unless the pointer moves. Without these two, holding still and pressing Shift leaves the
// cell saying MOVE while the drop copies — the exact confusion the labels exist to prevent.
for (const type of ["keydown", "keyup"] as const) {
  document.addEventListener(type, (event) => {
    if (!dragging) return;
    modifiers = event;
    repaintHovered();
  });
}

document.addEventListener("keydown", (event) => {
  // F2 renames, the way it does in every file manager, and without a modifier.
  if (event.key === "F2") {
    const button = $<HTMLButtonElement>("opRename");
    if (!button.disabled) {
      event.preventDefault();
      button.click();
    }
    return;
  }
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
