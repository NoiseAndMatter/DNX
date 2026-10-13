/**
 * The progress pane's job records, and the frame drawn from them.
 *
 * The rendering is a pure function on purpose, so these pass it jobs and read the strings back
 * without a terminal, a clock or a directory. `at` and `time` are arguments for exactly that
 * reason: a renderer that reads the clock itself can only be tested by waiting.
 *
 * The writer's tests use a directory of their own through `DNX_PROGRESS_DIR`, so a run never
 * touches the one the pane in the next split is watching.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Job } from "../src/node/progress/job.js";
import { readJobs, prune } from "../src/node/progress/read.js";
import { render, tree, visible } from "../src/node/progress/render.js";
import { type JobRecord, clock, now } from "../src/node/progress/record.js";
import { type LiveJob } from "../src/node/progress/read.js";

let dir = "";
const before_ = process.env["DNX_PROGRESS_DIR"];

before(() => {
  dir = mkdtempSync(join(tmpdir(), "dnx-progress-"));
  process.env["DNX_PROGRESS_DIR"] = dir;
});

after(() => {
  if (before_ === undefined) delete process.env["DNX_PROGRESS_DIR"];
  else process.env["DNX_PROGRESS_DIR"] = before_;
  rmSync(dir, { recursive: true, force: true });
});

/** A job record with everything filled, so a test only states what it is about. */
function record(over: Partial<LiveJob> = {}): LiveJob {
  const at = 1_000_000;
  return {
    id: "1-1-a", name: "a", pid: 1, parent: null,
    started: at, updated: at, ended: null,
    done: 0, total: null, step: "", detail: "", state: "running",
    alive: true, elapsed: 5,
    ...over,
  };
}

test("clock says hours, minutes or seconds, and never a negative", () => {
  assert.equal(clock(7), "7s");
  assert.equal(clock(95), "1m35s");
  assert.equal(clock(3725), "1h02m");
  assert.equal(clock(0), "0s");
  assert.equal(clock(-4), "0s");
});

test("a job writes a file, advances, and ends as done", () => {
  const job = Job.start("a build", { total: 3, step: "starting" });
  job.advance({ step: "compiling" });
  job.update({ detail: "one line" });
  job.end();

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1, "the job wrote no file");

  const written = JSON.parse(
    readFileSync(join(dir, `${job.id}.json`), "utf8"),
  ) as JobRecord;
  assert.equal(written.name, "a build");
  assert.equal(written.total, 3);
  assert.equal(written.done, 1);
  assert.equal(written.step, "compiling");
  assert.equal(written.detail, "one line");
  assert.equal(written.state, "done");
  assert.ok(written.ended !== null, "a finished job must record when it ended");

  /*
   * **Seconds, not milliseconds.** The Python panes in the firmware repositories wrote this field
   * first with `time.time()`, and a `Date.now()` here makes every job look like it started in the
   * year 56000. The check is loose on purpose: it is about the unit, not the instant.
   */
  assert.ok(written.started > 1_600_000_000 && written.started < 4_000_000_000,
    `started is ${written.started}, which is not seconds since the epoch`);
});

test("a job that throws is marked failed, and the error is not swallowed", async () => {
  await assert.rejects(
    Job.around("a run", {}, async () => {
      throw new Error("the thing broke");
    }),
    /the thing broke/,
    "around must rethrow: it watches work, it does not handle it",
  );

  const failed = readJobs().find((j) => j.name === "a run");
  assert.ok(failed, "the failed job was not written");
  assert.equal(failed.state, "failed");
  assert.match(failed.detail, /the thing broke/);
});

test("a running job whose process is gone reads as lost", () => {
  // pid 1 is this test's own stand-in for a live process; a pid nothing holds is the other case.
  const gone: JobRecord = {
    id: "99-1-gone", name: "abandoned", pid: 0x7ffffffe, parent: null,
    started: now() - 10, updated: now() - 10, ended: null,
    done: 0, total: null, step: "", detail: "", state: "running",
  };
  writeFileSync(join(dir, `${gone.id}.json`), JSON.stringify(gone), "utf8");

  const found = readJobs().find((j) => j.id === gone.id);
  assert.ok(found);
  assert.equal(found.state, "lost", "a running record with no process must not read as running");
  assert.equal(found.alive, false);
});

