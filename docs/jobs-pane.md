# The jobs pane

Status: VERIFIED, 2026-10-13.

A terminal split beside Claude Code showing every long job this repository is running, redrawn
each second. `bstp_custom_fw/tools/jobs.py` and `dn2_firmware/tools/dn2progress.py` do this
already; this is the same thing for DNX, reading and writing **the same record**, so one pane can
watch any of the three.

```
npm run jobs                    # the pane
npm run jobs -- --once          # one frame, for a script or a check
npm run job -- --name "tests" -- npm test
```

Keys in the pane: `c` collapses to one line a job, `f` shows or hides finished jobs, `p` prunes
finished jobs older than a day, `q` quits.

In a Windows Terminal split:

```
wt -w 0 split-pane -V --size 0.35 -d D:\01_Code\Z_Personal\DNX npm run jobs
```

## Why it is worth having here

Two things in this repository take minutes and say nothing while they do. `npm test` is a few
minutes once the emulator is configured, because every emulator test boots the OS and that is
about 25 seconds each. A device read against a real instrument is slower still.

The emulator boot reports itself, so the pane names the image being booted and shows the
emulator's last line while it waits. That was the first thing worth watching and it is wired in
`src/node/emulatorbridge.ts`.

## The three ways to report

**A wrapped command**, for anything that will never know about this:

```
npm run job -- --name "web build" -- npm run build:web
```

Output passes straight through, the last line becomes the job's detail, and the exit code becomes
its state and this process's exit code. A `k/n` anywhere in a line sets the progress, unless
`--total` said otherwise.

**From code**, for work that can say more about itself:

```ts
const job = Job.start("reading the +Drive", { total: 128 });
try {
  job.advance({ step: `project ${n}` });
} finally {
  job.end();
}
```

or `Job.around(name, options, work)`, which ends the job either way and marks it failed if the
work throws. The error is rethrown untouched: this watches work, it does not handle it.

**By hand**, for work with no process to wrap, such as a run inside somebody else's server or
something a person is doing at the instrument:

```
npm run job -- begin --name "flash and listen" --total 4   # prints the job id
npm run job -- step <id> --done 2 --step "listening"
npm run job -- end <id> [--failed] [--detail TEXT]
```

Those carry pid 0, because nothing can be asked whether they are still going. The pane shows one
as **lost** after an hour of silence rather than as running for ever.

## What the pane can tell you that a log cannot

**`lost` is its own state.** A job whose process was killed leaves a file saying `running`. A pane
that believed it would show a bar that never moves and never ends, which is worse than silence,
because somebody waits for it. Liveness is checked against the operating system, not against the
file.

**A job that another job started sits under it**, so a test run's emulator boots are children
rather than a flat list of fifteen identical lines.

## Where the files are

`out/progress/`, one small JSON file a job, gitignored. `DNX_PROGRESS_DIR` moves it, which is what
the tests use so a run never disturbs a pane in the next split.

Times are **seconds** as a float, because `time.time()` wrote this field first. A `Date.now()` in
one of them makes the job look like it started in the year 56000, with an elapsed time to match.
It is the one easy mistake in the format and `test/progress.test.ts` checks for it.

Nothing a job does may break the work it watches: every write is wrapped and every failure is
swallowed. A full disk or a deleted directory costs a missing bar, never a failed test or an
abandoned device write.

## The layering, and where this lives

`src/node/progress/`, not `src/progress/`. It reads the filesystem and asks the operating system
about process ids, and `test/web.test.ts` allows `node:` imports only under `src/node` and
`src/cli`. The first draft put it at the top of `src/` and that test refused it, correctly: these
modules are shared with the browser build unless they are somewhere the config excludes.

- `record.ts` — the shape, the directory, the atomic write
- `job.ts` — reporting one job
- `read.ts` — listing them, and deciding which are lost
- `render.ts` — a frame, as a pure function, which is the part with a test
- `src/cli/jobs.ts` — the terminal loop and the keys
- `src/cli/progress.ts` — the wrapper and the by-hand commands
