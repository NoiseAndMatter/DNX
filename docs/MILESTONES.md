# Milestones

**When things actually landed**, one line each, newest first. Written as they happen.

Git already records this precisely — `git log --date=iso` for authored and committed times, and
the GitHub API for merge times — so nothing here is the only copy of anything. What git cannot do
is say which of 58 merges *mattered*. That is the whole job of this file, so keep it short: a
milestone is something that changed what DNX can do, not every PR.

Times are local (Australia/Brisbane, UTC+10).

| When | What | PR |
|---|---|---|
| 2026-07-30 19:10 | **Any stored project reads off the +Drive, byte-for-byte.** `/projects/<index>` opened, read and closed; the image is **identical to Elektron's own export of the same project** — 2,781,700 bytes, zero differences. No donor, no 257 requests, and the open project untouched. The manager can browse the device's project list. | #76 |
| 2026-07-30 16:07 | **`0x6f` reads a whole project off a Digitone II too** — 248 messages, 14,658,351 bytes, one request in place of 257. Both families now. | #70 |
| 2026-07-30 15:12 | **We talked to the +Drive.** A request reconstructed from captured *responses alone* worked first try — `/` returned `projects` and `soundbanks`, then `/projects` listed all 128 by name and slot, and `/soundbanks/A` all 256 sounds. | #66 |
| 2026-07-30 14:40 | **The Digitone 1's request band mapped**, every entry link-checked: ten codes answer, three provably do not. And `supportedMessages` proved worthless in *both* directions. | #64 |
| 2026-07-30 13:53 | **The Digitone's storage API found**, captured from Elektron Transfer itself: directory listings carrying names, **positions** and sizes, and whole files read by path. Overturns "no file API on a Digitone". See `device-storage.md` | #62 |
| 2026-07-30 12:50 | **The active-object band identified** — `0x58`–`0x5b` are the `+8` twins of the indexed dumps, and `0x6a` answers "what pattern is selected?" live. | #62 |
| 2026-07-30 12:41 | **`0x6f` returns a whole DN1 project including its sound pool** — 220 messages, removing the manual front-panel pool step. | #62 |
| 2026-07-30 11:40 | **A pool dump's object number is the slot, not a send counter** — proved by deleting two sounds and finding exactly those two numbers missing. | #62 |
| 2026-07-30 09:38 | Tracks laid out like patterns, two rows of eight; this log started. | #59 |
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
