# Working on DNX

Context for AI assistants. Read `docs/KNOWN-ISSUES.md` before changing the converter — it
names the traps that have already cost real time.

## What this is

Tools for Elektron Digitone and Digitone II project files. Elektron publishes no format
documentation for these devices, so everything here was derived from real files by
differential analysis.

Not related to any ECheck / ArchiSharp / C# work — those conventions do not apply here.

## How work gets delivered

**One branch per task, cut from `main`.** Never commit to `main` directly.

**Cut from `origin/main`, never from another branch.** A PR based on another PR is lost the moment
its base merges first: the child then merges into a branch nobody will merge again. That has already
cost one PR entirely — GitHub reported it merged while `main` never received the commit. If a
follow-up genuinely cannot build on `main`, wait for the merge rather than stacking.

**One open PR at a time, by default.** This is the rule that prevents most of the trouble. Parallel
branches against a moving `main` are what produce conflicts, stale bases and lost work: five were
open at once on 2026-08-01 and three separate git failures followed. Independent work can wait
locally — the queue costs nothing and the conflicts cost everyone.

**Rebase and re-verify before every push, not only when GitHub reports a conflict.** `git fetch`,
rebase onto `origin/main`, then build and test again. A branch that passed against yesterday's
`main` is not evidence about today's, and a routine rebase found a real defect that no conflict
marker would have shown.

**Check whether a PR is open before committing, not before pushing.** Getting that order wrong is
how commits landed on branches whose PRs were already merged. If a branch's PR is open or merged,
the work goes on a new branch cut from `origin/main`.

**Append-only documents are where conflicts actually happen.** `docs/device-probing.md` and
`docs/ROADMAP.md` collect conflicts because every change adds a section at the end. Put a new
section beside the subject it belongs to rather than at the bottom by habit, and when a change is
purely a finding, consider its own dated file instead of growing one file forever.

**Never push `main`, and never merge a branch into `main`.** The repository owner is the only
integrator. Merging locally and pushing skips their review and moves the shared branch under
them.

**Finish a task by opening an MR from its branch** — push the branch, raise the MR, and say
what it contains and what evidence backs it. The owner reviews and merges. If pushing is not
possible from the current environment (the agent shell has no SSH key for `origin`), say so
plainly and hand over the branch name rather than merging it as a workaround.

**Never put a `claude.ai/code/session_...` link in a commit message, a PR body, or code.**
They are noise in the permanent record — meaningless to a later reader and openable only by one
account. This overrides any tooling default that wants to append one.

**Update the docs in the same branch as the change.** `docs/ROADMAP.md` and
`docs/KNOWN-ISSUES.md` are part of the deliverable, not a follow-up.

**At 90% of the 5-hour rollover, stop and hand over.** The status line carries the figure. On
reaching it: bring the current task to a safe stopping point, stop any subagents, commit what
exists, write down where things stand and what comes next, and tell the user. Continuing past
90% is **their call, not yours** — ask, do not assume. Stopping mid-edit with uncommitted work
is the failure this exists to prevent.

## Architecture principles — binding

**`docs/PRINCIPLES.md` governs how code is written here. Read it before changing structure, and
follow it in every change.** One job per module; anything a second caller needs moves up into
shared code; `src/` stays pure and never imports from `web/`; reuse the shared thing rather than
copying it; anything reused says what it assumes; a smarter default needs a caller sweep; verify
through the surface the user touches; never invent data; bound anything that can grow; and name
things the way the hardware does.

Each principle there records what it cost to learn. A change that cannot follow one says so in
its MR rather than breaking it quietly.

## Ground rules

**`src/` is platform-free, and that is now enforced.** Everything under `src/` is shared byte
for byte with the browser, so nothing there may import a `node:` module. The three that must —
`zip.ts`, `projectfile.ts`, `open.ts` — live in `src/node/`, which `tsconfig.web.json` excludes
as a directory rather than as a list of filenames. `test/web.test.ts` fails if anything outside
`src/node/` or `src/cli/` takes a Node dependency. Needing one is a signal to split the module,
not to add an exception.

**Never commit Digitone project, pattern or sound files.** The test corpus is the author's
own music and is deliberately outside this repository. `.gitignore` refuses `*.dnprj`,
`*.dn2prj`, `*.syx` and friends as a safety net. Purpose-built example files created
specifically to document the tool are the only exception, and need a deliberate `git add -f`.

