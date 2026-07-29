# Milestones

**When things actually landed**, one line each, newest first. Written as they happen.

Git already records this precisely — `git log --date=iso` for authored and committed times, and
the GitHub API for merge times — so nothing here is the only copy of anything. What git cannot do
is say which of 58 merges *mattered*. That is the whole job of this file, so keep it short: a
milestone is something that changed what DNX can do, not every PR.

Times are local (Australia/Brisbane, UTC+10).

| When | What | PR |
|---|---|---|
| 2026-07-30 09:21 | **The manager reads and writes a live Digitone II.** Hardware-verified end to end: open a device, move patterns, write back, no file anywhere in the loop. Files remain a first-class source. | #58 |
| 2026-07-30 00:59 | **Writing to an occupied slot overwrites silently** — no prompt, no refusal, no acknowledgement. `A1` → `A14`, verified byte for byte. | #57 |
| 2026-07-30 00:14 | **A write lands in the active project, not the +Drive.** Survives a power cycle, lost on loading another project. SAVE PROJECT is the commit — and the undo. | #55 |
| 2026-07-29 23:42 | **Writing to a device works.** Null round trip read back byte-identical, then a pattern copied into an empty slot exactly. | #51, #53 |
| 2026-07-29 22:00 | **A whole project can be read by request** — 257/257 on a DN2, byte-identical to a front-panel dump. | #48, #49 |
| 2026-07-29 | **A capture rebuilds into a project file**, both families. The DN1 needs two captures; its sound locks resolve afterwards. | #50 |
| 2026-07-28 | **A device answers requests** — `0x6n` asks, `0x5n` answers, verified on both machines. | #47 |
| 2026-07-28 | **Track operations pass on hardware** — Digitone II 1.10E, 24/25 rows, 0 failing. | #41 |
| 2026-07-28 | **The +Drive file API does not exist on either Digitone.** An assumption caught by asking the device before building on it. | #40 |
| 2026-07-25/26 | **A generated project loads and plays on a real Digitone II** — expansion validated end to end. | — |
