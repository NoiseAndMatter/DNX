/**
 * What a job looks like on disk, and where it lives.
 *
 * **One job: the shape and the atomic write.** Reporting progress is `job.ts`, listing what is
 * there is `read.ts`, drawing it is `render.ts`. This is the contract the three of them share, and
 * it is a file on disk rather than a function call because the pane is a **separate process**: it
 * runs in a terminal split beside Claude Code and watches a directory, so nothing has to connect
 * to anything.
 *
 * ## The format is the firmware repositories', deliberately
 *
 * `bstp_custom_fw/tools/progress.py` and `dn2_firmware/tools/dn2progress.py` already do this, and
 * their record is what this writes: the same field names, the same states, the same one file per
 * job named by its id. So their panes can read DNX's jobs and this pane can read theirs, and
 * somebody watching three repositories at once needs one window rather than three.
 *
 * Inventing a near-identical format would have cost nothing today and made that impossible later,
 * which is the whole argument for copying it.
 *
 * ## Seconds, not milliseconds
 *
 * `started`, `updated` and `ended` are **seconds** as a float, because `time.time()` is what wrote
 * them first. `Date.now()` is milliseconds and putting one in this field makes every job look like
 * it started in the year 56000, with an elapsed time to match. It is the one easy mistake here and
 * it is why there is a named helper rather than a bare call at each site.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where the job files go. One directory, watched by the pane. */
export function progressDir(): string {
  return process.env["DNX_PROGRESS_DIR"] ?? join(process.cwd(), "out", "progress");
}

/**
 * How a child job finds its parent.
 *
 * A job sets this for anything it spawns, so the pane can show a tree: the emulator boots that a
 * test run started belong under it rather than beside it. Each repository uses its own name, so a
 * job started from one does not adopt a parent in another by accident.
 */
export const PARENT_ENV = "DNX_PROGRESS_PARENT";

/** Seconds since the epoch, as the Python writers record them. */
export function now(): number {
  return Date.now() / 1000;
}

/** What a job is doing. `lost` is never written: `read.ts` decides it. */
export type JobState = "running" | "done" | "failed" | "lost";

/** One job's file. Field for field the record the firmware repositories' panes read. */
export interface JobRecord {
  id: string;
  name: string;
  /** The writing process, so a reader can tell a finished job from an abandoned one. 0 when none. */
  pid: number;
  /** The job that started this one, or `null`. */
  parent: string | null;
  started: number;
  updated: number;
  /** When it stopped, or `null` while it runs. */
  ended: number | null;
  done: number;
  /** `null` when the job cannot say how much there is, which means no percentage. */
  total: number | null;
  step: string;
  detail: string;
  state: JobState;
}

/** `Ghidra dump 3` becomes `Ghidra-dump-3`, so an id is a filename. */
export function slug(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "job";
}

/**
 * Write a record, atomically.
 *
 * A temporary file and a rename, so a reader never sees half a file: the pane reads this directory
 * every second and a partial write would show as a job that vanished and came back. The retry is
 * Windows, where a reader holding the file open makes the rename fail for a moment; five attempts
 * at 20 ms is far longer than that lasts, and giving up silently is right because **a dropped
 * progress update must never be able to fail the job it is reporting on**.
 */
export function writeRecord(record: JobRecord): void {
  const dir = progressDir();
  const path = join(dir, `${record.id}.json`);
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, JSON.stringify(record), "utf8");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(temporary, path);
      return;
    } catch {
      // Busy-wait rather than sleep: this is microseconds on the happy path and the alternative is
      // making every caller of `update` asynchronous for a case that almost never happens.
      const until = Date.now() + 20;
      while (Date.now() < until) { /* hold */ }
    }
  }
}

/** `3725` becomes `1h02m`, `95` becomes `1m35s`, `7` becomes `7s`. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
