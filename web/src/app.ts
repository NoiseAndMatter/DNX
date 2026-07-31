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
import { renderPlan, renderSummary } from "./render.js";
import { $, escapeHtml, statusBar } from "./dom.js";

// The expander's stylesheet uses a bare `#status.error` rather than `.status.error`.
const status = statusBar("status", "");
import {
  type ConnectedDevice,
  type DeviceProjectHandle,
  DeviceSourceError,
  connectDevice,
  readProject,
  writeBack,
} from "./devicesource.js";
import { describeDeviceExpand, planDeviceExpand } from "../../src/expand/deviceexpand.js";
import { MergeRefused, describeMerge, planPatternMerge, type MergePlan } from "../../src/expand/merge.js";
import { patternIndex, patternName } from "../../src/sheet/naming.js";
import { DN2_DEVICE } from "../../src/librarian/device.js";
import { ProductId } from "../../src/sysex/devices.js";

interface State {
  source?: LoadedProject;
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
   * The destination project as it is on the instrument right now.
   *
   * Kept so the landing slot can be moved without reading the device again — and so the hint can
   * say what is actually in those slots rather than leaving it to be discovered by a refusal.
   */
  destination?: Uint8Array;
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

function options() {
  return {
    compactPerPattern: $<HTMLInputElement>("compact").checked,
    useFreedMidiTracks: $<HTMLInputElement>("freeMidi").checked,
    aggregateByName: $<HTMLInputElement>("aggregate").checked,
    ...($<HTMLInputElement>("rules").checked ? { rules: PERCUSSION_LOW_RULES } : {}),
  };
}

/** Build a name the device can show, ending in the build time so a loaded file is identifiable. */
function stampedName(base: string): string {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `${base.slice(0, 15 - hhmm.length - 1).trimEnd()} ${hhmm}`;
}

function replan(): void {
  if (!state.source) return;
  state.plan = planExpansion(state.source.image, options());
  $("plan").innerHTML = renderPlan(state.plan);
  $<HTMLButtonElement>("export").disabled = !state.template;
  // The device path needs a source too, and a project can be loaded either side of connecting.
  $<HTMLButtonElement>("fromDevice").disabled = device.connected === undefined;
  // Which patterns are live depends on the options, so the picker follows them. Selections that
  // are no longer live are dropped rather than silently planned.
  for (let i = selection.length - 1; i >= 0; i--) {
    if (!state.plan.livePatterns.includes(selection[i]!)) selection.splice(i, 1);
  }
  renderPicker();
  updateLandingHint();
  // The options changed what would be written, so any plan already on screen is now describing
  // something else. Recomputed locally — nothing is sent.
  replanForDevice();
}

async function loadSource(file: File): Promise<void> {
  status(`Reading ${file.name}…`);
  state.source = await openProject(file);
  const name = readProjectName(state.source.image);
  const live = new Set<number>();
  $("sourceInfo").innerHTML = renderSummary(name, file.name, live.size);
  replan();
  $("sourceInfo").innerHTML = renderSummary(name, file.name, state.plan?.livePatterns.length ?? 0);
  status(`Loaded ${file.name}.`);
}

async function loadTemplate(file: File): Promise<void> {
  status(`Reading template ${file.name}…`);
  useTemplate(await openProject(file));
  status(`Template ${file.name} ready.`);
}

function useTemplate(template: LoadedProject, note = ""): void {
  state.template = template;
  $("templateInfo").innerHTML =
    renderSummary(projectName(template.image), template.fileName, 0) + note;
  $<HTMLButtonElement>("export").disabled = !state.source;
}

/**
 * Take the template from the local server when there is one.
 *
 * `npm run web` can find `EMPTY.dn2prj` the way every other command does; the browser cannot
 * read a folder, so it asks. Served as static files this simply finds nothing and the picker
 * below it stays the way in — no build-time switch, one page either way.
 */
async function adoptServedTemplate(): Promise<void> {
  const served = await fetchServedTemplate();
  if (!served) return;
  useTemplate(served, `<div class="info">Found by <code>npm run web</code>. Pick a file to override.</div>`);
  status(`Template ${served.fileName} loaded automatically. Pick a Digitone 1 project.`);
}

async function exportProject(): Promise<void> {
  if (!state.source || !state.template || !state.plan) return;

  const base = readProjectName(state.source.image);
  const name = stampedName(base);
  status(`Converting as "${name}"…`);

  const { image, report } = convertProject(state.source.image, state.template.image, {
    plan: state.plan,
    projectName: name,
  });

  // A converted project is a new project and gets its own identity rather than inheriting the
  // template's — otherwise every file exported from here claims to be the template. Minted at
  // the point a file is authored, not inside convertProject, which must stay byte-identical to
  // Elektron's importer.
  writeProjectId(image, mintProjectId());

  const blob = await buildProjectBlob(state.template, image);
  download(blob, `${base.replace(/[^\w -]/g, "_")}_EXPANDED.dn2prj`);

  const dropped = report.warnings.filter((w) => !w.message.includes("interpolated")).length;
  status(
    `Exported "${name}": ${report.patternsWritten} patterns, ${report.trigsWritten} trigs, ` +
      `${report.trigsPromoted} promoted` + (dropped ? `, ${dropped} field(s) reported` : ""),
  );
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
for (const id of ["compact", "freeMidi", "rules", "aggregate"]) $(id).addEventListener("change", replan);
for (const id of ["modeWhole", "modeSelect"]) $(id).addEventListener("change", syncMode);
$("landing").addEventListener("input", () => {
  updateLandingHint();
  replanForDevice();
});
$("export").addEventListener("click", () => {
  exportProject().catch((error: unknown) => status(String(error instanceof Error ? error.message : error), "error"));
});

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
}

let destination: Destination | undefined;

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
  const blank = state.template ?? (await fetchServedTemplate());
  if (!blank) {
    throw new DeviceSourceError(
      "no Digitone II project to start from. Pick a template file above — a blank saved by the " +
        "device is cleanest.",
    );
  }
  setDestination({ image: Uint8Array.from(blank.image), origin: "blank", label: blank.fileName });
  status(`Destination: a blank project from ${blank.fileName}. Merge into it, then export.`);
}

