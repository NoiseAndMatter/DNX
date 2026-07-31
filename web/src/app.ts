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
import {
  type ConnectedDevice,
  type DeviceProjectHandle,
  DeviceSourceError,
  connectDevice,
  readProject,
  writeBack,
} from "./devicesource.js";
import { describeDeviceExpand, planDeviceExpand, type DeviceExpandPlan } from "../../src/expand/deviceexpand.js";
import { ProductId } from "../../src/sysex/devices.js";

interface State {
  source?: LoadedProject;
  template?: LoadedProject;
  plan?: ExpansionPlan;
}

const state: State = {};

interface DeviceState {
  connected?: ConnectedDevice;
  handle?: DeviceProjectHandle;
  plan?: DeviceExpandPlan;
}

const device: DeviceState = {};

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const status = (message: string, kind: "info" | "error" = "info"): void => {
  const bar = $("status");
  bar.textContent = message;
  bar.className = kind;
};

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
$("export").addEventListener("click", () => {
  exportProject().catch((error: unknown) => status(String(error instanceof Error ? error.message : error), "error"));
});

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
  planForDevice().catch(reportDeviceError);
});

$("writeDevice").addEventListener("click", () => {
  writeToDevice().catch(reportDeviceError);
});

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

async function planForDevice(): Promise<void> {
  if (!device.connected || !state.source) return;

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

  const plan = planDeviceExpand({
    source: state.source.image,
    destination: image,
    ...(state.plan === undefined ? {} : { plan: state.plan }),
    projectName: stampedName(readProjectName(state.source.image)),
  });
  device.plan = plan;

  const lines = describeDeviceExpand(plan);
  const problems = handle.problems.length > 0
    ? `<p class="bad">Read with problems: ${escapeHtml(handle.problems.join("; "))}. Read again before writing.</p>`
    : "";
  $("devicePlan").innerHTML =
    problems + `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;

  // Nothing to send is not a failure, and the button should say so by being unavailable rather
  // than by writing zero records and reporting success.
  $<HTMLButtonElement>("writeDevice").disabled = plan.changedSlots.length === 0;
  status(
    plan.changedSlots.length === 0
      ? "The device already holds this conversion — nothing to write."
      : `${plan.changedSlots.length} pattern slot(s) would change, about ${Math.round(plan.estimatedBytes / 1024)} kB.`,
  );
}

async function writeToDevice(): Promise<void> {
  if (!device.handle || !device.plan) return;
  const plan = device.plan;

  // Asked, always, and with the count in the question. `applyRearrange` refuses to overwrite
  // without consent for the same reason: for most people the +Drive is the only copy.
  const ok = window.confirm(
    `Write ${plan.changedSlots.length} pattern slot(s) into the project loaded on the device?\n\n` +
      `This overwrites those slots in the ACTIVE project. It is not permanent until you press ` +
      `SAVE PROJECT on the instrument — and loading another project discards it.`,
  );
  if (!ok) {
    status("Not written.");
    return;
  }

  $<HTMLButtonElement>("writeDevice").disabled = true;
  try {
    const outcome = await writeBack(device.handle, plan.image, (done, total, label) => {
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
