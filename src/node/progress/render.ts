/**
 * Turning the job list into the lines of the pane.
 *
 * **One job, and it is a pure function, which is the point.** Reading the directory is `read.ts`
 * and the terminal loop is `src/cli/jobs.ts`. Everything that decides what a frame says lives
 * here, where a test passes it jobs and reads the strings back without a terminal, a clock or a
 * directory.
 *
 * That split is why the tree arithmetic, the truncation and the "lost" wording are checkable at
 * all. A renderer tangled into the redraw loop is one nobody tests, and the parts of this that
 * are easy to get wrong — a child whose parent has been pruned, a name longer than the window —
 * are exactly the parts a loop makes unreachable.
 *
 * ## The layout follows the firmware repositories'
 *
 * Same marks, same colours, same two forms. Somebody watching DNX in one split and the firmware
 * in another should not have to learn the pane twice, and the format on disk is already theirs.
 */

import { type LiveJob } from "./read.js";
import { clock } from "./record.js";

const COLOUR: Record<string, string> = {
  running: "\x1b[36m",
  done: "\x1b[32m",
  failed: "\x1b[31m",
  lost: "\x1b[33m",
};
const MARK: Record<string, string> = { running: "▶", done: "✔", failed: "✘", lost: "?" };
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

export interface RenderOptions {
  /** One line per job instead of four. */
  compact: boolean;
  /** Whether finished jobs are shown at all. */
  showFinished: boolean;
  /** How long a finished job stays on screen, in minutes. */
  keepMinutes: number;
  /** Terminal width. */
  columns: number;
  /** Seconds since the epoch, passed in so a test is not at the mercy of the clock. */
  at: number;
  /** What the clock in the header says. Passed in for the same reason. */
  time: string;
}

/** How far along, or `undefined` when the job never said how much there was. */
function percentOf(job: LiveJob): number | undefined {
  const total = job.total ?? 0;
  if (total <= 0) return undefined;
  return Math.max(0, Math.min(100, (100 * (job.done ?? 0)) / total));
}

function bar(percent: number | undefined, width: number): string {
  if (percent === undefined) return `${DIM}${"·".repeat(width)}${OFF}`;
  const filled = Math.round((width * percent) / 100);
  return `${"█".repeat(filled)}${DIM}${"░".repeat(Math.max(0, width - filled))}${OFF}`;
}

/**
 * Jobs in display order, each with its depth.
 *
 * **A job whose parent is not in the list is drawn at the top level**, which matters more than it
 * looks: a parent can be pruned, or finished and aged out, while its child still runs. Treating a
 * missing parent as no parent keeps that child visible. Attaching it to an id nothing holds would
 * drop it from the walk entirely, and the one job still running would be the one not shown.
 */
export function tree(items: readonly LiveJob[]): { depth: number; job: LiveJob }[] {
  const present = new Set(items.map((job) => job.id));
  const children = new Map<string | null, LiveJob[]>();
  for (const job of items) {
    const parent = job.parent !== null && present.has(job.parent) ? job.parent : null;
    const list = children.get(parent) ?? [];
    list.push(job);
    children.set(parent, list);
  }

  const out: { depth: number; job: LiveJob }[] = [];
  const walk = (parent: string | null, depth: number): void => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.started - b.started);
    for (const job of list) {
      out.push({ depth, job });
      walk(job.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Which jobs a frame shows: everything running, and recent finished ones when asked. */
export function visible(jobs: readonly LiveJob[], options: RenderOptions): LiveJob[] {
  return jobs.filter((job) => {
    if (job.state === "running") return true;
    if (!options.showFinished) return false;
    return options.at - (job.ended ?? job.updated ?? options.at) < options.keepMinutes * 60;
  });
}

/** One frame, as lines. */
export function render(jobs: readonly LiveJob[], options: RenderOptions): string[] {
  const { columns, compact } = options;
  const items = visible(jobs, options);
  const running = items.filter((job) => job.state === "running").length;
  const keys =
    columns >= 72 ? "c compact · f finished · p prune · q quit" : "c f p q";

  const lines = [
    `${BOLD}dnx jobs${OFF}  ${running} running  ${DIM}${options.time}   ${keys}${OFF}`,
    "",
  ];
  if (items.length === 0) {
    lines.push(`${DIM}  no jobs${OFF}`);
    return lines;
  }

  for (const { depth, job } of tree(items)) {
    const indent = "  ".repeat(depth);
    const head = `${indent}${COLOUR[job.state] ?? ""}${MARK[job.state] ?? "·"}${OFF} ${BOLD}${job.name}${OFF}`;
    const fraction = percentOf(job);
    const count = job.total ? `${job.done}/${job.total}` : "";
    const percent = fraction === undefined ? "     " : `${fraction.toFixed(1).padStart(5)}%`;
    const info = `${percent} ${count.padStart(7)} ${clock(job.elapsed).padStart(7)}`;

    if (compact) {
      const room = Math.max(0, columns - job.name.length - 2 * depth - info.length - 6);
      lines.push(`${head}  ${info}  ${DIM}${(job.step || "").slice(0, room)}${OFF}`);
      continue;
    }

    lines.push(head);
    const width = Math.max(10, Math.min(40, columns - 2 * depth - 32));
    lines.push(`${indent}  ${bar(fraction, width)} ${info}`);
    if (job.step) {
      lines.push(`${indent}  step  ${job.step.slice(0, Math.max(0, columns - 2 * depth - 8))}`);
    }
    if (job.detail) {
      lines.push(`${indent}  ${DIM}${job.detail.slice(0, Math.max(0, columns - 2 * depth - 4))}${OFF}`);
    }
  }
  return lines;
}
