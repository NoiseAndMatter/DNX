/**
 * Wiring: pick files, replan when an option changes, export.
 *
 * Deliberately thin. Planning lives in `src/expand`, conversion in `src/expand/convert.ts`,
 * rendering in `render.ts`, and file handling in `project.ts` — this only holds the state
 * the page needs and connects the three.
 */

import { convertProject } from "@noiseandmatter/dnx-core/expand/convert.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "@noiseandmatter/dnx-core/expand/plan.js";
import { mintProjectId, projectName, writeProjectId, writeProjectName } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { readProjectName } from "@noiseandmatter/dnx-core/project/dn1.js";
import type { ExpansionPlan } from "@noiseandmatter/dnx-core/expand/types.js";
import {
  buildProjectBlob,
  fetchServedTemplate,
  openProject,
  type LoadedProject,
} from "../project.js";
import { saveFile, savedTone, whereSaved } from "../dnxfolder.js";
import { describeDonor, loadDonor } from "../donor.js";
import { Source } from "./source.js";
import { Destination, describeOrigin } from "./destination.js";
import { Instrument } from "./instrument.js";
import { sourceBadge } from "./sourcename.js";
import { renderPlan } from "../render.js";
import { $, escapeHtml } from "../dom.js";
import { countOccupiedIn, patternSlotView, type SlotView } from "../slotview.js";
import { statusBar } from "../statusbar.js";
import { progressBar } from "../progress.js";
import { renderToolNav } from "../toolnav.js";
import { type DeviceProjectHandle, DeviceSourceError } from "../devicesource.js";
import { recordWriteMessage } from "@noiseandmatter/dnx-core/device/safewrite.js";
import { type DriveProject } from "@noiseandmatter/dnx-core/device/drive.js";
import {
  type ExpanderOptions,
  type MergeOverrides,
  type PlanOutcome,
  offerLabel,
  planFor,
  planSelected,
  planWhole,
  renderDescribed,
  reportScope,
} from "./planning.js";
import { patternName, stampedProjectName as stampedName } from "@noiseandmatter/dnx-core/project/naming.js";
import {
  GridDrag,
  bankSlots,
  renderBanks,
  renderGrid as renderSlots,
} from "../grid.js";
import { nextSelection } from "../selection.js";
import { DN1_DEVICE, DN2_DEVICE, deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import { type LandingMode, describeLanding } from "@noiseandmatter/dnx-core/expand/landing.js";
import {
  type Landing,
  allSlots,
  describeSlots,
  landingFits,
  landingSlots,
  pendingSources,
} from "./drop.js";
import { ProductId } from "@noiseandmatter/dnx-core/sysex/devices.js";

/**
 * The page's status bar.
 *
 * Bound once, after the imports rather than between them, and after the DOM is parsed — this is a
 * module script at the end of the body. Module-level work that throws takes every listener below
 * it with it, which this page has been bitten by before.
 */
const status = statusBar();
const progress = progressBar();

// Drawn rather than written into the HTML, so the row cannot say different things on different
// pages. Immediately, because a navigation control that appears late is one you click through.
renderToolNav($("toolnav"), "expander");

/**
 * The Digitone 1 project being expanded — **an image and what to call it, and nothing else.**
 *
 * It was typed as a whole `LoadedProject`, and every one of the fourteen places that touched it
 * used `.image`. That extra requirement was not free: it meant a source had to arrive with a
 * manifest and a payload, which a file has and **an instrument does not** — the +Drive sends no
 * `manifest.json` at all. So the type was quietly the reason you could not expand from a connected
 * Digitone 1, and narrowing it to what is actually read is most of what made that possible.
 *
 * The destination keeps its full project, because that one really is written back out and its
 * manifest really is used.
 */
interface State {
  template?: LoadedProject;
  plan?: ExpansionPlan;
}

const state: State = {};

/**
 * Which source patterns to merge, **in click order** — that order is the landing order.
 *
 * A list rather than a set, because "these four, in this order" is the question being asked and a
 * set would answer a different one.
 */
const selection: number[] = [];

/** Whole-project conversion, or a merge of selected patterns into a project already in use. */
function merging(): boolean {
  return $<HTMLInputElement>("modeSelect").checked;
}

/** The Digitone II this page talks to. Its counterpart for the Digitone 1 is `source`. */
const instrument = new Instrument({ progress, onStatus: (message) => status(message) });

/**
 * The bytes a plan produced, waiting for **Apply**.
 *
 * One field rather than one per mode: `writeChangedRecords` diffs it against what the device gave
 * us and sends the difference, so a whole conversion and a four-pattern merge are the same
 * operation by the time they reach the wire. `undefined` means there is nothing to apply, which is
 * how the button knows to stay disabled.
 *
 * It used to sit on the device state as `planned`, which read as something the instrument
 * holds. It is not: it is planning's output, and the instrument may not even be connected.
 */
let planned: Uint8Array | undefined;

/**
 * The Digitone II being expanded into.
 *
 * `destination.ts` owns what it is and what may be done to it — including that origin decides
 * whether a write may go back at all. The page owns drawing it, and the two device reads that
 * produce one, which need a connection.
 */
const destination = new Destination<DeviceProjectHandle>(() => {
  renderDestination();
  landingChanged();
});


/** The options panel, read off the page. The only planning input this page owns. */
function options(): ExpanderOptions {
  return {
    compactPerPattern: $<HTMLInputElement>("compact").checked,
    useFreedMidiTracks: $<HTMLInputElement>("freeMidi").checked,
    aggregateByName: $<HTMLInputElement>("aggregate").checked,
    ...($<HTMLInputElement>("rules").checked ? { rules: PERCUSSION_LOW_RULES } : {}),
  };
}



function replan(): void {
  if (!source.image) return;
  state.plan = planExpansion(source.image, options());
  // The device path needs a source too, and a project can be loaded either side of connecting.
  $<HTMLButtonElement>("fromDevice").disabled = !instrument.connected;
  // Which patterns are live depends on the options, so the picker follows them. Selections that
  // are no longer live are dropped rather than silently planned.
  for (let i = selection.length - 1; i >= 0; i--) {
    if (!state.plan.livePatterns.includes(selection[i]!)) selection.splice(i, 1);
  }
  renderSource();
  // Rendered after the pruning above, so the report never describes a selection that has just
  // stopped being live.
  renderReport();
  // The options changed what would be written, so any plan already on screen is now describing
  // something else — and so is the grid, because `Contiguous` changes where patterns land and the
  // pruning above can change which ones there are. Recomputed locally; nothing is sent.
  landingChanged();
}

/** Draw the sounds-on-tracks report. The *scope* decision lives in `planning.ts`. */
function renderReport(): void {
  const image = source.image;
  if (!image) return;

  const { patterns, heading } = reportScope({
    merging: merging(),
    merged: destination.merged,
    selection,
  });
  $("reportScope").textContent = heading;

  if (!merging()) {
    $("plan").innerHTML = renderPlan(state.plan ?? planExpansion(image, options()));
    return;
  }
  $("plan").innerHTML = patterns
    ? renderPlan(planFor(image, patterns, options()))
    : `<p class="hint">Select patterns and drag them onto the destination — this will show how ` +
      `their sounds are laid out.</p>`;
}

/**
 * The Digitone 1 being expanded.
 *
 * The page owns the *reaction* to a source arriving — the badge, the replan, the grid — and
 * `source.ts` owns everything about getting one. That split is why the family check, the stale
 * listing and the slot-naming rule are not in this file.
 */
const source = new Source({
  progress,
  onChange(loaded) {
    replan();
    $("sourceInfo").hidden = false;
    $("sourceInfo").textContent = sourceBadge(readProjectName(loaded.image), loaded.label);
    status(`Loaded ${loaded.label}. Pick a destination, then drag patterns onto it.`);
  },
  onStatus: (message) => status(message),
});

async function connectSource(): Promise<void> {
  await source.connect();
  $<HTMLButtonElement>("browseSource").disabled = false;
}

async function browseSourceDrive(): Promise<void> {
  const projects = await source.listProjects();

  const select = $<HTMLSelectElement>("sourceProjects");
  select.innerHTML = projects
    .map((p) => `<option value="${p.index}">${escapeHtml(`${p.index}. ${p.name}`)}</option>`)
    .join("");
  select.hidden = projects.length === 0;
  $("openSource").hidden = projects.length === 0;
  $<HTMLButtonElement>("openSource").disabled = projects.length === 0;

  status(
    projects.length === 0
      ? "That instrument reports no stored projects."
      : `${projects.length} project(s). Pick one and open it.`,
  );
}

const openSourceSlot = (): Promise<void> =>
  source.openSlot(Number($<HTMLSelectElement>("sourceProjects").value));

async function loadTemplate(file: File): Promise<void> {
  status(`Reading template ${file.name}…`);
  useTemplate(await openProject(file), true);
  status(`Template ${file.name} ready.`);
}

/**
 * Adopt a Digitone II project.
 *
 * It plays two roles and they are not in tension: it is the **donor** every device read needs for
 * the ~0.49% no dump carries, and — when picked deliberately rather than found on the server — it
 * is a **destination** to merge into. The third way to fill one, beside a blank and a device.
 */
function useTemplate(template: LoadedProject, asDestination: boolean): void {
  state.template = template;
  if (asDestination) {
    destination.fill({
      image: Uint8Array.from(template.image), origin: "file", label: template.fileName, merged: [], project: template,
    });
  }
}

/**
 * Take the template from the local server when there is one.
 *
 * `npm run web` can find `EMPTY.dn2prj` the way every other command does; the browser cannot
 * read a folder, so it asks. Served as static files this simply finds nothing and the picker
 * below it stays the way in — no build-time switch, one page either way.
 */
async function adoptServedTemplate(): Promise<void> {
  let served: LoadedProject | undefined;
  try {
    served = await fetchServedTemplate();
  } catch (error) {
    // A template that is there but unreadable is worth one sentence on load. Silence here is what
    // let a broken donor look like a missing one for a whole session.
    status(
      `The local server offered a template that could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}. Pick one by hand.`,
      "warn",
    );
    return;
  }
  if (!served) return;
  // Found on the server: the donor, not a destination. Choosing a destination stays deliberate.
  useTemplate(served, false);
  status(`Template ${served.fileName} loaded automatically. Pick a Digitone 1 project.`);
}


function wireFilePicker(inputId: string, load: (file: File) => Promise<void>): void {
  $<HTMLInputElement>(inputId).addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    load(file).catch((error: unknown) => status(String(error instanceof Error ? error.message : error), "error"));
  });
}

