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
 * ## Consent is an answer, not a question this module asks
 *
 * Two of the merge's refusals — an occupied landing slot, a pool with no room — are decisions only
 * the person at the instrument can make. This module used to take an `ask` callback and call it
 * *between* two planning passes, which kept the browser out of here but forced the asking to be
 * **synchronous**: the only thing that fits in that slot is `window.confirm`, and a native modal
 * blocks the renderer so thoroughly that the page cannot be told apart from a hung one.
 *
 * So the refusal is now **returned** rather than asked about. `planSelected` plans once, and when
 * it stops on one of those two questions it hands back an `offer`: the sentence, and the overrides
 * that would lift it. The page renders that as a button beside the plan, and pressing it plans
 * again with those overrides. Consent arrives as an argument to the *next* call.
 *
 * That is better than an async callback for a reason beyond the modal:
 *
 * - **The question stays on screen.** A modal is answered and gone; a refusal in the panel can be
 *   read twice, and sits next to the landing controls that are the other way to resolve it.
 * - **Nothing has to be re-entrant.** Planning is triggered by change events, and an `await` in
 *   the middle of one means two plans in flight racing to assign the same variable.
 * - **Consent cannot leak.** It lives for exactly one call. Change the selection, the landing or
 *   an option and the next plan runs with no overrides at all — so agreeing to overwrite `A4` can
 *   never quietly authorise overwriting `A9`.
 */

import { type ExpansionPlan } from "../../../src/expand/types.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../../../src/expand/plan.js";
import {
  MergeRefused,
  describeMerge,
  planPatternMerge,
  type MergeNote,
  type MergePlan,
  type RefusalKind,
} from "../../../src/expand/merge.js";
import { describeDeviceExpand, planDeviceExpand } from "../../../src/expand/deviceexpand.js";
import { type LandingMode, describeLanding } from "../../../src/expand/landing.js";
import { readProjectName } from "../../../src/project/dn1.js";
import { deviceFor } from "../../../src/librarian/device.js";
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
  /**
   * Set when planning stopped on a question the person at the instrument can answer.
   *
   * `image` is always absent alongside it — an offer means nothing was planned. The page renders
   * `message` with a button labelled from `kind`, and passing `overrides` straight back to
   * `planSelected` is what pressing it does.
   */
  offer?: MergeOffer;
}

/** A refusal the page can turn into a button. */
export interface MergeOffer {
  kind: RefusalKind;
  /**
   * Everything needed to get past it, **cumulatively**.
   *
   * Not just the one override this refusal needs: a merge can be refused twice in a row — first
   * for an occupied slot, then for a full pool — and the second offer has to carry the consent
   * already given for the first, or pressing it would re-raise a question already answered.
   */
  overrides: MergeOverrides;
}

/** Consent, as the planner takes it. Both default to absent, which is the safe reading. */
export interface MergeOverrides {
  confirmOverwrite?: boolean;
  allowPoolOverflow?: boolean;
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
  /** The destination as it was opened. What the report counts against; see `planDeviceExpand`. */
  baseline?: Uint8Array;
  plan?: ExpansionPlan;
  /** Consent from a previous outcome's `offer`, for this call only. */
  overrides?: MergeOverrides;
}): PlanOutcome {
  const plan = planDeviceExpand({
    source: args.source,
    destination: args.destination,
    ...(args.baseline === undefined ? {} : { baseline: args.baseline }),
    ...(args.plan === undefined ? {} : { plan: args.plan }),
    projectName: stampedName(readProjectName(args.source)),
    replaceDestination: true,
  });
  const described = { lines: describeDeviceExpand(plan) };
  const kB = Math.round(plan.estimatedBytes / 1024);

  if (plan.pendingSlots.length === 0) {
    return {
      described,
      message:
        plan.changedSlots.length === 0
          ? "The device already holds this conversion — nothing to write."
          : `Applied: ${plan.changedSlots.length} pattern slot(s) differ from the destination as ` +
            `opened, about ${kB} kB.`,
    };
  }

  /*
   * **Asked before, not undone after.** Whole project replaces every pattern in the destination, and
   * it used to do that to a project with content without a word. The manager asks before any
   * destructive operation and names what is lost; this now does the same, through the offer button
   * the merge already uses, so the question stays beside the plan.
   */
  const device = deviceFor(args.destination);
  const losing = plan.pendingSlots.filter((slot) => device.summarise(args.destination, slot).occupied === true);
  if (losing.length > 0 && !args.overrides?.confirmOverwrite) {
    return {
      described,
      level: "warn",
      message:
        `Whole project replaces every pattern in the destination, and ${losing.length} of them hold ` +
        `trigs that would be gone: ${losing.slice(0, 8).map(patternName).join(", ")}` +
        `${losing.length > 8 ? ` +${losing.length - 8} more` : ""}. Undo brings them back until you export.`,
      offer: { kind: "overwrite", overrides: { ...args.overrides, confirmOverwrite: true } },
    };
  }

  return {
    described,
    image: plan.image,
    message: `${plan.pendingSlots.length} pattern slot(s) would change, about ${kB} kB.`,
  };
}

/**
 * Merge the selected patterns into the loaded project, keeping its pool.
 *
 * Both refusals are surfaced rather than swallowed: an occupied landing slot and a pool with no
 * room each stop the plan, and each is something only the person at the instrument can decide.
 * Neither is asked about here — the refusal comes back as `offer`, and the caller decides how to
 * put the question. See the note on consent at the top of this file.
 */
export function planSelected(args: {
  source: Uint8Array;
  destination: Uint8Array;
  selection: readonly number[];
  landing: number;
  landingMode: LandingMode;
  options: ExpanderOptions;
  /**
   * Consent already given, from a previous outcome's `offer.overrides`.
   *
   * Absent means none, which is the only safe default: an override that survived from an earlier
   * call would authorise something the person never saw.
   */
  overrides?: MergeOverrides;
}): PlanOutcome {
  if (args.selection.length === 0) throw new PlanningRefused("no patterns selected");

  const given = args.overrides ?? {};
  const base = {
    source: args.source,
    patterns: [...args.selection],
    destination: args.destination,
    landing: args.landing,
    landingMode: args.landingMode,
    ...given,
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
    // The two refusals worth offering a way past. Anything else stands.
    //
    // **Read off `kind`, not off the sentence.** This matched `/already hold a pattern/` against
    // the message, which made the wording load-bearing: rewriting that refusal so it stopped
    // naming a TypeScript argument at a musician also stopped this asking, and turned a question
    // into a rethrown error. `merge.ts` now says which refusal it is in a field.
    if (error.kind === undefined) throw error;

    return {
      described: { lines: [error.message] },
      message: error.message,
      level: "warn",
      offer: {
        kind: error.kind,
        // **Cumulative.** Overflow needs its own consent — agreeing to overwrite a slot is not
        // agreeing to lose sounds — but the consent already given has to travel, or lifting the
        // second refusal would re-raise the first.
        overrides: {
          ...given,
          ...(error.kind === "overwrite" ? { confirmOverwrite: true } : { allowPoolOverflow: true }),
        },
      },
    };
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

/**
 * What the button lifting an offer should say.
 *
 * Here rather than in the page because the label has to mean the same thing as the refusal it sits
 * under, and the two drifting apart is how a button ends up authorising more than it claims. It
 * names the **action**, never "OK" or "Yes" — those answer a question the user has to have kept in
 * their head, and this button is read on its own, beside a paragraph, days later in a screenshot.
 */
export function offerLabel(kind: RefusalKind): string {
  return kind === "overwrite" ? "Replace what is there" : "Merge without those sounds";
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
