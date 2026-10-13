/**
 * Reporting one long job's progress, for the pane to draw.
 *
 * **One job: keeping a record current while work happens.** The shape is `record.ts`, listing is
 * `read.ts`, drawing is `render.ts`.
 *
 *     const job = Job.start("emulator boot", { total: 4 });
 *     try {
 *       job.advance({ step: "loading the image" });
 *       ...
 *     } finally {
 *       job.end();
 *     }
 *
 * or, for the common case where the work is a promise, `Job.around` does the `finally` and marks
 * the job failed if it throws.
 *
 * ## Nothing here may break the work it watches
 *
 * Every write is wrapped and every failure is swallowed, in `record.ts`. A full disk, a read-only
 * checkout or a directory somebody deleted mid-run must cost a missing bar in a pane, never a
 * failed test or an abandoned device write. That is also why none of this is asynchronous: an
 * `await` in the middle of a device transfer to report on the device transfer is a new ordering
 * hazard in exchange for nothing.
 *
 * ## Writes are throttled, except when the shape changes
 *
 * A loop calling `advance` ten thousand times must not write ten thousand files. A quarter second
 * between writes is plenty for a pane redrawing once a second. **A new step, total or state is
 * always written immediately**, because those are the parts somebody is watching for, and a step
 * that appears a quarter second late in a pane reads as a job that stalled.
 */

import {
  type JobRecord,
  type JobState,
  PARENT_ENV,
  now,
  slug,
  writeRecord,
} from "./record.js";

/** Seconds between writes of one job, when nothing about its shape changed. */
const MIN_INTERVAL = 0.25;

let counter = 0;

export interface JobOptions {
  /** How many units of work, when the job knows. Without it the pane shows no percentage. */
  total?: number;
  /** What it is doing right now. */
  step?: string;
  /** Override the parent. Normally the environment carries it. */
  parent?: string | null;
}

export interface UpdateOptions {
  done?: number;
  total?: number;
  step?: string;
  detail?: string;
  state?: JobState;
}

export class Job {
  private readonly record: JobRecord;
  private lastWrite = 0;
  private readonly parentBefore: string | undefined;
  private finished = false;

  private constructor(name: string, options: JobOptions) {
    counter += 1;
    const started = now();
    this.record = {
      id: `${process.pid}-${counter}-${slug(name)}`,
      name,
      pid: process.pid,
      parent: options.parent !== undefined ? options.parent : process.env[PARENT_ENV] ?? null,
      started,
      updated: started,
      ended: null,
      done: 0,
      total: options.total ?? null,
      step: options.step ?? "",
      detail: "",
      state: "running",
    };
    // Anything this job spawns adopts it as a parent, which is what makes the pane a tree.
    this.parentBefore = process.env[PARENT_ENV];
    process.env[PARENT_ENV] = this.record.id;
  }

  /** Begin a job. Always pair with `end`, or use `around`. */
  static start(name: string, options: JobOptions = {}): Job {
    const job = new Job(name, options);
    job.write(true);
    return job;
  }

  /**
   * Run `work` as a job, ending it either way.
   *
   * The job is marked failed and the error's message kept as the detail, then the error is
   * rethrown untouched: this watches work, it does not handle it.
   */
  static async around<T>(
    name: string,
    options: JobOptions,
    work: (job: Job) => Promise<T>,
  ): Promise<T> {
    const job = Job.start(name, options);
    try {
      const result = await work(job);
      job.end();
      return result;
    } catch (error: unknown) {
      job.end({ failed: true, detail: String(error).slice(0, 200) });
      throw error;
    }
  }

  get id(): string {
    return this.record.id;
  }

  /** Change what the record says. Anything left out is left alone. */
  update(options: UpdateOptions): void {
    if (this.finished) return;
    let shapeChanged = false;
    if (options.done !== undefined) this.record.done = options.done;
    if (options.detail !== undefined) this.record.detail = options.detail;
    for (const key of ["step", "total", "state"] as const) {
      const value = options[key];
      if (value === undefined) continue;
      if (this.record[key] !== value) shapeChanged = true;
      // Each is assigned through its own narrow type; a loop over mixed keys cannot be typed.
      if (key === "step") this.record.step = value as string;
      if (key === "total") this.record.total = value as number;
      if (key === "state") this.record.state = value as JobState;
    }
    this.write(shapeChanged);
  }

  /** One more unit done. */
  advance(options: Omit<UpdateOptions, "done"> & { by?: number } = {}): void {
    const { by = 1, ...rest } = options;
    this.update({ ...rest, done: this.record.done + by });
  }

  /**
   * Finish, which is the only call that must not be forgotten.
   *
   * A job left running with its process gone shows as `lost` rather than as running forever, so
   * forgetting this is visible rather than silent. It is still worth not forgetting.
   */
  end(options: { failed?: boolean; detail?: string } = {}): void {
    if (this.finished) return;
    this.finished = true;
    if (this.parentBefore === undefined) delete process.env[PARENT_ENV];
    else process.env[PARENT_ENV] = this.parentBefore;

    if (this.record.state === "running") {
      this.record.state = options.failed === true ? "failed" : "done";
    }
    if (options.detail !== undefined) this.record.detail = options.detail;
    this.record.ended = now();
    this.write(true);
  }

  private write(force: boolean): void {
    const at = now();
    if (!force && at - this.lastWrite < MIN_INTERVAL) return;
    this.lastWrite = at;
    this.record.updated = at;
    writeRecord(this.record);
  }
}
