/**
 * What the expander would do, worked out and described — and **nothing else**.
 *
 * ## What this owns
 *
 * Three questions, and they are one job: given a source, a destination and the options ticked on
 * the page, *what would happen*, *what should the person be told*, and *what bytes would be
 * written*. Every answer is returned. Nothing here touches the DOM, assigns a module global, or
 * calls `window`.
 *
 * That is not tidiness for its own sake. Planning used to assign `device.image` on its way past
 * and call `window.confirm` in the middle of a refusal, which meant the only way to find out what
 * a plan produced was to run the page — so none of it was tested, and the one part that had a real
 * bug (a merge planned against 128 patterns of competition instead of the four selected) could
 * only be found by looking at a panel on screen and noticing it disagreed with the result.
 *
 * Returning an outcome makes the same code answerable in a test. The caller writes the HTML, sets
 * the button and shows the status line, because those are the caller's job.
 *
 * ## Consent is an argument
 *
 * `planSelected` takes an `ask` callback rather than reaching for `window.confirm`. Two of the
 * merge's refusals — an occupied landing slot, a pool with no room — are questions only the person
 * at the instrument can answer, and they have to be asked *between* two planning passes. Passing
 * the asking in keeps that flow intact while leaving this module free of the browser.
 */

import { type ExpansionPlan } from "../../../src/expand/types.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../../../src/expand/plan.js";
import {
  MergeRefused,
  describeMerge,
  planPatternMerge,
  type MergeNote,
  type MergePlan,
} from "../../../src/expand/merge.js";
import { describeDeviceExpand, planDeviceExpand } from "../../../src/expand/deviceexpand.js";
import { type LandingMode, describeLanding } from "../../../src/expand/landing.js";
import { readProjectName } from "../../../src/project/dn1.js";
import { patternName, stampedProjectName as stampedName } from "../../../src/sheet/naming.js";
// **From `src/`, not from `../dom.js`.** `dom.ts` only re-exports this, and importing it here
// would pull `HTMLElement` and `Blob` into anything that imports planning — which is how a Node
// test of this module would start failing `tsc` on types it never asked for. That has happened
// once already, in `devicesource.ts`.
import { escapeHtml } from "../../../src/sheet/html.js";

/**
 * What a plan says about itself: the lines that matter, and the conversion notes if it has any.
 *
 * The two are separate all the way to the DOM. Merged into one list they were indistinguishable,
 * and the four lines somebody needs lost to the thousand they do not.
 */
export interface Described {
  lines: string[];
  notes?: MergeNote[];
}

/** The options panel's state, as the planner needs it. */
export interface ExpanderOptions {
  compactPerPattern: boolean;
  useFreedMidiTracks: boolean;
  aggregateByName: boolean;
  rules?: typeof PERCUSSION_LOW_RULES;
}

/**
 * Everything one planning pass produces.
 *
 * `image` is the bytes to write, and **`undefined` means there is nothing to send** — which is how
 * the apply button knows to stay disabled. Returned rather than assigned, so there is exactly one
 * place that decides what "nothing to send" means.
 */
export interface PlanOutcome {
  described: Described;
  image?: Uint8Array;
  /** What to put in the status bar, and how loudly. */
  message: string;
  level?: "ok" | "warn" | "error";
}

/**
 * An expansion plan for these patterns and these options.
 *
 * One helper, because the report and the merge must not disagree: a panel describing one layout
 * beside a button that produces another is worse than no panel.
 */
export function planFor(
  image: Uint8Array,
  patterns: readonly number[],
  options: ExpanderOptions,
): ExpansionPlan {
  return planExpansion(image, { ...options, patterns: [...patterns].sort((a, b) => a - b) });
}

/** Convert a whole Digitone 1 project onto the destination. */
export function planWhole(args: {
  source: Uint8Array;
  destination: Uint8Array;
  plan?: ExpansionPlan;
}): PlanOutcome {
  const plan = planDeviceExpand({
    source: args.source,
    destination: args.destination,
    ...(args.plan === undefined ? {} : { plan: args.plan }),
    projectName: stampedName(readProjectName(args.source)),
  });

  return {
    described: { lines: describeDeviceExpand(plan) },
    ...(plan.changedSlots.length > 0 ? { image: plan.image } : {}),
    message:
      plan.changedSlots.length === 0
        ? "The device already holds this conversion — nothing to write."
        : `${plan.changedSlots.length} pattern slot(s) would change, about ` +
          `${Math.round(plan.estimatedBytes / 1024)} kB.`,
  };
}

