/**
 * Wiring: pick files, replan when an option changes, export.
 *
 * Deliberately thin. Planning lives in `src/expand`, conversion in `src/expand/convert.ts`,
 * rendering in `render.ts`, and file handling in `project.ts` — this only holds the state
 * the page needs and connects the three.
 */

import { convertProject } from "../../src/expand/convert.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../../src/expand/plan.js";
import { mintProjectId, projectName, writeProjectId } from "../../src/project/dn2image.js";
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
  $<HTMLButtonElement>("planDevice").disabled = device.connected === undefined;
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

// --- writing to the instrument --------------------------------------------------------------
//
// The same conversion, delivered over MIDI instead of as a file. Everything above this line is
// unchanged: `planDeviceExpand` runs the same `convertProject`, so the bytes that reach the
// device are the bytes the download would have contained.
//
// ## Why the destination is the LOADED project
//
// A dump-protocol write lands in the **active** project — verified on hardware, survives a power
// cycle, discarded when another project loads, and SAVE PROJECT is the commit. So the diff
// baseline has to be the live state, not the last save: reading the destination off the +Drive
// would give a complete file and the wrong baseline the moment anything is unsaved.
//
// That is also why this reads the destination rather than assuming a blank. Expansion is a
// transplant — a field nobody writes inherits the destination's value — so the destination has to
// be the real one.

$("connect").addEventListener("click", () => {
  connect().catch(reportDeviceError);
});

$("planDevice").addEventListener("click", () => {
  readDestination().catch(reportDeviceError);
});

$("writeDevice").addEventListener("click", () => {
  writeToDevice().catch(reportDeviceError);
});

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
  $<HTMLButtonElement>("planDevice").disabled = !state.source;
  status(`${connected.name} connected. Load a Digitone 1 project, then plan.`);
}

/**
 * Read the destination **once**.
 *
 * Reading takes about a minute, and it used to be welded to planning — so changing the landing slot
 * meant reading the whole project again to find out whether the new slot was any better. Choosing
 * blind and paying a minute to discover the answer is the wrong way round.
 *
 * Now the read stands on its own and the plan is recomputed locally, so the landing slot can be
 * moved as often as it takes. Nothing is sent while doing that.
 */
async function readDestination(): Promise<void> {
  if (!device.connected) return;

  // The donor supplies the ~0.49% no dump carries — header, song table, slot array. Required, and
  // honestly so: without it there is no image, only most of one.
  const donor = state.template ?? (await fetchServedTemplate());
  if (!donor) {
    throw new DeviceSourceError(
      "reading a device needs a Digitone II project for the parts no dump carries — the header, " +
        "the song table and the slot array. Pick a template file above.",
    );
  }

  status(`Reading ${device.connected.name} — this takes about a minute…`);
  const { image, handle } = await readProject(device.connected, donor.image, (done, total, label) => {
    if (done % 8 === 0 || done === total) status(`Reading: ${done}/${total} — ${label}`);
  });
  device.handle = handle;
  device.destination = image;

  updateLandingHint();
  replanForDevice();
}

/**
 * Recompute the plan from the destination already in hand. **Sends nothing.**
 *
 * Called whenever anything it depends on changes — the mode, the selection, the landing slot, the
 * expansion options — because a plan shown beside a control that has since moved is worse than no
 * plan at all.
 */
function replanForDevice(): void {
  const destination = device.destination;
  if (!destination || !state.source) return;

  let lines: string[];
  try {
    lines = merging() ? planMerge(destination) : planWhole(destination);
  } catch (error) {
    // A refusal is a normal outcome of choosing a slot, not an error to shout about. It belongs
    // where the plan would have been, and the write button has to go with it.
    device.image = undefined;
    $<HTMLButtonElement>("writeDevice").disabled = true;
    const message = error instanceof Error ? error.message : String(error);
    $("devicePlan").innerHTML = `<p class="bad">${escapeHtml(message)}</p>`;
    status(message, "error");
    return;
  }

  const handle = device.handle;
  const problems = handle && handle.problems.length > 0
    ? `<p class="bad">Read with problems: ${escapeHtml(handle.problems.join("; "))}. Read again before writing.</p>`
    : "";
  $("devicePlan").innerHTML =
    problems + `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;

  // Nothing to send is not a failure, and the button should say so by being unavailable rather
  // than by writing zero records and reporting success.
  $<HTMLButtonElement>("writeDevice").disabled = device.image === undefined;
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

async function writeToDevice(): Promise<void> {
  if (!device.handle || !device.image) return;
  const image = device.image;

  // Asked, always. `applyRearrange` refuses to overwrite without consent for the same reason: for
  // most people the instrument holds the only copy.
  const ok = window.confirm(
    `Write the planned changes into the project loaded on the device?\n\n` +
      `This overwrites those slots in the ACTIVE project. It is not permanent until you press ` +
      `SAVE PROJECT on the instrument — and loading another project discards it.`,
  );
  if (!ok) {
    status("Not written.");
    return;
  }

  $<HTMLButtonElement>("writeDevice").disabled = true;
  try {
    const outcome = await writeBack(device.handle, image, (done, total, label) => {
      status(`Writing ${done}/${total} — ${label}`);
    });
    status(
      `Wrote ${outcome.written} record(s), ${outcome.bytes.toLocaleString()} bytes. ` +
        `Press SAVE PROJECT on the device to keep it.` +
        (outcome.untransmittable.length > 0 ? ` Not sent: ${outcome.untransmittable.join(", ")}.` : ""),
    );
  } finally {
    $<HTMLButtonElement>("writeDevice").disabled = false;
  }
}