wireFilePicker("sourceFile", (file) => source.fromFile(file));
wireFilePicker("templateFile", loadTemplate);
for (const id of ["compact", "freeMidi", "rules", "aggregate", "contiguous"]) $(id).addEventListener("change", replan);
for (const id of ["modeWhole", "modeSelect"]) $(id).addEventListener("change", syncMode);

syncMode();
status("Pick a Digitone 1 project, and a Digitone II project to use as the template.");
void adoptServedTemplate();

// --- the working destination ------------------------------------------------------------------
//
// **The destination is a project this page holds**, not a device read. That distinction is the
// whole of this section.
//
// It used to be "whatever the instrument has loaded": read fresh, merged once, written. Two things
// that does not cover, and both are real ways people work:
//
//   1. No Digitone II present at all. Expand a few patterns into a blank project and export a file.
//   2. More than one merge. Take four patterns, then four more, then some from another project.
//
// So the destination is filled from a blank, a file or a device, merges **accumulate** into it, and
// it is delivered either way — exported as a `.dn2prj` or written to the instrument.
//
// ## The device write stays correct across repeated merges
//
// `DeviceProjectHandle.original` holds what the instrument gave us, and `writeChangedRecords` diffs
// against that. So however many merges went into the working project, the write sends everything
// that differs from what is actually on the device — not only the last one.
//
// ## Why a device destination is still read rather than assumed blank
//
// A dump write lands in the **active** project, so the baseline must be the live state. And
// expansion is a transplant: a field nobody writes inherits the destination's value, so the
// destination has to be the real one.


