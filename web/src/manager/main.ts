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
import { type DriveProject } from "../../../src/device/drive.js";
import { ProductId } from "../../../src/sysex/devices.js";
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
  applyTrackMove,
  planTrackMove,
  type TrackScope,
  verifyTrackMove,
} from "../../../src/librarian/trackmove.js";
import { TRACK_COUNT as DN2_TRACK_COUNT } from "../../../src/project/dn2pattern.js";
import { summariseTracks, trackName } from "../../../src/librarian/tracksummary.js";
import { patternName } from "../../../src/sheet/naming.js";
import {
  buildProjectBlob,
  download,
  openProject,
  type LoadedProject,
} from "../project.js";
import { describeDonor, loadDonor } from "../donor.js";
import {
  type ConnectedDevice,
  type DeviceChoice,
  type DeviceProjectHandle,
  DeviceSourceError,
  connectDevice,
  describeChoice,
  listDevices,
  listDeviceProjects,
  openDeviceProject,
  readProject,
  writeBack,
} from "../devicesource.js";
import { recordWriteMessage } from "../../../src/device/safewrite.js";
import { STAGE_LABEL, confirmRecordWrite, downloadBackup } from "../safewriteui.js";
import {
  type Level,
  actionFor,
  dropHint,
  patternForOperation,
  refuseDrop,
} from "./dragrules.js";
// Aliased: this module has its own `renderGrid`, which draws *the pattern bank* and then delegates
// the cells. Two functions of that name in one file would be a coin toss every time it is read.
import { BANKS, GridDrag, bankCount, renderBanks, renderGrid as renderSlots } from "../grid.js";
import { $, escapeHtml } from "../dom.js";
import { countOccupiedIn, patternSlotView } from "../slotview.js";
import { statusBar } from "../statusbar.js";
import { describeBytes, progressBar } from "../progress.js";
import {
  type HistoryElements,
  goToHistoryPoint as walkHistory,
  renderHistory as drawHistory,
  wireHistory,
} from "../history.js";
import { askConfirm, askText } from "../dialog.js";
import { renderToolNav } from "../toolnav.js";

const status = statusBar();
const progress = progressBar();

// Drawn rather than written into the HTML, so the row cannot say different things on different
// pages. Immediately, because a navigation control that appears late is one you click through.
renderToolNav($("toolnav"), "manager");

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

/**
 * The instrument this project came from, when it came from one.
 *
 * Undefined for a file, and that is the whole design: a device is a **source**, not a mode. The
 * session, undo, every operation and the exporter work on the image either way; this only decides
 * whether **Write to device** has anywhere to write to.
 */
let deviceHandle: DeviceProjectHandle | undefined;

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


// --- rendering ----------------------------------------------------------------------------

function renderTabs(): void {
  const { device, session } = state;
  if (!device || !session) return;
  renderBanks($("tabs"), {
    patternCount: device.patternCount,
    current: state.bank,
    countOccupied,
    onSelect: (bank) => {
      state.bank = bank;
      render();
    },
  });
}

