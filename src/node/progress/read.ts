/**
 * Listing what is in the progress directory, and deciding which jobs are still real.
 *
 * **One job: the directory becomes a list a pane can draw.** Writing is `job.ts`, drawing is
 * `render.ts`, and keeping those apart is what lets the renderer be a pure function with a test.
 *
 * ## A running job whose process has gone is `lost`, not running
 *
 * The one judgement here, and it earns its place. A job that is killed, or whose process crashes,
 * leaves a file saying `running` forever. A pane that believed it would show a bar that never
 * moves and never ends, which is worse than saying nothing: somebody waits for it.
 *
 * So liveness is checked against the operating system rather than against the file. `process.kill(pid, 0)`
 * sends no signal and throws when the process is gone, which is the portable form of the question.
 *
 * **A job with pid 0 cannot be asked.** Those come from the command-line `begin`/`end` pair, where
 * the thing being watched is not a process at all: a run inside somebody else's server, or a step
 * a person is doing. For those the only evidence is silence, and an hour of it is taken as lost.
 */

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type JobRecord, type JobState, now, progressDir } from "./record.js";

/** A job with the things a pane needs that the file does not carry. */
export interface LiveJob extends JobRecord {
  /** Whether the work is still going, as far as anything here can tell. */
  alive: boolean;
  /** Seconds it has run, frozen at `ended` once it has. */
  elapsed: number;
}

/** A pid 0 job silent this long is taken as lost. */
const MANUAL_TIMEOUT = 3600;

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every job, newest first. */
export function readJobs(): LiveJob[] {
  const dir = progressDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // No directory means no jobs, which is the ordinary state of a fresh checkout.
    return [];
  }

  const at = now();
  const out: LiveJob[] = [];
  for (const name of names) {
    let record: JobRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, name), "utf8")) as JobRecord;
    } catch {
      // A file being replaced as we read it, or one somebody hand-edited. Skipping is right: the
      // pane redraws in a second and a parse error must not take the whole list down.
      continue;
    }
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;

    const pid = Number(record.pid ?? 0);
    const alive =
      record.state === "running" &&
      (pid > 0 ? processAlive(pid) : at - (record.updated ?? 0) < MANUAL_TIMEOUT);
    const state: JobState = record.state === "running" && !alive ? "lost" : record.state;

    /*
     * **No percentage here.** It is `done` over `total`, both of which the renderer already has,
     * and a derived field alongside the two it derives from is a field that can disagree with
     * them. `render.ts` works it out where it draws it.
     */
    out.push({
      ...record,
      state,
      alive,
      elapsed: (record.ended ?? at) - (record.started ?? at),
    });
  }
  out.sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
  return out;
}

/** Remove the files of jobs that stopped more than `olderThan` seconds ago. Returns how many. */
export function prune(olderThan = 86_400): number {
  const dir = progressDir();
  const at = now();
  let removed = 0;
  for (const job of readJobs()) {
    if (job.state === "running") continue;
    if (at - (job.ended ?? job.updated ?? at) <= olderThan) continue;
    try {
      unlinkSync(join(dir, `${job.id}.json`));
      removed += 1;
    } catch {
      // Already gone, or held open. Either way there is nothing useful to do about it.
    }
  }
  return removed;
}