$("connectSource").addEventListener("click", () => {
  connectSource().catch(reportDeviceError);
});

$("browseDestination").addEventListener("click", () => {
  browseDestinationDrive().catch(reportDeviceError);
});

$("openDestination").addEventListener("click", () => {
  openDestinationSlot().catch(reportDeviceError);
});

$("browseSource").addEventListener("click", () => {
  browseSourceDrive().catch(reportDeviceError);
});

$("openSource").addEventListener("click", () => {
  openSourceSlot().catch(reportDeviceError);
});

$("connect").addEventListener("click", () => {
  connect().catch(reportDeviceError);
});

$("fromBlank").addEventListener("click", () => {
  fillFromBlank().catch(reportDeviceError);
});

$("fromDevice").addEventListener("click", () => {
  readDestination().catch(reportDeviceError);
});

$("applyMerge").addEventListener("click", () => {
  applyToDestination();
});

$("undoApply").addEventListener("click", () => {
  undoApply();
});

$("exportDestination").addEventListener("click", () => {
  exportDestination().catch(reportDeviceError);
});

$("writeDevice").addEventListener("click", () => {
  writeToDevice().catch(reportDeviceError);
});

/**
 * Start from an empty Digitone II project.
 *
 * The template the page already has — served by `npm run web`, or picked as a file — is exactly the
 * right blank: it is device-authored, so it contributes an *empty* song table rather than another
 * project's. Same reasoning the device read uses it for.
 */