function setDestination(next: Destination): void {
  destination = next;
  renderDestination();
  updateLandingHint();
  replanForDevice();
}

function renderDestination(): void {
  const info = $("destinationInfo");
  if (!destination) {
    info.textContent = "No destination yet. Start from a blank project, or read one off a device.";
  } else {
    const where =
      destination.origin === "device"
        ? "read from the instrument — a write goes back to its ACTIVE project"
        : destination.origin === "blank"
          ? "a blank project — export it as a file when you are done"
          : "a project file";
    info.innerHTML = `<strong>${escapeHtml(projectName(destination.image))}</strong> · ${escapeHtml(where)}`;
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

  // The donor supplies the ~0.49% no dump carries — header, song table, slot array. Required, and
  // honestly so: without it there is no image, only most of one.
  const donor = state.template ?? (await fetchServedTemplate());
  if (!donor) {
    throw new DeviceSourceError(
      "reading a device needs a Digitone II project for the parts no dump carries — the header, " +
        "the song table and the slot array. Pick a template file above.",
    );
  }

  const connected = device.connected;
  status(`Reading ${connected.name} — this takes about a minute…`);
  const { image, handle } = await readProject(connected, donor.image, (done, total, label) => {
    if (done % 8 === 0 || done === total) status(`Reading: ${done}/${total} — ${label}`);
  });

  setDestination({ image, origin: "device", label: connected.name, handle });
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

  let lines: string[];
  try {
    lines = merging() ? planMerge(destination.image) : planWhole(destination.image);
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

  $("devicePlan").innerHTML = `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
  $<HTMLButtonElement>("applyMerge").disabled = device.image === undefined;
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
  destination = { ...destination, previous: destination.image, image: device.image };
  const more = destination.origin === "device" ? "Write it back, or merge more first." : "Merge more, or export.";
  // The plan described a change *from* the old destination. Now that it is the destination, the
  // same plan is a no-op — so it is recomputed rather than left saying something untrue.
  renderDestination();
  updateLandingHint();
  replanForDevice();
  status(`Applied. ${more}`);
}

function undoApply(): void {
  if (!destination?.previous) return;
  destination = { ...destination, image: destination.previous, previous: undefined };
  renderDestination();
  updateLandingHint();
  replanForDevice();
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
  const template = state.template ?? (await fetchServedTemplate());
  if (!template) throw new DeviceSourceError("exporting needs a Digitone II project to carry the manifest");

  const image = Uint8Array.from(destination.image);
  // A project authored here is a new project and gets its own identity rather than inheriting the
  // template's — otherwise every file exported claims to be the template.
  writeProjectId(image, mintProjectId());

  const named = $<HTMLInputElement>("destinationName").value.trim();
  if (named) writeProjectName(image, stampedName(named));

  const base = projectName(image) || "EXPANDED";
  download(await buildProjectBlob(template, image), `${base.replace(/[^A-Za-z0-9 _-]/g, "_")}.dn2prj`);
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

/**
 * The pattern picker: **live patterns only**.
 *
 * 128 boxes of which eleven matter is a worse question than eleven boxes, and `planExpansion`
 * already knows which patterns hold anything. Click order is landing order, so each selected
 * button carries its position.
 */
function renderPicker(): void {
  const pick = $("pick");
  pick.innerHTML = "";
  const live = state.plan?.livePatterns ?? [];

  if (live.length === 0) {
    pick.innerHTML = `<p class="muted">Load a Digitone 1 project to choose patterns.</p>`;
    return;
  }

  for (const index of live) {
    const button = document.createElement("button");
    const at = selection.indexOf(index);
    button.type = "button";
    button.setAttribute("aria-pressed", String(at >= 0));
    button.innerHTML = patternName(index) + (at >= 0 ? `<span class="ord">${at + 1}</span>` : "");
    button.addEventListener("click", () => {
      // Clicking a chosen pattern removes it, and the numbers behind it close up — otherwise the
      // only way to fix a mis-click is to clear everything.
      if (at >= 0) selection.splice(at, 1);
      else selection.push(index);
      renderPicker();
      updateLandingHint();
      replanForDevice();
    });
    pick.append(button);
  }
}

/** Say where the selection would land, before anything is planned. */
function updateLandingHint(): void {
  const hint = $("landingHint");
  if (selection.length === 0) {
    hint.textContent = "Nothing selected.";
    return;
  }
  const landing = landingSlot();
  if (landing === undefined) {
    hint.textContent = "Not a pattern slot — try A1, B12, H16.";
    return;
  }
  const last = landing + selection.length - 1;
  if (last > 127) {
    hint.textContent = `${selection.length} pattern(s) from ${patternName(landing)} would run past H16.`;
    return;
  }

  const range = `${selection.length} pattern(s) → ${patternName(landing)}…${patternName(last)}`;

  // **What is actually in those slots**, once the destination has been read. Choosing a landing
  // slot blind and discovering it was occupied from a refusal is the wrong way round: the
  // information exists the moment the device has been read, and this is where it is wanted.
  const destination = device.destination;
  if (!destination) {
    hint.textContent = `${range}. Read the device to see what is in them.`;
    return;
  }

  const occupied: string[] = [];
  for (let slot = landing; slot <= last; slot++) {
    const summary = DN2_DEVICE.summarise(destination, slot);
    if (summary.occupied) occupied.push(`${patternName(slot)}${summary.name ? ` ${summary.name}` : ""}`);
  }
  hint.textContent =
    occupied.length === 0
      ? `${range} — all empty.`
      : `${range} — ${occupied.length} occupied: ${occupied.slice(0, 4).join(", ")}${occupied.length > 4 ? "…" : ""}`;
}

/** The landing slot, or undefined when the box does not name one. */
function landingSlot(): number | undefined {
  try {
    return patternIndex($<HTMLInputElement>("landing").value.trim());
  } catch {
    return undefined;
  }
}

function syncMode(): void {
  $("selectMode").hidden = !merging();
  renderPicker();
  updateLandingHint();
  replanForDevice();
}

function reportDeviceError(error: unknown): void {
  const message = error instanceof DeviceSourceError || error instanceof Error ? error.message : String(error);
  status(message, "error");
  $("devicePlan").innerHTML = `<p class="bad">${escapeHtml(message)}</p>`;
}

async function connect(): Promise<void> {
  status("Looking for an instrument…");
  const connected = await connectDevice();

  // Refused rather than attempted. Expansion targets a Digitone II — a DN1 cannot receive one —
  // and finding that out after a minute of reading is worse than being told now.
  if (connected.productId !== ProductId.DN2) {
    connected.close();
    throw new DeviceSourceError(
      `${connected.name} is not a Digitone II. Expansion writes DN2 patterns, so a Digitone 1 ` +
        `cannot be the destination.`,
    );
  }

  device.connected = connected;
  $("deviceInfo").innerHTML =
    `<strong>${escapeHtml(connected.name)}</strong> connected. Its currently loaded project is the ` +
    `destination — nothing is permanent until SAVE PROJECT on the device.`;
  $<HTMLButtonElement>("fromDevice").disabled = false;
  status(`${connected.name} connected. Load a Digitone 1 project, then plan.`);
}

/**
 * Whole-project conversion: every live pattern, and the destination replaced.
 *
 * The destination is still read and used as the template — expansion is a transplant, and a field
 * nobody writes inherits the destination's value.
 */
function planWhole(destination: Uint8Array): string[] {
  if (!state.source) return [];
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
  return describeDeviceExpand(plan);
}

/**
 * Merge the selected patterns into the loaded project, keeping its pool.
 *
 * Both refusals are surfaced as questions rather than swallowed: an occupied landing slot and a
 * pool with no room each stop the plan, and each is something only the person at the instrument can
 * answer. `planPatternMerge` is asked twice in that case — once to find out, once with the answer —
 * which costs milliseconds and keeps the consent explicit.
 */
function planMerge(destination: Uint8Array): string[] {
  if (!state.source) return [];
  const landing = landingSlot();
  if (landing === undefined) throw new DeviceSourceError("the landing slot is not a pattern — try A1, B12, H16");
  if (selection.length === 0) throw new DeviceSourceError("no patterns selected");

  const base = {
    source: state.source.image,
    patterns: selection,
    destination,
    landing,
    ...(state.plan === undefined ? {} : { plan: state.plan }),
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
      return [error.message, "Not planned."];
    }
    plan = planPatternMerge({
      ...base,
      ...(overwrite ? { confirmOverwrite: true } : {}),
      ...(overflow ? { allowPoolOverflow: true, confirmOverwrite: true } : {}),
    });
  }

  device.image = plan.image;
  status(`${plan.landingSlots.length} pattern(s) → ${plan.landingSlots.map(patternName).join(", ")}.`);
  return describeMerge(plan);
}
