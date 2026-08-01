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
  readProjectFile,
  type LoadedProject,
} from "./project.js";
import { blankDn2ProjectFile } from "../../src/librarian/blankproject.js";
import { renderPlan } from "./render.js";
import { $, escapeHtml } from "./dom.js";
import { statusBar } from "./statusbar.js";
import {
  type ConnectedDevice,
  type DeviceProjectHandle,
  DeviceSourceError,
  connectDevice,
  readProject,
  writeBack,
} from "./devicesource.js";
import { describeDeviceExpand, planDeviceExpand } from "../../src/expand/deviceexpand.js";
import {
  MergeRefused,
  describeMerge,
  planPatternMerge,
  type MergeNote,
  type MergePlan,
} from "../../src/expand/merge.js";
import { patternName } from "../../src/sheet/naming.js";
import {
  GridDrag,
  bankSlots,
  nextSelection,
  renderBanks,
  renderGrid as renderSlots,
} from "./grid.js";
import { DN1_DEVICE, DN2_DEVICE } from "../../src/librarian/device.js";

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

/** Build a name the device can show, ending in the build time so a loaded file is identifiable. */
function stampedName(base: string): string {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `${base.slice(0, 15 - hhmm.length - 1).trimEnd()} ${hhmm}`;
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
  // something else. Recomputed locally — nothing is sent.
  replanForDevice();
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
  state.source = await openProject(file);
  const name = readProjectName(state.source.image);
  replan();
  $("sourceInfo").hidden = false;
  $("sourceInfo").textContent = `${name} · ${file.name}`;
  status(`Loaded ${file.name}. Pick a destination, then drag patterns onto it.`);
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
  const served = await fetchServedTemplate();
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
for (const id of ["compact", "freeMidi", "rules", "aggregate"]) $(id).addEventListener("change", replan);
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
  // The embedded blank first, so this works on a fresh clone with no corpus and no file picked —
  // which is what "blank" should mean. A template found on the server or picked by hand is
  // preferred when there is one, because it is *this* user's device's idea of empty rather than
  // the one that happened to be captured.
  const picked = state.template ?? (await fetchServedTemplate());
  const blank = picked ?? (await loadEmbeddedBlank());
  if (!picked) state.template = blank;

  setDestination({ image: Uint8Array.from(blank.image), origin: "blank", label: blank.fileName, merged: [] });
  status(`Destination: a blank project from ${blank.fileName}. Merge into it, then export.`);
}

/**
 * The blank project that ships with the code.
 *
 * `src/librarian/blankproject.ts` carries a device-initialised `.dn2prj` — 7,805 bytes, verified to
 * hold no occupied pattern and no named pool slot before it was embedded. It is the blank
 * destination, the donor a device read needs for the parts no dump carries, and the manifest an
 * export writes out: one artefact doing all three, which is why the file is embedded rather than
 * the image.
 */
async function loadEmbeddedBlank(): Promise<LoadedProject> {
  return readProjectFile("blank.dn2prj", blankDn2ProjectFile());
}


function setDestination(next: Destination): void {
  destination = next;
  renderDestination();
  renderDestinationGrid();
  replanForDevice();
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
  renderDestinationGrid();
  replanForDevice();
  renderReport();
  status(`Applied. ${more}`);
}

function undoApply(): void {
  if (!destination?.previous) return;
  destination = { ...destination, image: destination.previous, previous: undefined };
  renderDestination();
  renderDestinationGrid();
  replanForDevice();
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
  $<HTMLButtonElement>("fromDevice").disabled = false;
  status(`${connected.name} connected. Load a Digitone 1 project, then plan.`);
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
      `${plan.landingSlots.map(patternName).join(", ")}.`,
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

    const last = index + from.indices.length - 1;
    if (last >= DN2_PATTERN_COUNT) {
      return undefined;
    }

    const occupied = occupiedInRange(index, last);
    return {
      action: "move",
      label: occupied > 0 ? `MERGE · ${occupied} occupied` : "MERGE",
      status:
        `${from.indices.length} pattern(s) → ${patternName(index)}…${patternName(last)}` +
        (occupied > 0 ? ` · ${occupied} slot(s) already hold a pattern` : " · all empty"),
    };
  },

  onDrop(from, grid, index) {
    if (from.grid !== "source" || grid !== "destination") return;
    landing = index;
    replanForDevice();
  },

  onStatus: (message) => {
    status(message);
  },
});

/** Where the selection would land. Set by a drop, never typed. */
let landing = 0;

function occupiedInRange(from: number, to: number): number {
  if (!destination) return 0;
  let n = 0;
  for (let slot = from; slot <= to; slot++) {
    if (DN2_DEVICE.summarise(destination.image, slot).occupied) n++;
  }
  return n;
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
    countOccupied: (bank) => {
      let n = 0;
      for (let i = bank * 16; i < bank * 16 + 16; i++) if (live.has(i)) n++;
      return n;
    },
    onSelect: (bank) => {
      sourceBank = bank;
      renderSource();
    },
  });

  renderSlots(
    grid,
    bankSlots(sourceBank, DN1_PATTERN_COUNT, (index) => {
      const summary = DN1_DEVICE.summarise(image, index);
      return {
        id: patternName(index),
        name: summary.name || "—",
        detail: live.has(index)
          ? `${summary.trigCount ?? 0} trigs${summary.soundLockCount ? ` · ${summary.soundLockCount} locks` : ""}`
          : "empty",
        occupied: live.has(index),
        supported: summary.supported,
      };
    }),
    {
      selected: selection,
      onClick: (index, event) => {
        const next = nextSelection(selection, anchor, index, event);
        selection.length = 0;
        selection.push(...next.selection);
        anchor = next.anchor;
        renderSource();
        renderReport();
        replanForDevice();
      },
      drag: { controller: drag, grid: "source" },
    },
  );

  $("sourceSub").textContent =
    selection.length === 0
      ? `— ${live.size} live`
      : `— ${selection.length} selected: ${selection.map(patternName).join(" ")}`;
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
    countOccupied: (bank) => {
      let n = 0;
      for (let i = bank * 16; i < bank * 16 + 16; i++) {
        if (DN2_DEVICE.summarise(image, i).occupied) n++;
      }
      return n;
    },
    onSelect: (bank) => {
      destinationBank = bank;
      renderDestinationGrid();
    },
  });

  renderSlots(
    grid,
    bankSlots(destinationBank, DN2_PATTERN_COUNT, (index) => {
      const summary = DN2_DEVICE.summarise(image, index);
      return {
        id: patternName(index),
        name: summary.supported ? summary.name || "—" : `v${summary.version}`,
        detail: summary.supported
          ? summary.occupied
            ? `${summary.trigCount} trigs${summary.soundLockCount ? ` · ${summary.soundLockCount} locks` : ""}`
            : "empty"
          : "unreadable version",
        occupied: summary.occupied === true,
        supported: summary.supported,
      };
    }),
    {
      // The landing slot is shown as the opened cell rather than a selection: nothing is selected
      // in this grid, and marking it says "this is where the drop went" without implying it can be
      // dragged from.
      selected: [],
      ...(merging() ? { opened: landing } : {}),
      onClick: (index) => {
        landing = index;
        renderDestinationGrid();
        replanForDevice();
      },
      drag: { controller: drag, grid: "destination" },
    },
  );
}

/** Anchor for shift-ranges in the source grid. */
let anchor: number | undefined;

function syncMode(): void {
  renderSource();
  renderDestinationGrid();
  replanForDevice();
  renderReport();
}