async function fillFromBlank(): Promise<void> {
  const donor = await loadDonor({ picked: state.template, onProblem: (message) => status(message, "warn") });
  // Remembered so the export at the end of this journey carries the manifest of the very project
  // the destination was built from, rather than asking for a donor a second time.
  state.template = donor.project;

  destination.fill({
    image: Uint8Array.from(donor.project.image),
    origin: "blank",
    label: donor.project.fileName,
    merged: [],
    project: donor.project,
  });
  status(`Destination: a blank project from ${describeDonor(donor)}. Merge into it, then export.`);
}

/** Draw the destination. The *meaning* of an origin lives in `destination.ts`. */
function renderDestination(): void {
  const open = destination.open;
  const info = $("destinationInfo");

  if (!open) {
    info.textContent = "— no destination yet";
  } else {
    info.textContent = `— ${projectName(open.image)} · ${describeOrigin(open.origin)}`;
    const badge = $("destinationBadge");
    badge.hidden = false;
    // The label for the two that came off an instrument; otherwise just what kind it is.
    badge.textContent =
      open.origin === "device" || open.origin === "drive" ? open.label : open.origin;
  }

  $<HTMLButtonElement>("exportDestination").disabled = open === undefined;
  $<HTMLButtonElement>("undoApply").disabled = !destination.canUndo;
  // Writing needs a device baseline. A blank, a file or a +Drive project has none, and the button
  // says so by being unavailable rather than by failing at the point of sending.
  $<HTMLButtonElement>("writeDevice").disabled = !destination.writable;
}

/**
 * Read the instrument's loaded project as the destination. **Once.**
 *
 * Reading takes about a minute, and it was once welded to planning — so changing the landing slot
 * meant reading the whole project again to find out whether the new slot was any better. Choosing
 * blind and paying a minute to discover the answer is the wrong way round.
 */
async function readDestination(): Promise<void> {
  const donor = await loadDonor({
    picked: state.template,
    onProblem: (message) => status(message, "warn"),
  });
  const { image, handle, name } = await instrument.readActive(
    donor.project.image,
    describeDonor(donor),
  );

  destination.fill({ image, origin: "device", label: name, handle, merged: [] });
  status(
    handle.problems.length > 0
      ? `Read with problems: ${handle.problems.join("; ")}. Read again before writing.`
      : `${name} read. Merge into it, then write it back.`,
  );
}

/**
 * Work out what the merge would do, and paint it.
 *
 * `overrides` is consent the user has just given by pressing the button an `offer` rendered. It is
 * an **argument and not state** on purpose: it lives for exactly this call, so every other route
 * into a replan — a click on a pattern, a new landing slot, a toggled option — runs with none, and
 * agreeing to overwrite one slot can never quietly authorise overwriting another.
 */
function replanForDevice(overrides: MergeOverrides = {}): void {
  if (!destination.open || !source.image) return;

  // **Nothing selected is a resting state, not a refusal.** It is where the page sits when a
  // project has just opened and, since the fix in `applyToDestination`, immediately after a merge
  // lands. `planSelected` throws `no patterns selected` for it, which is the right answer to
  // "plan this" and the wrong thing to paint red across the panel the moment an apply succeeds.
  if (merging() && selection.length === 0) {
    planned = undefined;
    $<HTMLButtonElement>("applyMerge").disabled = true;
    $("devicePlan").innerHTML = "";
    return;
  }

  let outcome: PlanOutcome;
  try {
    outcome = merging()
      ? planSelected({
          source: source.image,
          destination: destination.open.image,
          selection,
          landing,
          landingMode: landingMode(),
          options: options(),
          overrides,
        })
      : planWhole({
          source: source.image,
          destination: destination.open.image,
          ...(destination.open.baseline === undefined ? {} : { baseline: destination.open.baseline }),
          ...(state.plan === undefined ? {} : { plan: state.plan }),
          overrides,
        });
  } catch (error) {
    // A refusal is a normal outcome of choosing a slot, not an error to shout about. It belongs
    // where the plan would have been, and the apply button has to go with it.
    planned = undefined;
    $<HTMLButtonElement>("applyMerge").disabled = true;
    const message = error instanceof Error ? error.message : String(error);
    $("devicePlan").innerHTML = `<p class="bad">${escapeHtml(message)}</p>`;
    status(message, "error");
    return;
  }

  planned = outcome.image;
  $("devicePlan").innerHTML = renderDescribed(outcome.described);
  $<HTMLButtonElement>("applyMerge").disabled = planned === undefined;

  // A refusal that can be lifted gets the button that lifts it, right under the sentence explaining
  // why. This replaces a `window.confirm` that asked the same question mid-plan — which blocked the
  // renderer, and which asked it again on every replan because nothing remembered the answer.
  //
  // Pressing it plans again with the consent it carries. Nothing else is stored, so walking away
  // from the question — picking another landing slot, deselecting a pattern — simply cancels it.
  if (outcome.offer) {
    const offer = outcome.offer;
    const lift = document.createElement("button");
    lift.type = "button";
    lift.className = "btn danger";
    lift.textContent = offerLabel(offer.kind);
    const row = document.createElement("div");
    row.className = "ops offerrow";
    row.append(lift);
    $("devicePlan").append(row);
    lift.addEventListener("click", () => replanForDevice(offer.overrides));
  }

  status(outcome.message, outcome.level);
}

