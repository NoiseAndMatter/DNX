/**
 * Wiring: pick files, replan when an option changes, export.
 *
 * Deliberately thin. Planning lives in `src/expand`, conversion in `src/expand/convert.ts`,
 * rendering in `render.ts`, and file handling in `project.ts` — this only holds the state
 * the page needs and connects the three.
 */

import { convertProject } from "../../src/expand/convert.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../../src/expand/plan.js";
import { mintProjectId, projectName, writeProjectId, writeProjectName } from "../../src/project/dn2image.js";
import { readProjectName } from "../../src/project/dn1.js";
import type { ExpansionPlan } from "../../src/expand/types.js";
import {
  buildProjectBlob,
  download,
  fetchServedTemplate,
  openProject,
  type LoadedProject,
} from "./project.js";
import { describeDonor, loadDonor } from "./donor.js";
import { renderPlan } from "./render.js";
import { $, escapeHtml } from "./dom.js";
import { countOccupiedIn, patternSlotView, type SlotView } from "./slotview.js";
import { statusBar } from "./statusbar.js";
import { renderToolNav } from "./toolnav.js";
import {
  type ConnectedDevice,
  type DeviceProjectHandle,
  DeviceSourceError,
  connectDevice,
  listDeviceProjects,
  openDeviceProject,
  readProject,
  writeBack,
} from "./devicesource.js";
import { type DriveProject } from "../../src/device/drive.js";
import { describeDeviceExpand, planDeviceExpand } from "../../src/expand/deviceexpand.js";
import {
  MergeRefused,
  describeMerge,
  planPatternMerge,
  type MergeNote,
  type MergePlan,
} from "../../src/expand/merge.js";
import { patternName, stampedProjectName as stampedName } from "../../src/sheet/naming.js";
import {
  GridDrag,
  bankSlots,
  nextSelection,
  renderBanks,
  renderGrid as renderSlots,
} from "./grid.js";
import { DN1_DEVICE, DN2_DEVICE, deviceFor } from "../../src/librarian/device.js";
import { type LandingMode, describeLanding, landingSlotsFor } from "../../src/expand/landing.js";

/** Both families hold 128 patterns; the constants are named so the grids read as intended. */
const DN1_PATTERN_COUNT = 128;
const DN2_PATTERN_COUNT = 128;
import { ProductId } from "../../src/sysex/devices.js";

/**
 * The page's status bar.
 *
 * Bound once, after the imports rather than between them, and after the DOM is parsed — this is a
 * module script at the end of the body. Module-level work that throws takes every listener below
 * it with it, which this page has been bitten by before.
 */
const status = statusBar();

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
interface SourceProject {
  image: Uint8Array;
  /** For the top bar: a file name, or the slot it was read from. */
  label: string;
}

