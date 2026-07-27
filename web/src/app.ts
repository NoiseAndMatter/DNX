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
import { buildProjectBlob, download, openProject, type LoadedProject } from "./project.js";
import { renderPlan, renderSummary } from "./render.js";

interface State {
  source?: LoadedProject;
  template?: LoadedProject;
  plan?: ExpansionPlan;
}

const state: State = {};

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
  state.template = await openProject(file);
  $("templateInfo").innerHTML = renderSummary(projectName(state.template.image), file.name, 0);
  $<HTMLButtonElement>("export").disabled = !state.source;
  status(`Template ${file.name} ready.`);
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
for (const id of ["compact", "freeMidi", "rules"]) $(id).addEventListener("change", replan);
$("export").addEventListener("click", () => {
  exportProject().catch((error: unknown) => status(String(error instanceof Error ? error.message : error), "error"));
});

status("Pick a Digitone 1 project, and a Digitone II project to use as the template.");