/**
 * Fold the planned result into the destination.
 *
 * **Explicit, and separate from the preview.** The plan recomputes as you type a landing slot or
 * click a pattern; if that also mutated the accumulating project, choosing would be
 * indistinguishable from committing.
 */
function applyToDestination(): void {
  if (!destination.open || !planned) return;
  const image = planned;
  const landed = merging() ? [...selection] : (state.plan?.livePatterns ?? []);

  // **The selection is cleared before the apply, not after.** `destination.apply` calls `onChange`
  // synchronously, which replans — and a replan that still sees these patterns plans them onto the
  // slots they have just landed in, finds those slots occupied, and asks the user to confirm
  // overwriting their own merge. That dialog was reported as a hang: it is a native `confirm`, so
  // it blocks the renderer until somebody answers a question about work they already approved.
  //
  // Clearing first is not bookkeeping tidiness. A pattern that has landed is no longer pending, and
  // leaving it selected is what made the page believe the merge was still owed.
  selection.length = 0;
  planned = undefined;

  // The plan described a change *from* the old destination. Once it *is* the destination, the same
  // plan is a no-op — so applying recomputes rather than leaving something untrue on screen, which
  // `Destination`'s onChange does for the first two and this does for the report.
  destination.apply(image, landed, merging() ? "merge" : "whole");
  renderSource();
  renderReport();
  status(`Applied. ${destination.whatNext()}`);
}

function undoApply(): void {
  if (!destination.canUndo) return;
  destination.undo();
  renderReport();
  status("Undone — back to the destination as it was before the last apply.");
}

/**
 * Export the working destination as a `.dn2prj`.
 *
 * The route journey 2 exists for: a Digitone 1 and no Digitone II, expand into a blank project and
 * take a file away.
 */
async function exportDestination(): Promise<void> {
  if (!destination.open) return;
  /*
   * **The destination's own project first.** Export needs a manifest and a container header, and it
   * used to take both from the donor even when the destination came off a +Drive with its own:
   * COREVAULT, read from a stock 1.11 Digitone II, exported as Payload EMPTY, FirmwareVersion 1.10E,
   * around a 1.11-sized image. The donor is only the fallback now, for a destination with no file
   * behind it: a device read, or a +Drive project whose instrument did not give its firmware.
   */
  const own = destination.open.project;
  const donor = own ? undefined : await loadDonor({ picked: state.template, onProblem: (message) => status(message, "warn") });
  const template = own ?? donor!.project;

  const image = Uint8Array.from(destination.open.image);
  // A project authored here is a new project and gets its own identity rather than inheriting the
  // template's — otherwise every file exported claims to be the template.
  writeProjectId(image, mintProjectId());

  const named = $<HTMLInputElement>("destinationName").value.trim();
  if (named) writeProjectName(image, stampedName(named));

  const base = projectName(image) || "EXPANDED";
  // The payload is named after the project it now holds, not after the file it was built from.
  const saved = await saveFile(
    await buildProjectBlob({ ...template, manifest: { ...template.manifest, Payload: base } }, image),
    `${base.replace(/[^A-Za-z0-9 _-]/g, "_")}.dn2prj`,
    "exports",
  );
  status(`Exported ${base} to ${whereSaved(saved)}.`, savedTone(saved));
}