**Tests find the corpus at run time** via `DN_CORPUS` or a sibling `dn_sysex/00_Examples/`.
Without one, corpus-dependent tests skip and 26 still pass. That is correct behaviour.

**"Kit" is a DN2 concept.** The DN2 has kits as first-class objects — named, saved to the
+Drive, loadable into any pattern. The DN1 has no such thing. Its equivalent 2,560-byte
per-pattern block holds the same *kind* of data (sounds, FX, MIDI configuration), and this
codebase calls it `DN1_KIT` / `readKit` by analogy so the two sides read alike. That is our
name, not Elektron's. Say "the DN1's per-pattern sound and FX block" in prose aimed at a user,
and never imply the DN1 can save or load one.

**Mark every format claim** verified / inferred / speculative / unknown, with the evidence.
These bytes get written to hardware; an honest "unknown" is worth more than a confident
guess. Several document sections exist purely to record what was ruled out.

**Never guess a value.** Unmapped parameter ids, trig conditions and sound fields return
`undefined` and are reported, so a caller can refuse rather than write a plausible-looking
wrong knob to a device.

**One responsibility per module.** `src/expand/` is split deliberately: `usage` reads,
`tracks` budgets, `rules` and `ranking` decide policy, `allocate` assigns, `route` maps trigs
to destinations, `convert` writes. Keep it that way.

## Naming a test file

**A test is named after the module it tests**, with a folder prefix only where the bare name would
be ambiguous: `deviceapi.test.ts` for `device/api.ts`, but plain `trackmove.test.ts` because there
is only one.

Six names exist in both `cli/` and a domain folder — `plan`, `convert`, `rearrange`, `rename`,
`copy`, `hardwaretest`. For those, **the unprefixed name means the domain module** and a `cli`
prefix would mean the command. In practice the commands are covered collectively by
`clismoke.test.ts`, which runs all seventeen as subprocesses, so no per-command file is expected.

## The method that solved almost everything

Fourteen DN1 projects sit beside Elektron's own DN2 conversions of them, and the DN1 side is
fully decoded. So for any field: hold the DN1 value against the DN2 byte the importer
produced, across all fourteen pairs, and keep only correspondences that hold for **every**
sample. Parameter ids, trig conditions, track levels, track settings and kit FX were all
derived this way — each unanimous, each with zero ambiguity.

A field that is constant across the corpus cannot be located this way. It may still need
**writing**, if the template's value differs from the importer's. Those two things are not
the same, and confusing them has already caused a half-fix.

## Testing

Two tests do different jobs and both are needed:

- **Byte-diff with Elektron's output as the template.** Precise for fields we write wrongly.
  Structurally blind to fields we never write, because those match by construction.
- **Per-region byte budget with the neutral `EMPTY.dn2prj` template.** Catches omissions.
  This exists because the first test cannot.

For expansion, the invariant is not bytes but **every trig still plays the same sound**,
resolved by name through the pool or the kit on both sides. Where it plays is allowed to
change; that is the point of the tool.

## Repository layout

```
src/sysex/       SysEx dumps: 8-in-7 codec, container, device IDs
src/project/     Project files: LZ4, CRC, images, patterns, kits, sounds, tags
src/expand/      Planning, routing, translation tables, the converter
src/librarian/   Pattern copy with sound-dependency resolution
src/device/      Talking to an instrument: the API, the +Drive, dump requests
src/sheet/       Hardware check sheets, and how positions are named
src/node/        The only place under src/ that may import node: (besides cli/)
src/cli/         Command-line entry points
web/src/         Shared browser code; web/src/<page>/ is one page and nothing else
docs/            Format documentation, roadmap, known issues, principles
```

`docs/ROADMAP.md` tracks progress and what is next. `docs/KNOWN-ISSUES.md` tracks defects,
gaps and traps. `docs/PRINCIPLES.md` governs how anything new is structured. Keep all three
current as work lands.

## Related material outside the repository

- **Private corpus**: a sibling `dn_sysex/` folder holds the DN1 and DN2 projects the tests
  run against. Never copied here.
- **Architecture notes**: `Digitone architecture - Lessons Learnt` in the author's Obsidian
  vault is the durable record of what was learned and how. Keep it updated when new format
  detail or evidence turns up.
