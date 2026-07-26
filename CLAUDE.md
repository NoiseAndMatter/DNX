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

## Ground rules

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
src/project/     Project files: ZIP, LZ4, CRC, images, patterns, kits, sounds, tags
src/expand/      Planning, routing, translation tables, the converter
src/librarian/   Pattern copy with sound-dependency resolution
src/cli/         Command-line entry points
docs/            Format documentation, roadmap, known issues
```

`docs/ROADMAP.md` tracks progress and what is next. `docs/KNOWN-ISSUES.md` tracks defects,
gaps and traps. Keep both current as work lands.

## Related material outside the repository

- **Private corpus**: a sibling `dn_sysex/` folder holds the DN1 and DN2 projects the tests
  run against. Never copied here.
- **Architecture notes**: `Digitone architecture - Lessons Learnt` in the author's Obsidian
  vault is the durable record of what was learned and how. Keep it updated when new format
  detail or evidence turns up.