/**
 * Send everything merged so far to the project loaded on the instrument.
 *
 * **The question used to be asked here, and it said less than the write did.** It named no slots,
 * no count, and could not mention that somebody had been playing on the device since the project
 * was read — because at that point nothing had asked the device. It now comes from
 * `safeWriteRecords` by way of `confirmRecordWrite`, after the destination has been read back, so
 * it describes the write that is actually about to happen. Two pages asking two different questions
 * about the same operation was the problem, not the wording of either.
 */
async function writeToDevice(): Promise<void> {
  const open = destination.open;
  if (!open?.handle) return;
  const handle = open.handle;

  $<HTMLButtonElement>("writeDevice").disabled = true;
  try {
    // Diffed against what the instrument gave us, not against the last merge — so every change
    // accumulated in the working project is sent, however many applies went into it.
    const outcome = await instrument.write(handle, open.image);
    if (outcome.cancelled) {
      status("Not written.");
      return;
    }
    const message = recordWriteMessage(outcome);
    status(message.text, message.level);
  } catch (error) {
    status(`The write stopped: ${String(error)}`, "error");
  } finally {
    renderDestination();
  }
}





function reportDeviceError(error: unknown): void {
  const message = error instanceof DeviceSourceError || error instanceof Error ? error.message : String(error);
  status(message, "error");
  $("devicePlan").innerHTML = `<p class="bad">${escapeHtml(message)}</p>`;
}

async function connect(): Promise<void> {
  const name = await instrument.connect();
  $<HTMLButtonElement>("fromDevice").disabled = false;
  // Browsing needs only the connection — unlike reading the active project, which is what the
  // expansion goes into and therefore waits for a source.
  $<HTMLButtonElement>("browseDestination").disabled = false;
  status(`${name} connected. Load a Digitone 1 project, then plan.`);
}

async function browseDestinationDrive(): Promise<void> {
  const projects = await instrument.listProjects();

  const select = $<HTMLSelectElement>("destinationProjects");
  select.innerHTML = projects
    .map((p) => `<option value="${p.index}">${escapeHtml(`${p.index}. ${p.name}`)}</option>`)
    .join("");
  select.hidden = projects.length === 0;
  $("openDestination").hidden = projects.length === 0;
  $<HTMLButtonElement>("openDestination").disabled = projects.length === 0;

  status(
    projects.length === 0
      ? "That instrument reports no stored projects."
      : `${projects.length} project(s). Pick one — it becomes the destination, and you export it ` +
        `rather than writing it back.`,
  );
}

async function openDestinationSlot(): Promise<void> {
  const { image, label, slot, project } = await instrument.openSlot(
    Number($<HTMLSelectElement>("destinationProjects").value),
  );
  // **No handle, deliberately.** `Destination.writable` is the handle's presence and nothing else,
  // so withholding it here is what keeps a write from landing in the instrument's active project.
  destination.fill({ image, origin: "drive", label, merged: [], ...(project ? { project } : {}) });
  status(
    `Open as the destination. Merge into it and export — a write would go to the instrument's ` +
      `active project, not back to slot ${slot}.`,
  );
}

/**
 * Whole-project conversion: every live pattern, and the destination replaced.
 *
 * The destination is still read and used as the template — expansion is a transplant, and a field
 * nobody writes inherits the destination's value.
 */
// --- the two grids ------------------------------------------------------------------------------
//
// Source on the left, destination on the right, and the same grid the manager uses for both.
//
// This page used to pick patterns from a row of pills and type a landing slot into a text box —
// two tools answering *"which slots?"* in two different languages, and the typed one made you
// choose blind. Now you select on the left and **drag onto the slot you want**, with occupancy,
// names and conflicts visible before the drop.
//
// Everything visual comes from `dnx.css` and `grid.ts`. Nothing here draws a cell.

/** Which bank each grid is showing. Independent: the source's A is not the destination's A. */
let sourceBank = 0;
let destinationBank = 0;

/**
 * Drag from the source grid onto the destination grid.
 *
 * The drop **chooses the landing slot** — that is the whole gesture. What lands is the current
 * selection, in click order, starting at the slot dropped on.
 *
 * Refused rather than allowed for anything else: dropping inside one grid means nothing here, and
 * a gesture that silently does nothing is worse than one the browser marks as impossible.
 */