test("a file that is not a job is skipped rather than taking the list down", () => {
  writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ hello: "world" }), "utf8");
  // The real jobs from the tests above are still there.
  assert.ok(readJobs().length > 0, "one bad file emptied the whole list");
  assert.ok(!readJobs().some((j) => j.id === undefined));
});

test("prune removes only jobs that stopped long ago", () => {
  const old: JobRecord = {
    id: "1-9-old", name: "old", pid: 0, parent: null,
    started: now() - 200_000, updated: now() - 200_000, ended: now() - 200_000,
    done: 1, total: 1, step: "", detail: "", state: "done",
  };
  writeFileSync(join(dir, `${old.id}.json`), JSON.stringify(old), "utf8");
  const removed = prune();
  assert.ok(removed >= 1, "the aged job was not pruned");
  assert.ok(!readJobs().some((j) => j.id === old.id));
});

test("a child sits under its parent, and an orphan sits at the top", () => {
  const parent = record({ id: "p", name: "parent", started: 1 });
  const child = record({ id: "c", name: "child", parent: "p", started: 2 });
  /*
   * **The orphan is the case worth having.** A parent can be pruned, or finish and age out, while
   * its child is still running. Hanging the child off an id nothing holds would drop it from the
   * walk entirely, and the one job still going would be the one not drawn.
   */
  const orphan = record({ id: "o", name: "orphan", parent: "long-gone", started: 3 });

  const order = tree([child, orphan, parent]);
  assert.deepEqual(
    order.map((row) => [row.job.id, row.depth]),
    [["p", 0], ["c", 1], ["o", 0]],
  );
});

test("a frame shows running jobs, and finished ones only while they are recent", () => {
  const at = now();
  const options = { compact: false, showFinished: true, keepMinutes: 10, columns: 100, at, time: "12:00:00" };
  const running = record({ id: "r", name: "running one" });
  const justDone = record({ id: "d", name: "just done", state: "done", ended: at - 60 });
  const longDone = record({ id: "l", name: "long done", state: "done", ended: at - 7200 });

  const shown = visible([running, justDone, longDone], options).map((j) => j.id);
  assert.deepEqual(shown, ["r", "d"], "a job finished two hours ago is still on screen");

  const hidden = visible([running, justDone], { ...options, showFinished: false }).map((j) => j.id);
  assert.deepEqual(hidden, ["r"]);
});

test("a frame draws the bar, the counts and the step", () => {
  const at = now();
  const lines = render(
    [record({ name: "emulator boot", done: 2, total: 4, step: "loading the image", detail: "sector 3" })],
    { compact: false, showFinished: true, keepMinutes: 10, columns: 100, at, time: "12:00:00" },
  ).join("\n");

  assert.match(lines, /dnx jobs/);
  assert.match(lines, /1 running/);
  assert.match(lines, /emulator boot/);
  assert.match(lines, /50\.0%/, "a job with a total must show its percentage");
  assert.match(lines, /2\/4/);
  assert.match(lines, /loading the image/);
  assert.match(lines, /sector 3/);
});

test("a job with no total shows no percentage rather than zero", () => {
  // Zero per cent and "cannot say" are different claims, and a full-looking empty bar is the
  // version that makes somebody think the job is stuck.
  const lines = render(
    [record({ name: "reading", total: null })],
    { compact: false, showFinished: true, keepMinutes: 10, columns: 100, at: now(), time: "12:00:00" },
  ).join("\n");
  assert.doesNotMatch(lines, /0\.0%/);
  assert.match(lines, /reading/);
});

test("a narrow window does not produce negative widths or spill", () => {
  // `slice` and `repeat` both throw or misbehave on a negative count, and a split pane is narrow.
  for (const columns of [1, 10, 24, 40]) {
    const lines = render(
      [record({ name: "a very long job name that will not fit", step: "x".repeat(200), detail: "y".repeat(200), done: 1, total: 2 })],
      { compact: false, showFinished: true, keepMinutes: 10, columns, at: now(), time: "12:00:00" },
    );
    assert.ok(lines.length > 0, `nothing drawn at ${columns} columns`);
    assert.ok(lines.every((line) => typeof line === "string"));
  }
});

test("an empty directory says so instead of drawing nothing", () => {
  const lines = render([], {
    compact: false, showFinished: true, keepMinutes: 10, columns: 100, at: now(), time: "12:00:00",
  }).join("\n");
  assert.match(lines, /no jobs/);
  assert.match(lines, /0 running/);
});