/**
 * Merge the selected patterns into the loaded project, keeping its pool.
 *
 * Both refusals are surfaced as questions rather than swallowed: an occupied landing slot and a
 * pool with no room each stop the plan, and each is something only the person at the instrument
 * can answer. `planPatternMerge` is asked twice in that case — once to find out, once with the
 * answer — which costs milliseconds and keeps the consent explicit.
 */
export function planSelected(args: {
  source: Uint8Array;
  destination: Uint8Array;
  selection: readonly number[];
  landing: number;
  landingMode: LandingMode;
  options: ExpanderOptions;
  /** Returns true to go ahead. Injected so this module never reaches for `window`. */
  ask: (question: string) => boolean;
}): PlanOutcome {
  if (args.selection.length === 0) throw new PlanningRefused("no patterns selected");

  const base = {
    source: args.source,
    patterns: [...args.selection],
    destination: args.destination,
    landing: args.landing,
    landingMode: args.landingMode,
    // Scoped to the selection, **not** the whole-project plan. Handing that one over made the
    // merge allocate tracks against 128 patterns of competition — the layout it produced was not
    // the one the panel above described, and not the one asked for.
    plan: planFor(args.source, args.selection, args.options),
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

    if (!args.ask(`${error.message}\n\nGo ahead anyway?`)) {
      return { described: { lines: [error.message, "Not planned."] }, message: "Not planned." };
    }
    plan = planPatternMerge({
      ...base,
      ...(overwrite ? { confirmOverwrite: true } : {}),
      ...(overflow ? { allowPoolOverflow: true, confirmOverwrite: true } : {}),
    });
  }

  return {
    described: { lines: describeMerge(plan), notes: plan.notes },
    image: plan.image,
    // What to do next, not what the panel already says. The panel's first line is this same
    // landing list; repeating it in the bar made the bar look like a leftover rather than a prompt.
    message:
      `Planned — press Apply to fold ${plan.landingSlots.length} pattern(s) into ` +
      `${plan.landingSlots.map(patternName).join(", ")}, ${describeLanding(args.landingMode)}.`,
  };
}

/** Raised where the page can say something useful rather than throwing a stack at somebody. */
export class PlanningRefused extends Error {}

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
 *
 * Returns the plan to render and the heading, rather than writing them, so the same decision can
 * be checked without a page.
 */
export function reportScope(args: {
  merging: boolean;
  /** Patterns already folded into the destination. */
  merged: readonly number[];
  selection: readonly number[];
}): { patterns?: number[]; heading: string } {
  if (!args.merging) return { heading: "— the whole project" };

  const scope = [...new Set([...args.merged, ...args.selection])].sort((a, b) => a - b);
  if (scope.length === 0) return { heading: "" };

  const inPlace = args.merged.length;
  return {
    patterns: scope,
    heading:
      inPlace === scope.length
        ? `— ${scope.length} pattern(s) merged: ${scope.map(patternName).join(" ")}`
        : `— ${scope.map(patternName).join(" ")} (${scope.length - inPlace} not applied yet)`,
  };
}

/**
 * Conversion notes, **folded away**.
 *
 * These used to be printed straight into the plan strip — over a thousand `<li>`s of "inferred at
 * DN1+173 -> DN2+229", which grew the sticky bar past the height of the page and drew the rest of
 * the tool underneath it. They are diagnostics about the field mapping, worth having and worth
 * nobody's whole screen, so they live behind a disclosure with their counts folded in.
 */
export function renderNotes(notes: readonly MergeNote[] | undefined): string {
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

/** A described plan as the strip shows it: the lines, then the notes behind a disclosure. */
export function renderDescribed(described: Described): string {
  return (
    `<ul>${described.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` +
    renderNotes(described.notes)
  );
}