interface State {
  source?: SourceProject;
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

interface DeviceState {
  connected?: ConnectedDevice;
  handle?: DeviceProjectHandle;
  /**
   * The image to write, whichever mode produced it.
   *
   * One field rather than one per mode: `writeChangedRecords` diffs it against what the device gave
   * us and sends the difference, so a whole conversion and a four-pattern merge are the same
   * operation by the time they reach the wire. Undefined means there is nothing to send — which is
   * also how the write button knows to stay disabled.
   */
  image?: Uint8Array;
}

const device: DeviceState = {};

/**
 * What a plan says about itself: the lines that matter, and the conversion notes if it has any.
 *
 * The two are separate all the way to the DOM. Merged into one list they were indistinguishable,
 * and the four lines somebody needs lost to the thousand they do not.
 */
interface Described {
  lines: string[];
  notes?: MergeNote[];
}

interface Destination {
  /** The project as it stands, including every merge applied so far. */
  image: Uint8Array;
  /** What it was filled from, so the page can say so. */
  origin: "blank" | "file" | "device";
  label: string;
  /**
   * The instrument this came from, when it came from one.
   *
   * Carries `original` — the baseline a write diffs against — so accumulated merges all reach the
   * device rather than only the most recent.
   */
  handle?: DeviceProjectHandle;
  /**
   * The image as it was before the last apply.
   *
   * **One step, deliberately.** A full history belongs to the manager's session, which has undo,
   * redo and a log; here the mistake worth covering is the last drop, and a second stack that
   * behaved almost like the manager's would be worse than none.
   */
  previous?: Uint8Array;
  /**
   * Source patterns merged into this destination so far, in the order they landed.
   *
   * The expansion report is about **what is in this project**, not what the source could offer, so
   * it needs to know what actually went in — and nothing else records that.
   */
  merged: number[];
}

let destination: Destination | undefined;


function options() {
  return {
    compactPerPattern: $<HTMLInputElement>("compact").checked,
    useFreedMidiTracks: $<HTMLInputElement>("freeMidi").checked,
    aggregateByName: $<HTMLInputElement>("aggregate").checked,
    ...($<HTMLInputElement>("rules").checked ? { rules: PERCUSSION_LOW_RULES } : {}),
  };
}



function replan(): void {
  if (!state.source) return;
  state.plan = planExpansion(state.source.image, options());
  // The device path needs a source too, and a project can be loaded either side of connecting.
  $<HTMLButtonElement>("fromDevice").disabled = device.connected === undefined;
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

/**
 * An expansion plan for these patterns and the options currently ticked.
 *
 * One helper, because the report and the merge must not disagree: a panel describing one layout
 * beside a button that produces another is worse than no panel.
 */
function planFor(patterns: readonly number[]): ExpansionPlan {
  return planExpansion(state.source!.image, {
    ...options(),
    patterns: [...patterns].sort((a, b) => a - b),
  });
}

/**
 * The sounds-on-tracks report, for **what is actually going into the destination**.
 *
 * It used to render the whole-project plan unconditionally, so merging four patterns produced a
 * breakdown of all 128 — describing sounds that were never going anywhere near the destination.
 *
 * Now it follows the mode:
 *
 * - **whole project** — every live pattern, which is what that mode writes
 * - **selected patterns** — the patterns already merged in, plus the ones about to be, because
 *   between choosing and applying the interesting question is what the project is *becoming*
 *
 * The scope is a real planning input, not a filter over the output: expansion decides which sounds
 * get a track and which stay locked across everything in scope, so a report for four patterns has
 * to be planned for four patterns or it describes a layout the merge will not produce.
 */
function renderReport(): void {
  const image = state.source?.image;
  if (!image) return;

  const heading = $("reportScope");
  if (!merging()) {
    $("plan").innerHTML = renderPlan(state.plan ?? planExpansion(image, options()));
    heading.textContent = "— the whole project";
    return;
  }

  const scope = [...new Set([...(destination?.merged ?? []), ...selection])].sort((a, b) => a - b);
  if (scope.length === 0) {
    $("plan").innerHTML =
      `<p class="hint">Select patterns and drag them onto the destination — this will show how ` +
      `their sounds are laid out.</p>`;
    heading.textContent = "";
    return;
  }

  $("plan").innerHTML = renderPlan(planFor(scope));
  const inPlace = destination?.merged.length ?? 0;
  heading.textContent =
    inPlace === scope.length
      ? `— ${scope.length} pattern(s) merged: ${scope.map(patternName).join(" ")}`
      : `— ${scope.map(patternName).join(" ")} (${scope.length - inPlace} not applied yet)`;
}

async function loadSource(file: File): Promise<void> {
  status(`Reading ${file.name}…`);
  const loaded = await openProject(file);
  setSource({ image: loaded.image, label: file.name });
}

/**
 * Adopt a Digitone 1 project, however it arrived.
 *
 * One function for both routes deliberately. A file and a +Drive slot produce the same thing — an
 * image — and everything downstream of here already treats them identically; two setters would be
 * two chances for one route to forget to replan.
 */
function setSource(source: SourceProject): void {
  state.source = source;
  replan();
  $("sourceInfo").hidden = false;
  $("sourceInfo").textContent = `${readProjectName(source.image)} · ${source.label}`;
  status(`Loaded ${source.label}. Pick a destination, then drag patterns onto it.`);
}

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
    setDestination({ image: Uint8Array.from(template.image), origin: "file", label: template.fileName, merged: [] });
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

wireFilePicker("sourceFile", loadSource);
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

  setDestination({
    image: Uint8Array.from(donor.project.image),
    origin: "blank",
    label: donor.project.fileName,
    merged: [],
  });
  status(`Destination: a blank project from ${describeDonor(donor)}. Merge into it, then export.`);
}

function setDestination(next: Destination): void {
  destination = next;
  renderDestination();
  landingChanged();
}

function renderDestination(): void {
  const info = $("destinationInfo");
  if (!destination) {
    info.textContent = "— no destination yet";
  } else {
    const where =
      destination.origin === "device"
        ? "read from the instrument — a write goes back to its ACTIVE project"
        : destination.origin === "blank"
          ? "a blank project — export it as a file when you are done"
          : "a project file";
    info.textContent = `— ${projectName(destination.image)} · ${where}`;
    const badge = $("destinationBadge");
    badge.hidden = false;
    badge.textContent = destination.origin === "device" ? destination.label : destination.origin;
  }
  $<HTMLButtonElement>("exportDestination").disabled = destination === undefined;
  $<HTMLButtonElement>("undoApply").disabled = destination?.previous === undefined;
  // Writing needs a device baseline. A blank or a file has none, and the button says so by being
  // unavailable rather than by failing at the point of sending.
  $<HTMLButtonElement>("writeDevice").disabled = destination?.handle === undefined;
}

/**
 * Read the instrument's loaded project as the destination. **Once.**
 *
 * Reading takes about a minute, and it was once welded to planning — so changing the landing slot
 * meant reading the whole project again to find out whether the new slot was any better. Choosing
 * blind and paying a minute to discover the answer is the wrong way round.
 */
async function readDestination(): Promise<void> {
  if (!device.connected) throw new DeviceSourceError("connect a Digitone II first");

  // The donor supplies the ~0.49% no dump carries — header, song table, slot array. Without it
  // there is no image, only most of one. There is always one, so this no longer refuses.
  const donor = await loadDonor({ picked: state.template, onProblem: (message) => status(message, "warn") });

  const connected = device.connected;
  status(`Reading ${connected.name} with ${describeDonor(donor)} as the donor — this takes about a minute…`);
  const { image, handle } = await readProject(connected, donor.project.image, (done, total, label) => {
    if (done % 8 === 0 || done === total) status(`Reading: ${done}/${total} — ${label}`);
  });

  setDestination({ image, origin: "device", label: connected.name, handle, merged: [] });
  status(
    handle.problems.length > 0
      ? `Read with problems: ${handle.problems.join("; ")}. Read again before writing.`
      : `${connected.name} read. Merge into it, then write it back.`,
  );
}

/**
 * Recompute the plan against the working destination. **Sends nothing.**
 *
 * Called whenever anything it depends on changes — the mode, the selection, the landing slot, the
 * options, the destination itself — because a plan shown beside a control that has since moved is
 * worse than no plan at all.
 */
function replanForDevice(): void {
  if (!destination || !state.source) return;

  let described: Described;
  try {
    described = merging() ? planMerge(destination.image) : planWhole(destination.image);
  } catch (error) {
    // A refusal is a normal outcome of choosing a slot, not an error to shout about. It belongs
    // where the plan would have been, and the apply button has to go with it.
    device.image = undefined;
    $<HTMLButtonElement>("applyMerge").disabled = true;
    const message = error instanceof Error ? error.message : String(error);
    $("devicePlan").innerHTML = `<p class="bad">${escapeHtml(message)}</p>`;
    status(message, "error");
    return;
  }

  $("devicePlan").innerHTML =
    `<ul>${described.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` + renderNotes(described.notes);
  $<HTMLButtonElement>("applyMerge").disabled = device.image === undefined;
}

/**
 * Conversion notes, **folded away**.
 *
 * These used to be printed straight into this strip — over a thousand `<li>`s of "inferred at
 * DN1+173 -> DN2+229", which grew the sticky bar past the height of the page and drew the rest of
 * the tool underneath it. They are diagnostics about the field mapping, worth having and worth
 * nobody's whole screen, so they live behind a disclosure with their counts folded in.
 */
function renderNotes(notes: readonly MergeNote[] | undefined): string {
  if (!notes || notes.length === 0) return "";
  const total = notes.reduce((n, note) => n + note.count, 0);
  const items = notes
    .map((n) => `<li>${escapeHtml(n.message)}${n.count > 1 ? ` <b>× ${n.count}</b>` : ""}</li>`)
    .join("");
  return (
    `<details class="notes"><summary>${total} conversion note(s), ` +
    `${notes.length} distinct</summary><ul>${items}</ul></details>`
  );
}

/**
 * Fold the planned result into the destination.
 *
 * **Explicit, and separate from the preview.** The plan recomputes as you type a landing slot or
 * click a pattern; if that also mutated the accumulating project, choosing would be
 * indistinguishable from committing.
 */
function applyToDestination(): void {
  if (!destination || !device.image) return;
  destination = {
    ...destination,
    previous: destination.image,
    image: device.image,
    merged: merging() ? [...destination.merged, ...selection] : [...(state.plan?.livePatterns ?? [])],
  };
  const more = destination.origin === "device" ? "Write it back, or merge more first." : "Merge more, or export.";
  // The plan described a change *from* the old destination. Now that it is the destination, the
  // same plan is a no-op — so it is recomputed rather than left saying something untrue.
  renderDestination();
  landingChanged();
  renderReport();
  status(`Applied. ${more}`);
}

function undoApply(): void {
  if (!destination?.previous) return;
  destination = { ...destination, image: destination.previous, previous: undefined };
  renderDestination();
  landingChanged();
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
  if (!destination) return;
  // Only the manifest is wanted here — the firmware version, payload entry name and device
  // signature a `.dn2prj` must carry. Any Digitone II project supplies it, so the built-in blank
  // is a perfectly good last resort and an export can no longer be refused for want of a file.
  const donor = await loadDonor({ picked: state.template, onProblem: (message) => status(message, "warn") });

  const image = Uint8Array.from(destination.image);
  // A project authored here is a new project and gets its own identity rather than inheriting the
  // template's — otherwise every file exported claims to be the template.
  writeProjectId(image, mintProjectId());

  const named = $<HTMLInputElement>("destinationName").value.trim();
  if (named) writeProjectName(image, stampedName(named));

  const base = projectName(image) || "EXPANDED";
  download(await buildProjectBlob(donor.project, image), `${base.replace(/[^A-Za-z0-9 _-]/g, "_")}.dn2prj`);
  status(`Exported ${base}.`);
}

async function writeToDevice(): Promise<void> {
  const handle = destination?.handle;
  if (!handle || !destination) return;

  // Asked, always. `applyRearrange` refuses to overwrite without consent for the same reason: for
  // most people the instrument holds the only copy.
  const ok = window.confirm(
    "Write everything merged so far into the project loaded on the device?\n\n" +
      "It is not permanent until you press SAVE PROJECT on the instrument — and loading another " +
      "project discards it.",
  );
  if (!ok) {
    status("Not written.");
    return;
  }

  $<HTMLButtonElement>("writeDevice").disabled = true;
  try {
    // Diffed against what the instrument gave us, not against the last merge — so every change
    // accumulated in the working project is sent, however many applies went into it.
    const outcome = await writeBack(handle, destination.image, (done, total, label) => {
      status(`Writing ${done}/${total} — ${label}`);
    });
    status(
      `Wrote ${outcome.written} record(s), ${outcome.bytes.toLocaleString()} bytes. ` +
        `Press SAVE PROJECT on the device to keep it.` +
        (outcome.untransmittable.length > 0 ? ` Not sent: ${outcome.untransmittable.join(", ")}.` : ""),
    );
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
  status("Looking for a Digitone II…");
  // Asked for by name rather than found and then vetted. With both instruments plugged in — which
  // is this page's whole premise — "the best pair" is a coin toss, and refusing the Digitone 1
  // afterwards would refuse the one that happened to be enumerated first rather than the wrong one.
  const connected = await connectDevice({ want: ProductId.DN2 });

  device.connected = connected;
  $<HTMLButtonElement>("fromDevice").disabled = false;
  status(`${connected.name} connected. Load a Digitone 1 project, then plan.`);
}

// --- a connected Digitone 1 as the source -------------------------------------------------------

/**
 * The instrument being read *from*, kept apart from the one being written *to*.
 *
 * Two connections at once, on the same page, doing opposite jobs. One shared field would make
 * "connect" mean whichever button was pressed last — and the failure would be silent, because both
 * roles look identical until something is written.
 */
const sourceDevice: { connected?: ConnectedDevice; projects?: DriveProject[] } = {};

async function connectSource(): Promise<void> {
  status("Looking for a Digitone 1…");
  sourceDevice.connected = await connectDevice({ want: ProductId.DN1 });
  $<HTMLButtonElement>("browseSource").disabled = false;
  status(`${sourceDevice.connected.name} connected. Browse its +Drive to pick a project.`);
}

/**
 * List the Digitone 1's stored projects.
 *
 * **The +Drive, not the dump protocol.** Reading the *active* project record by record needs a
 * donor for the ~0.49% no dump carries, and for a Digitone 1 that donor would have to be a Digitone
 * 1 project — which this page cannot produce, and which is exactly why the manager refuses that
 * route. The stored file needs no donor at all: every byte is there, any slot, and the read is
 * verified byte-for-byte against Elektron's own export.
 *
 * The DN1 advertises the whole storage band (`0x53`–`0x5c`), so this is the same conversation the
 * manager already has with a Digitone II.
 */
async function browseSourceDrive(): Promise<void> {
  const connected = sourceDevice.connected;
  if (!connected) throw new DeviceSourceError("connect a Digitone 1 first");

  status(`Listing projects on ${connected.name}…`);
  const projects = await listDeviceProjects(connected);
  sourceDevice.projects = projects;

  const select = $<HTMLSelectElement>("sourceProjects");
  select.innerHTML = projects
    .map((p) => `<option value="${p.index}">${escapeHtml(`${p.index}. ${p.name}`)}</option>`)
    .join("");
  select.hidden = projects.length === 0;
  $("openSource").hidden = projects.length === 0;
  $<HTMLButtonElement>("openSource").disabled = projects.length === 0;

  status(
    projects.length === 0
      ? `${connected.name} reports no stored projects.`
      : `${projects.length} project(s) on ${connected.name}. Pick one and open it.`,
  );
}

async function openSourceSlot(): Promise<void> {
  const connected = sourceDevice.connected;
  const index = Number($<HTMLSelectElement>("sourceProjects").value);
  const project = sourceDevice.projects?.find((p) => p.index === index);
  if (!connected || !project) throw new DeviceSourceError("browse the +Drive again — that listing is stale");

  status(`Reading ${project.name} from slot ${project.index}…`);
  const opened = await openDeviceProject(connected, project, (chunks, bytes) => {
    if (chunks % 8 === 0) status(`Reading ${project.name}: ${bytes.toLocaleString()} bytes…`);
  });

  // Checked after the read rather than before, because the +Drive listing does not say what family
  // a stored project is — only the payload does. A DN2 project on a DN1's +Drive should be
  // impossible, and "should be impossible" is not the same as "cannot happen".
  if (deviceFor(opened.image).kind !== "dn1") {
    throw new DeviceSourceError(
      `Slot ${project.index} holds a Digitone II project, which this page expands *to* rather than from.`,
    );
  }

  setSource({ image: opened.image, label: `${project.name} · slot ${project.index}` });
}

/**
 * Whole-project conversion: every live pattern, and the destination replaced.
 *
 * The destination is still read and used as the template — expansion is a transplant, and a field
 * nobody writes inherits the destination's value.
 */
function planWhole(destination: Uint8Array): Described {
  if (!state.source) return { lines: [] };
  const plan = planDeviceExpand({
    source: state.source.image,
    destination,
    ...(state.plan === undefined ? {} : { plan: state.plan }),
    projectName: stampedName(readProjectName(state.source.image)),
  });
  device.image = plan.changedSlots.length > 0 ? plan.image : undefined;
  status(
    plan.changedSlots.length === 0
      ? "The device already holds this conversion — nothing to write."
      : `${plan.changedSlots.length} pattern slot(s) would change, about ${Math.round(plan.estimatedBytes / 1024)} kB.`,
  );
  return { lines: describeDeviceExpand(plan) };
}

/**
 * Merge the selected patterns into the loaded project, keeping its pool.
 *
 * Both refusals are surfaced as questions rather than swallowed: an occupied landing slot and a
 * pool with no room each stop the plan, and each is something only the person at the instrument can
 * answer. `planPatternMerge` is asked twice in that case — once to find out, once with the answer —
 * which costs milliseconds and keeps the consent explicit.
 */
function planMerge(destination: Uint8Array): Described {
  if (!state.source) return { lines: [] };
  if (selection.length === 0) throw new DeviceSourceError("no patterns selected");

  const base = {
    source: state.source.image,
    patterns: selection,
    destination,
    landing,
    landingMode: landingMode(),
    // Scoped to the selection, **not** `state.plan`. That one is the whole-project plan, and
    // handing it over made the merge allocate tracks against 128 patterns of competition — the
    // layout it produced was not the one the panel above described, and not the one asked for.
    plan: planFor(selection),
  };

  let plan: MergePlan;
  try {
    plan = planPatternMerge(base);
  } catch (error) {
    if (!(error instanceof MergeRefused)) throw error;
    // The two refusals worth asking about rather than reporting. Anything else stands.
    const overwrite = /already hold a pattern/.test(error.message);
    const overflow = /no room/.test(error.message);
    if (!overwrite && !overflow) throw error;
    if (!window.confirm(`${error.message}

Go ahead anyway?`)) {
      device.image = undefined;
      status("Not planned.");
      return { lines: [error.message, "Not planned."] };
    }
    plan = planPatternMerge({
      ...base,
      ...(overwrite ? { confirmOverwrite: true } : {}),
      ...(overflow ? { allowPoolOverflow: true, confirmOverwrite: true } : {}),
    });
  }

  device.image = plan.image;
  // What to do next, not what the panel already says. The panel's first line is this same landing
  // list; repeating it in the bar made the bar look like a leftover rather than a prompt.
  status(
    `Planned — press Apply to fold ${plan.landingSlots.length} pattern(s) into ` +
      `${plan.landingSlots.map(patternName).join(", ")}, ${describeLanding(landingMode())}.`,
  );
  return { lines: describeMerge(plan), notes: plan.notes };
}

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
    const slots = landingSlotsFor(from.indices, index, landingMode());
    // Refused rather than drawn as a partial drop: the merge refuses the whole landing, so a hint
    // offering it would be promising something Apply will not do.
    if (slots.some((slot) => slot >= DN2_PATTERN_COUNT)) return undefined;

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
    const slots = landingSlotsFor(selection, index, landingMode());
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
  return destination !== undefined && DN2_DEVICE.summarise(destination.image, slot).occupied === true;
}

/**
 * Name a set of destination slots without pretending it is a range.
 *
 * `A1…A3` is the honest description of three consecutive slots and a lie about A1, A9, A10 — it
 * claims eight slots are involved that are not. Consecutive runs still read as a range because
 * that is genuinely shorter; anything else is listed.
 */
function describeSlots(slots: readonly number[]): string {
  if (slots.length === 0) return "nothing";
  if (slots.length === 1) return patternName(slots[0]!);
  const sorted = [...slots].sort((a, b) => a - b);
  const consecutive = sorted.every((slot, i) => i === 0 || slot === sorted[i - 1]! + 1);
  if (consecutive) return `${patternName(sorted[0]!)}…${patternName(sorted[sorted.length - 1]!)}`;
  // Capped, because a selection can be large and a status bar cannot.
  const shown = sorted.slice(0, 6).map(patternName).join(", ");
  return sorted.length > 6 ? `${shown} and ${sorted.length - 6} more` : shown;
}

/**
 * The source grid: a Digitone 1's 128 patterns, in banks.
 *
 * Every pattern is shown rather than only the live ones. The bank counts say where the music is,
 * which is the same answer the old "live patterns only" list gave — but in the layout the rest of
 * the application uses, and without hiding the empty slots that make a bank legible.
 */
function renderSource(): void {
  const image = state.source?.image;
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
    patternCount: DN1_PATTERN_COUNT,
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
    bankSlots(sourceBank, DN1_PATTERN_COUNT, (index) => patternSlotView(DN1_DEVICE, image, index, live)),
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
  if (!destination) {
    grid.hidden = true;
    tabs.hidden = true;
    return;
  }
  grid.hidden = false;
  $("legend").hidden = false;

  const image = destination.image;
  renderBanks(tabs, {
    patternCount: DN2_PATTERN_COUNT,
    current: destinationBank,
    countOccupied: (bank) => countOccupiedIn(bank, DN2_DEVICE, image),
    onSelect: (bank) => {
      destinationBank = bank;
      renderDestinationGrid();
    },
  });

  renderSlots(
    grid,
    bankSlots(destinationBank, DN2_PATTERN_COUNT, (index) => incomingSlotView(index, image)),
    {
      // The landing slot is shown as the opened cell rather than a selection: nothing is selected
      // in this grid, and marking it says "this is where the drop went" without implying it can be
      // dragged from.
      selected: [],
      ...(merging() ? { opened: landing, landing: landingSlots() } : {}),
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
  const source = state.source?.image;
  const from = pendingSources().get(index);
  if (from === undefined || !source) return here;

  const arriving = patternSlotView(DN1_DEVICE, source, from);
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
 * Which source pattern is destined for which destination slot.
 *
 * Keyed by destination so a renderer can ask about one cell. **The same computation the merge
 * itself runs** — `landingSlotsFor` is shared with `merge.ts` rather than reproduced here, because a
 * preview worked out separately from the write is a preview that can be wrong about it, and this
 * page draws that preview into the cell as if it were fact.
 */
function pendingSources(): Map<number, number> {
  const pending = new Map<number, number>();
  if (!merging() || selection.length === 0) return pending;
  const slots = landingSlotsFor(selection, landing, landingMode());
  selection.forEach((from, i) => {
    const to = slots[i]!;
    // Out-of-range slots are dropped from the *preview* only. The merge refuses the whole
    // landing rather than trimming it, and `renderReport` says so — marking nothing here is what
    // makes the missing cells visible.
    if (to < DN2_PATTERN_COUNT) pending.set(to, from);
  });
  return pending;
}

/** Every destination slot the pending merge would write to, in the order they were picked. */
function landingSlots(): number[] {
  if (selection.length === 0) return [];
  return landingSlotsFor(selection, landing, landingMode()).filter((slot) => slot < DN2_PATTERN_COUNT);
}

/** Anchor for shift-ranges in the source grid. */
let anchor: number | undefined;

function syncMode(): void {
  renderSource();
  landingChanged();
  renderReport();
}