function countOccupied(bank: number): number {
  const { device, session } = state;
  if (!device || !session) return 0;
  return countOccupiedIn(bank, device, session.image);
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
  renderSlots(
    $("trackGrid"),
    summariseTracks(session.image, trackFor).map((track) => ({
      index: track.index,
      id: track.label,
      name: track.presetName || "—",
      machine: track.midi ? "MIDI" : (track.machine ?? "?"),
      // "empty" would be a lie about a track carrying a preset and no notes — which is exactly
      // what a `--scope preset` copy produces, and it made a working copy look like a no-op.
      // The bottom line describes the *sequence*; the preset is the two lines above it.
      detail: track.trigCount
        ? `${track.trigCount} trigs${track.lockCount ? ` · ${track.lockCount} locks` : ""}`
        : track.presetName
          ? "no trigs"
          : "empty",
      occupied: !track.empty,
      supported: true,
      ...(track.midi ? { classes: ["midi"] } : {}),
    })),
    {
      selected: inTracks() ? state.selection : [],
      onClick: (index, event) => {
        onSlotClick("track", index, event);
      },
      drag: { controller: drag, grid: "track" },
    },
  );

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

  const slots = [];
  for (let index = from; index < to; index++) {
    slots.push({ index, ...patternSlotView(device, session.image, index) });
  }

  renderSlots(grid, slots, {
    selected: inTracks() ? [] : state.selection,
    ...(state.trackFor === undefined ? {} : { opened: state.trackFor }),
    onClick: (index, event) => {
      onSlotClick("pattern", index, event);
    },
    drag: { controller: drag, grid: "pattern" },
  });

  $("bankTitle").textContent = `Bank ${BANKS[state.bank]} — patterns ${from + 1}–${to}`;
  renderTrackGrid();
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

/**
 * Walk the session to the point a history row names.
 *
 * `undo:n` means "undo n steps", so the clicked action becomes the most recent thing that
 * happened. `redo:n` means "redo n steps", which is how a step that was undone comes back.
 * Clicking the row you are already at is `undo:0` and does nothing, which is the right answer to
 * asking to go where you are.
 */
function goToHistoryPoint(step: string): void {
  const said = walkHistory(state.session, step);
  if (said) status(said);
  state.selection = [];
  render();
}

function renderHistory(): void {
  drawHistory(historyElements(), state.session);
}

/** The three elements the shared panel writes to. Named once so both wirings agree. */
function historyElements(): HistoryElements {
  return {
    list: $("history"),
    undo: $<HTMLButtonElement>("undo"),
    redo: $<HTMLButtonElement>("redo"),
  };
}

function render(): void {
  renderTabs();
  renderGrid();
  renderSelection();
  renderHistory();
  $("scopeHint").textContent = SCOPE_HINTS[state.scope];

  // Enabled only when there is something to send. An edit is what makes a write meaningful, and a
  // button that is live with nothing to do invites a pointless 114 KB transfer.
  if (deviceHandle && state.session) {
    $<HTMLButtonElement>("writedevice").disabled = state.session.image === deviceHandle.original;
  }
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

/**
 * Drag and drop, through the shared controller.
 *
 * The plumbing — start, hover, refuse, drop, repaint — lives in `grid.ts` so the expander gets the
 * same gestures. **What a drop means stays here**: inside one project it is a shuffle, and
 * `dragrules.ts` decides which. Those rules are hardware-verified and are not moving.
 */
const drag = new GridDrag({
  onDragStart(grid, index) {
    // Dragging one of several selected slots drags the whole selection; dragging anything else
    // drags just that one, and takes the selection with it so the two never disagree.
    const level = grid as Level;
    const inSelection = state.level === level && state.selection.includes(index);
    if (!inSelection) {
      state.level = level;
      state.selection = [index];
      state.anchor = index;
      render();
    }
    return [...state.selection];
  },

  hintFor(from, grid, index, modifiers) {
    const level = grid as Level;
    const hint = dropHint({ level: from.grid as Level, indices: from.indices }, level, index, modifiers);
    if (!hint) return undefined;
    return {
      action: hint.action,
      label: hint.label,
      status:
        `${hint.action} ${from.indices.map((i) => nameAt(from.grid as Level, i)).join(" ")} → ${nameAt(level, index)}` +
        (level === "track" ? scopeSuffix() : "") +
        `  ·  shift = copy, ctrl = swap`,
    };
  },

  onDrop(from, grid, index, modifiers) {
    const level = grid as Level;
    const action = actionFor(modifiers);
    const refused = refuseDrop({ level: from.grid as Level, indices: from.indices }, level, index, action);
    if (refused !== undefined) {
      status(`Not done — ${refused}.`, "warn");
      return;
    }

    const { indices } = from;
    const names = indices.map((i) => nameAt(level, i)).join(" ");
    // The level is passed explicitly: what was dragged decides what happens, never what happens to
    // be on screen.
    const suffix = level === "track" ? scopeSuffix() : "";
    const to = nameAt(level, index);
    if (action === "swap") {
      run(`swap ${names} and ${to}${suffix}`, swap(indices[0]!, index), level).catch(report);
    } else if (action === "copy") {
      run(`copy ${names} to ${to}${suffix}`, copyMany(indices, index), level).catch(report);
    } else {
      run(`move ${names} to ${to}${suffix}`, moveMany(indices, index), level).catch(report);
    }
  },

  onStatus: (message) => {
    status(message);
  },
});

// --- operations ---------------------------------------------------------------------------

/**
 * Where a rejected operation goes.
 *
 * Operations became `async` when their confirmation did, and an async handler nobody awaits turns
 * a throw into an unhandled rejection — nothing on screen, one line in a console nobody has open.
 * Every `.catch(report)` in this file exists for that, not for tidiness.
 */
function report(error: unknown): void {
  status(error instanceof Error ? error.message : String(error), "error");
}

/**
 * Run a shuffle through plan, confirm, apply, verify.
 *
 * The order matters and is the CLI's: plan first so the user is told what would be destroyed,
 * ask, and only then apply — which verifies its own work before the session records it.
 */
async function run(label: string, shuffle: Shuffle, level: Level = state.level): Promise<void> {
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
    // A list, not a paragraph with newlines in it. This is the one dialog in the app where the
    // *detail* is the decision — how many trigs, in which named pattern — and `confirm` could only
    // render it as run-together text in a system font.
    const lines = plan.destructive.map((c) =>
      "slot" in c
        ? `${patternName(c.slot)}${c.name ? ` "${c.name}"` : ""} — ${c.trigCount} trigs` +
          (c.replacedBy !== undefined ? `, replaced by ${patternName(c.replacedBy)}` : "")
        : `${trackName(c.track)} — ${c.trigCount} trigs`,
    );
    const ok = await askConfirm({
      title: "This destroys work that cannot be recovered from the file",
      body: [`${label}. What is listed below is overwritten or emptied:`],
      list: lines,
      confirmLabel: "Destroy it",
      danger: true,
    });
    if (!ok) {
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
async function askTarget(what: string): Promise<number | undefined> {
  const device = state.device;
  if (!device) return undefined;
  const count = inTracks() ? DN2_TRACK_COUNT : device.patternCount;
  const answer = await askText({
    title: what,
    body: [`Where should it land? ${slotName(0)} to ${slotName(count - 1)}.`],
    placeholder: slotName(0),
    confirmLabel: "Choose",
  });
  // `undefined` is dismissal; `""` is somebody pressing the button with an empty box, which is not
  // a slot and should say so rather than silently doing nothing.
  if (answer === undefined) return undefined;

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
async function runRename(pattern: number): Promise<void> {
  const { session, device } = state;
  if (!session || !device) return;

  const current = readPatternName(session.image, device, pattern);
  // `maxLength` is the device's own field width, so the box cannot accept what the format cannot
  // hold. `planRename` still reports truncation and upper-casing — this stops one of the three
  // transformations happening at all, rather than replacing the reporting.
  const typed = await askText({
    title: `Rename ${patternName(pattern)}`,
    body: [
      `Up to ${NAME_SIZE} characters. The device has no lowercase, so anything typed in lower ` +
        `case is stored upper.`,
    ],
    value: current,
    maxLength: NAME_SIZE,
    confirmLabel: "Rename",
  });
  if (typed === undefined) return;

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
  // **Every one of these is fire-and-forget, and `report` is what makes that safe.** An async
  // handler whose promise nobody holds swallows its rejection into an unhandled one — silence on
  // screen and a line in a console nobody has open. `.catch(report)` puts it in the status bar.
  $("opMove").addEventListener("click", () => {
    const names = state.selection.map(slotName).join(" ");
    void (async () => {
      const to = await askTarget(`Move ${names}`);
      if (to === undefined) return;
      await run(`move ${names} to ${slotName(to)}${scopeSuffix()}`, moveMany(state.selection, to));
    })().catch(report);
  });

  $("opCopy").addEventListener("click", () => {
    const names = state.selection.map(slotName).join(" ");
    void (async () => {
      const to = await askTarget(`Copy ${names}`);
      if (to === undefined) return;
      await run(`copy ${names} to ${slotName(to)}${scopeSuffix()}`, copyMany(state.selection, to));
    })().catch(report);
  });

  $("opSwap").addEventListener("click", () => {
    const [a, b] = state.selection as [number, number];
    run(`swap ${slotName(a)} and ${slotName(b)}${scopeSuffix()}`, swap(a, b)).catch(report);
  });

  $("opRename").addEventListener("click", () => {
    const [pattern] = state.selection;
    if (pattern !== undefined) runRename(pattern).catch(report);
  });

  $("opClear").addEventListener("click", () => {
    run(
      `clear ${state.selection.map(slotName).join(" ")}${scopeSuffix()}`,
      clear(...state.selection),
    ).catch(report);
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

  /**
   * Click a point in the history to go there.
   *
   * **Stepping, not seeking.** The session stores patches rather than snapshots, so there is no
   * state to jump to — reaching a point means applying every step between here and it. Doing that
   * in a loop is honest about the cost and reuses the two operations that are already correct;
   * a `goTo` on the session would be a third path through the same patches, and the one most
   * likely to disagree with the other two.
   *
   * Delegated from the list rather than bound per row, because the rows are rebuilt on every
   * render and listeners on replaced elements are how a control quietly stops working.
   */
  wireHistory($("history"), goToHistoryPoint);

  // Caught, not `void`ed. An export that throws — a payload too short to carry a header, a ZIP the
  // browser refused to build — used to produce no download and no message, which reads to the user
  // as a dead button rather than as a failure.
  $("export").addEventListener("click", () => {
    exportProject().catch((error: unknown) => {
      status(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  });

  $("opendevice").addEventListener("click", () => {
    void loadFromDevice();
  });

  $("writedevice").addEventListener("click", () => {
    void writeToDevice();
  });

  $("browsedrive").addEventListener("click", () => {
    void browseDrive();
  });

  $("opendrive").addEventListener("click", () => {
    void openFromDrive();
  });

  // Choosing a different instrument drops everything held about the old one. The +Drive listing
  // belongs to the device it was read from, and showing slot names from one instrument while
  // reading bytes off another is the mistake this whole control exists to prevent.
  $("whichdevice").addEventListener("change", (event) => {
    const port = (event.target as HTMLSelectElement).value;
    drive?.connected.close();
    drive = undefined;
    $("driveprojects").hidden = true;
    $("opendrive").hidden = true;
    chosenPort = port || undefined;
    status(port ? `Working with ${port}. Browse its +Drive, or open its project.` : "No device chosen.");
  });
}

// --- the +Drive ------------------------------------------------------------------------------

/**
 * The connection held between listing the +Drive and opening something off it.
 *
 * Kept rather than reconnected, because the slot numbers in the picker belong to **that** device.
 * Reconnecting between the two steps could hand them to a different instrument, which would open
 * the wrong project with total confidence.
 */
let drive: { connected: ConnectedDevice; projects: DriveProject[] } | undefined;

/**
 * The instrument this page is working with, once there has been a choice to make.
 *
 * Remembered so the choice happens once rather than at every operation. Cleared by the picker,
 * which is the only way to move to the other instrument.
 */
let chosenPort: string | undefined;

/**
 * Connect — but to the instrument the person meant.
 *
 * **The manager cannot pick for you and should not pretend to.** The expander can: its two devices
 * have fixed roles, so `connectDevice({ want: DN1 })` says everything. Here either instrument is a
 * legitimate subject, and taking whichever answered first was the reported bug — *"I have no way to
 * select what device to load/use."*
 *
 * With one device connected nothing changes: it is found, used, and no picker appears. With two,
 * the picker appears **empty** and this refuses until something is chosen. The empty first option
 * is the point — a select that defaulted to its first entry would quietly reintroduce the very
 * guess this exists to remove.
 */
async function chooseDevice(): Promise<ConnectedDevice> {
  if (chosenPort !== undefined) return await connectDevice({ port: chosenPort });

  const found = await listDevices();
  if (found.length === 0) {
    throw new DeviceSourceError(
      "No Digitone answered on any MIDI port pair. Connect it over USB, and check that no other " +
        "application is holding it.",
    );
  }
  if (found.length === 1) {
    chosenPort = found[0]!.port;
    return await connectDevice({ port: chosenPort });
  }

  renderDevicePicker(found);
  const select = $<HTMLSelectElement>("whichdevice");
  if (!select.value) {
    throw new DeviceSourceError(
      `${found.length} instruments are connected: ${found.map((f) => f.name).join(", ")}. ` +
        `Choose one from the list and try again.`,
    );
  }
  chosenPort = select.value;
  return await connectDevice({ port: chosenPort });
}

function renderDevicePicker(found: DeviceChoice[]): void {
  const select = $<HTMLSelectElement>("whichdevice");
  const previous = select.value;
  select.hidden = false;
  select.replaceChildren(
    Object.assign(document.createElement("option"), {
      value: "",
      textContent: "— which device? —",
    }),
    ...found.map((f) =>
      Object.assign(document.createElement("option"), {
        value: f.port,
        textContent: describeChoice(f),
      }),
    ),
  );
  // Kept across a re-list, so listing again does not silently move the page to another instrument.
  if (found.some((f) => f.port === previous)) select.value = previous;
}

/** List what is stored on the instrument. Reads the directory and nothing else. */
async function browseDrive(): Promise<void> {
  status("Looking for an instrument…");
  try {
    const connected = drive?.connected ?? (await chooseDevice());
    status(`Listing the +Drive on ${connected.name}…`);
    const projects = await listDeviceProjects(connected);
    drive = { connected, projects };

    const select = $<HTMLSelectElement>("driveprojects");
    select.replaceChildren(
      ...projects.map((p) => {
        const option = document.createElement("option");
        option.value = String(p.index);
        // Slot number first: it is what addresses the project, and what the device's own screen
        // shows. A name alone is ambiguous — a +Drive can hold two projects called NEW PROJECT.
        option.textContent = `${p.index}. ${p.name}`;
        return option;
      }),
    );
    select.hidden = false;
    $("opendrive").hidden = false;
    $<HTMLButtonElement>("opendrive").disabled = projects.length === 0;

    status(
      `${connected.name}: ${projects.length} project${projects.length === 1 ? "" : "s"} on the ` +
        `+Drive. Pick one and press Open slot — the project loaded on the instrument is untouched.`,
      "ok",
    );
  } catch (error) {
    drive?.connected.close();
    drive = undefined;
    status(
      error instanceof DeviceSourceError ? error.message : `Could not browse: ${String(error)}`,
      "error",
    );
  }
}

/**
 * Open the selected slot.
 *
 * **Read-only, and the page says so rather than merely meaning it.** A write goes to the device's
 * *active* project, so edits made to slot 47 would land in slot 3 — silently, because a write to an
 * occupied slot is not acknowledged. `deviceHandle` is cleared and **Write to device** hidden for
 * exactly that reason. Export produces a real project file.
 */
async function openFromDrive(): Promise<void> {
  if (!drive) return;
  const index = Number($<HTMLSelectElement>("driveprojects").value);
  const project = drive.projects.find((p) => p.index === index);
  if (!project) {
    status("That slot is no longer in the listing. Browse again.", "warn");
    return;
  }

  try {
    status(`Reading ${project.name} from slot ${project.index}…`);
    progress.working(`Reading ${project.name}`);
    const opened = await openDeviceProject(drive.connected, project, (chunks, bytes, total) => {
      if (chunks % 8 !== 0) return;
      if (total) progress.at(bytes, total, `Reading ${project.name}`);
      else progress.working(`Reading ${project.name}`);
      status(
        `Reading ${project.name}: ${describeBytes(bytes)}` +
          (total ? ` of ${describeBytes(total)}` : "") + "…",
      );
    });

    const device = deviceFor(opened.image);
    state.device = device;
    state.session = new Session(opened.image);
    state.selection = [];
    state.bank = 0;
    state.trackFor = undefined;
    // **What makes this project exportable.** The stored file is complete — its own container
    // header, its own payload — so the export needs no donor and inherits nothing from another
    // project. Leaving this unset is what made Export do nothing at all: the button was enabled,
    // the status line said "export to a file", and `exportProject` returned at its first line
    // because there was no file to build one from.
    state.file = opened.manifest
      ? { fileName: `${project.name}.dn2prj`, manifest: opened.manifest, payload: opened.payload, image: opened.image }
      : undefined;
    // No write handle: this is not the project the instrument has open, so there is nothing here
    // that could be written back safely.
    deviceHandle = undefined;

    $("device").hidden = false;
    $("device").textContent = `${device.name} (+Drive slot ${project.index})`;
    $("projname").textContent = device.projectName(opened.image);
    // Disabled when there is no manifest, because a control that is enabled and does nothing is
    // the bug this whole change exists for.
    $<HTMLButtonElement>("export").disabled = state.file === undefined;
    $("reopen").hidden = false;
    $("writedevice").hidden = true;
    render();

    const route = state.file
      ? "Read-only: export to a file, because a write would go to whichever project the instrument currently has loaded."
      : "Export is unavailable: the device did not answer with its firmware version, and a project " +
        "file's manifest has to carry a real one. Reconnect and open the slot again.";
    status(
      `${project.name} open from slot ${project.index} — ${opened.bytes.length.toLocaleString()} ` +
        `bytes, the complete stored project with no donor. ${route}`,
      state.file ? "ok" : "warn",
    );
  } catch (error) {
    status(
      error instanceof DeviceSourceError ? error.message : `Could not open the slot: ${String(error)}`,
      "error",
    );
  } finally {
    progress.done();
  }
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

// --- a device as a source ---------------------------------------------------------------------

/**
 * Read a project off a connected instrument and open it exactly as if it were a file.
 *
 * Everything downstream is unchanged. `load` and this share the same four lines of state because
 * they produce the same thing: an image, a device kind, and a session to edit it in.
 */
async function loadFromDevice(): Promise<void> {
  let connected: ConnectedDevice;
  status("Looking for an instrument…");
  try {
    connected = await chooseDevice();
  } catch (error) {
    status(
      error instanceof DeviceSourceError ? error.message : `MIDI refused: ${String(error)}`,
      "error",
    );
    return;
  }

  // **Checked first, because it depends on nothing.** Every donor this page can produce is a
  // Digitone II blank, so a Digitone 1 cannot be read here whether or not a template turns up —
  // and asking for one first is how a DN1 user came to be told "No template available" while the
  // server was sitting there serving one. An error names what is actually wrong; ordering the
  // checks by what they depend on is what makes that possible.
  //
  // And for a Digitone 1 the answer is not a better donor. **Browse +Drive needs none at all**: it
  // reads the complete stored project, any slot, verified byte-for-byte against Elektron's own
  // export. So this points there rather than apologising.
  if (connected.productId === ProductId.DN1) {
    connected.close();
    status(
      `${connected.name} is a Digitone 1, and reading one here needs a Digitone 1 project to ` +
        `supply the bytes no dump carries — which this page cannot produce. Use Browse +Drive ` +
        `instead: it reads the whole stored project and needs no donor at all.`,
      "error",
    );
    return;
  }

  // The donor supplies the 0.49% no dump carries — header, song table, slot array. A
  // device-authored blank is the right one: it contributes an *empty* song table. There is always
  // one, so this can no longer refuse — see `donor.ts` for the order it tries.
  const donor = await loadDonor({ onProblem: (message) => status(message, "warn") });

  // Belt and braces: a picked or served template could be anything, and a DN1 donor for a DN2 read
  // would produce an image that is neither.
  const donorKind = deviceFor(donor.project.image).kind;
  if (donorKind !== "dn2") {
    connected.close();
    status(
      `The donor available is a ${donorKind.toUpperCase()} project and ${connected.name} needs a ` +
        `Digitone II one. Open a Digitone II project file first.`,
      "error",
    );
    return;
  }

  try {
    status(`Reading ${connected.name} with ${describeDonor(donor)} as the donor — this takes about a minute…`);
    const { image, handle } = await readProject(connected, donor.project.image, (done, total, label) => {
      // A real bar: the plan is 257 objects and it is counted before the first request.
      progress.at(done, total, `Reading ${connected.name}`);
      // Every object, because a minute of silence is indistinguishable from a stall.
      if (done % 8 === 0 || done === total) status(`Reading ${connected.name}: ${done}/${total} — ${label}`);
    });

    const device = deviceFor(image);
    // The donor's manifest is what an export writes out, so the project that supplied the bytes is
    // the one that has to carry the file's identity too.
    state.file = donor.project;
    state.device = device;
    state.session = new Session(image);
    state.selection = [];
    state.bank = 0;
    state.trackFor = undefined;
    deviceHandle = handle;

    $("device").hidden = false;
    $("device").textContent = `${device.name} (live)`;
    $("projname").textContent = device.projectName(image);
    $<HTMLButtonElement>("export").disabled = false;
    $("reopen").hidden = false;
    $("writedevice").hidden = false;
    $<HTMLButtonElement>("writedevice").disabled = true;
    render();

    status(
      handle.problems.length > 0
        ? `${connected.name} read with problems: ${handle.problems.join("; ")}. Read again before editing.`
        : `${connected.name} open. Edits stay here until you press Write to device.`,
      handle.problems.length > 0 ? "warn" : "ok",
    );
  } catch (error) {
    connected.close();
    status(`Could not read the device: ${String(error)}`, "error");
  } finally {
    progress.done();
  }
}

/**
 * Send the edits back — only the records that changed.
 *
 * A move is two messages, a rename one. The alternative, writing the image back, is 14.6 MB and
 * minutes of transfer to change one slot.
 *
 * **Every step of the sequence lives in `safeWriteRecords`, not here.** This button used to
 * overwrite patterns on a live instrument the moment it was pressed: no copy of what was there, no
 * question, and no check that the bytes landed. All three now happen on the way past, and this
 * function's whole job is to draw the bar and report what came back.
 */
async function writeToDevice(): Promise<void> {
  const handle = deviceHandle;
  const session = state.session;
  if (!handle || !session) return;

  const button = $<HTMLButtonElement>("writedevice");
  button.disabled = true;
  try {
    status("Working out what changed…");
    const result = await writeBack(handle, session.image, {
      onBackup: downloadBackup((message) => status(message)),
      confirm: confirmRecordWrite,
      onStatus: (message) => status(message),
      onProgress: (done, total, stage) => {
        // Named, because three reads and a write in sequence look identical on a bar that only
        // counts — and the backup pass runs before anything has been sent, which is the one a
        // person most wants to be able to tell apart.
        progress.at(done, total, STAGE_LABEL[stage]);
        status(`${STAGE_LABEL[stage]} ${done}/${total}`);
      },
    });

    if (result.cancelled) {
      status("Write cancelled — nothing was sent.", "warn");
      return;
    }

    const message = recordWriteMessage(result);
    status(message.text, message.level);

    // Only when the device demonstrably holds what we sent. The baseline used to move on the
    // strength of having transmitted, so a write that did not land would have been diffed away and
    // never offered again — the failure would have erased its own evidence.
    if (result.verified) handle.original = Uint8Array.from(session.image);
  } catch (error) {
    status(`The write stopped: ${String(error)}`, "error");
  } finally {
    progress.done();
    button.disabled = false;
  }
}

/**
 * Write the working image out as a project file.
 *
 * **Nothing here returns quietly.** The old first line was `if (!file || !session || !device)
 * return;`, and a project opened from the +Drive hit it every time — so the button was enabled,
 * the status line invited you to press it, and pressing it did nothing at all. A precondition that
 * fails silently is indistinguishable from a broken feature, and was reported as one.
 */
async function exportProject(): Promise<void> {
  const { file, session, device } = state;
  if (!session || !device) {
    status("Nothing is open to export.", "warn");
    return;
  }
  if (!file) {
    status(
      "This project has no file to build from — it came off the device without a manifest. " +
        "Open it again, or open a project file.",
      "warn",
    );
    return;
  }

  status("Building the project file…");
  const blob = await buildProjectBlob(file, session.image);
  const base = device.projectName(session.image).replace(/[^\w -]/g, "_") || "PROJECT";
  download(blob, `${base}${device.kind === "dn2" ? ".dn2prj" : ".dnprj"}`);
  status(
    `Exported ${base} — ${blob.size.toLocaleString()} bytes. Nothing on the device was touched.`,
    "ok",
  );
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

    void (async () => {
      if (guard && state.session?.canUndo) {
        const ok = await askConfirm({
          title: `Open ${file.name}?`,
          body: [
            "This discards the edits made to the open project, and its undo history with them.",
            "Nothing has been written to disk yet — export first if you want to keep them.",
          ],
          confirmLabel: "Discard and open",
          danger: true,
        });
        if (!ok) {
          // Clear it, or picking the same file again fires no change event and looks broken.
          input.value = "";
          status("Cancelled — the open project is untouched.");
          return;
        }
      }

      await load(file);
    })()
      .catch(report)
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
    if (!drag.dragging) return;
    drag.repaintHovered(event);
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