const drag = new GridDrag({
  onDragStart(grid, index) {
    if (grid !== "source") return [];
    // Dragging an unselected pattern drags just that one, and takes the selection with it so the
    // two never disagree about what is happening.
    if (!selection.includes(index)) {
      selection.length = 0;
      selection.push(index);
      renderSource();
      renderReport();
    }
    return [...selection];
  },

  hintFor(from, grid, index) {
    if (from.grid !== "source" || grid !== "destination" || from.indices.length === 0) return undefined;
    if (!destination) return undefined;

    // The real destinations, not a contiguous run from the cursor. With relative landing the two
    // are different sets, and counting the run would report the untouched slots *between* the
    // patterns as about to be overwritten — a warning about work that is not going to happen.
    const aimed: Landing = { selection: from.indices, landing: index, mode: landingMode() };
    // Refused rather than drawn as a partial drop: the merge refuses the whole landing, so a hint
    // offering it would be promising something Apply will not do.
    if (!landingFits(aimed)) return undefined;
    const slots = allSlots(aimed);

    const occupied = slots.filter(occupiedAt).length;
    return {
      action: "move",
      label: occupied > 0 ? `MERGE · ${occupied} occupied` : "MERGE",
      status:
        `${from.indices.length} pattern(s) → ${describeSlots(slots)}` +
        (occupied > 0 ? ` · ${occupied} slot(s) already hold a pattern` : " · all empty"),
    };
  },

  onDrop(from, grid, index) {
    if (from.grid !== "source" || grid !== "destination") return;
    landing = index;
    // **The redraw is the whole bug.** Clicking a destination slot re-rendered the grid, so the
    // marker moved; dropping on one did not, so the only visible effect of a drag was a line of
    // text far down the page. The gesture worked and looked like it had done nothing, which is
    // indistinguishable from broken — and was reported as exactly that.
    landingChanged();
    const slots = allSlots({ selection, landing: index, mode: landingMode() });
    status(
      `${selection.length} pattern(s) will land in ${describeSlots(slots)}, ` +
        `${describeLanding(landingMode())}. Press Apply to write them.`,
    );
  },

  onStatus: (message) => {
    status(message);
  },
});

/** Where the selection would land. Set by a drop, never typed. */
let landing = 0;

function occupiedAt(slot: number): boolean {
  const open = destination.open;
  return open !== undefined && DN2_DEVICE.summarise(open.image, slot).occupied === true;
}

/**
 * Name a set of destination slots without pretending it is a range.
 *
 * `A1…A3` is the honest description of three consecutive slots and a lie about A1, A9, A10 — it
 * claims eight slots are involved that are not. Consecutive runs still read as a range because
 * that is genuinely shorter; anything else is listed.
 */
/**
 * The source grid: a Digitone 1's 128 patterns, in banks.
 *
 * Every pattern is shown rather than only the live ones. The bank counts say where the music is,
 * which is the same answer the old "live patterns only" list gave — but in the layout the rest of
 * the application uses, and without hiding the empty slots that make a bank legible.
 */
function renderSource(): void {
  const image = source.image;
  const grid = $("sourceGrid");
  const tabs = $("sourceTabs");
  if (!image) {
    grid.hidden = true;
    tabs.hidden = true;
    return;
  }
  grid.hidden = false;
  $("sourceEmpty").hidden = true;

  const live = new Set(state.plan?.livePatterns ?? []);
  renderBanks(tabs, {
    patternCount: DN1_DEVICE.patternCount,
    current: sourceBank,
    countOccupied: (bank) => countOccupiedIn(bank, DN1_DEVICE, image, live),
    onSelect: (bank) => {
      sourceBank = bank;
      renderSource();
    },
  });

  renderSlots(
    grid,
    // `live` rather than the record: a pattern the plan will not carry reads as empty even when
    // the DN1 has trigs in it, which is the one real difference between the two grids.
    bankSlots(sourceBank, DN1_DEVICE.patternCount, (index) => patternSlotView(DN1_DEVICE, image, index, live)),
    {
      selected: selection,
      onClick: (index, event) => {
        const next = nextSelection(selection, anchor, index, event);
        selection.length = 0;
        selection.push(...next.selection);
        anchor = next.anchor;
        renderSource();
        renderReport();
        // The destination too. The selection is what `landingSlots` and `pendingSources` are
        // computed from, so adding a pattern to it adds a landing mark — and this path updated the
        // plan while leaving the grid drawing the marks for the previous selection. The same bug as
        // the Contiguous toggle, through a different door, found by the test written for that one.
        landingChanged();
      },
      drag: { controller: drag, grid: "source" },
    },
  );

  $("sourceSub").textContent =
    selection.length === 0
      ? `— ${live.size} live`
      : `— ${selection.length} selected: ${selection.map(patternName).join(" ")}`;
}

/**
 * **What lands where has changed.** Recompute the plan and repaint the grid — together, always.
 *
 * These two had been written side by side at three call sites and omitted at a fourth. `replan`
 * recomputed and did not repaint, so ticking **Contiguous** updated the plan panel while the grid
 * above it went on drawing the previous positions: two views of one operation, disagreeing, until
 * you dropped the patterns again.
 *
 * That is the failure the shared `landingSlotsFor` was introduced to prevent, arriving by the other
 * door. **Giving a rule one home does not give its invalidation one** — the rule cannot disagree
 * with itself, but a view that never re-asks it can still be wrong, and nothing about a shared
 * function makes anyone remember to repaint.
 *
 * So the pair has a name. Anything that changes the selection, the anchor or the landing mode calls
 * this, and the next option added inherits the fix instead of rediscovering the bug.
 */
function landingChanged(): void {
  renderDestinationGrid();
  replanForDevice();
}

/** The destination grid: the working project, whatever it was filled from. */
function renderDestinationGrid(): void {
  const grid = $("destinationGrid");
  const tabs = $("destinationTabs");
  const open = destination.open;
  if (!open) {
    grid.hidden = true;
    tabs.hidden = true;
    return;
  }
  grid.hidden = false;
  $("legend").hidden = false;

  const image = open.image;
  renderBanks(tabs, {
    patternCount: DN2_DEVICE.patternCount,
    current: destinationBank,
    countOccupied: (bank) => countOccupiedIn(bank, DN2_DEVICE, image),
    onSelect: (bank) => {
      destinationBank = bank;
      renderDestinationGrid();
    },
  });

  renderSlots(
    grid,
    bankSlots(destinationBank, DN2_DEVICE.patternCount, (index) => incomingSlotView(index, image)),
    {
      // The landing slot is shown as the opened cell rather than a selection: nothing is selected
      // in this grid, and marking it says "this is where the drop went" without implying it can be
      // dragged from.
      selected: [],
      ...(merging() ? { opened: landing, landing: landingSlots(currentLanding()) } : {}),
      onClick: (index) => {
        landing = index;
        landingChanged();
      },
      drag: { controller: drag, grid: "destination" },
    },
  );
}

/**
 * How a destination slot reads, **including what is about to be put in it**.
 *
 * A slot with something landing on it shows the incoming pattern's name rather than its own,
 * dimmed, with where it comes from and what it would replace. Until this existed the only sign of
 * a drop was an outline: the cell went on showing the pattern already there, so a gesture that had
 * worked perfectly looked like one that had done nothing — and was reported as broken, reasonably.
 *
 * **The dimming is the tense.** What the cell shows is the future; Apply is what makes it the
 * present, and at that point the same cell renders normally because the merge has really happened.
 * A preview that looked identical to a result would be worse than no preview, because it would
 * claim something had been written when nothing had.
 */
function incomingSlotView(index: number, image: Uint8Array): Omit<SlotView, "index"> {
  const here = patternSlotView(DN2_DEVICE, image, index);
  const incoming = source.image;
  const from = pending().get(index);
  if (from === undefined || !incoming) return here;

  const arriving = patternSlotView(DN1_DEVICE, incoming, from);
  return {
    ...arriving,
    // The cell keeps its own address: it is still H16, whatever is about to be in it.
    id: here.id,
    detail: here.occupied ? `← ${patternName(from)} · replaces ${here.name}` : `← ${patternName(from)}`,
    occupied: true,
    classes: ["pending"],
  };
}

/** How the drop positions the selection: keep their spacing, or pack them from the anchor. */
function landingMode(): LandingMode {
  return $<HTMLInputElement>("contiguous").checked ? "contiguous" : "relative";
}

/**
 * The page's current landing, as `drop.ts` wants it.
 *
 * The four values it needs are spread across this module — two `let`s, a checkbox and a constant —
 * so gathering them in one place is what lets the rules be functions of their arguments instead of
 * of whatever the page happens to be showing.
 */
function currentLanding(): Landing {
  return { selection, landing, mode: landingMode() };
}

/** Which source pattern is destined for which destination slot, or empty when not merging. */
function pending(): Map<number, number> {
  return merging() ? pendingSources(currentLanding()) : new Map();
}

/** Anchor for shift-ranges in the source grid. */
let anchor: number | undefined;

function syncMode(): void {
  renderSource();
  landingChanged();
  renderReport();
}
