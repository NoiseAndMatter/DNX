# Structure audit — 1 August 2026

A sweep of all 156 TypeScript files (39,298 lines: `src/` 108, `web/src/` 11, `test/` 55) against
`docs/PRINCIPLES.md`. **Findings and a plan only — nothing here has been acted on.** Each item is
sized as an independent PR so the plan can be taken in any order, or not at all.

Two findings were spot-checked by hand before being recorded; those are marked **verified**. The
rest are the sweep's reading and should be confirmed when the work is picked up.

---

## 1. `web/src/probe/main.ts` — 2,438 lines, the one real god file

2.4× the next-largest file, 6× the largest `src/` module, and eleven distinct jobs: port discovery,
card/table renderers, the probe run, capture listening, dump requesting, whole-project read, two
different write flows, link liveness, four +Drive transports, and a second `ApiTransport`.

Eight functions exceed 80 lines (`probe` 210, `writeToChosenSlot` 167, `writeBack` 164, `listPath`
129, `tryUnknownCode` 114, `readProject` 94, `readThenWrite` 92, `readFile` 83). Every one is the
same five steps — validate ports, correlate one reply, send, narrate, render a verdict — written out
eight times with no shared helper.

**Why it matters here.** This is the only instrument we have for asking hardware a question, and
every finding in `docs/device-storage.md` came out of it. It keeps **one** module-global
`awaitingReply` slot shared by seven independent request paths, and its own comments record that
costing a session twice — once to a concurrent read, once to a reply from Elektron Transfer. The fix
already exists in `web/src/devicesource.ts`, which attaches a fresh listener per request;
`devicesource.ts:216` says outright that the probe "keeps a single global slot and paid for it".

Dead: `awaitApi` (2188) is defined, takes an unused parameter, and is never called.

## 2. Byte-offset arithmetic has no single home — and two readers already disagree — **DONE**

**Verified.** `src/project/dn2image.ts` declares `DN2_KIT` as the canonical kit geometry, and five
other modules re-declare the same numbers locally: the sound offset `60`, sound size `359`, the MIDI
record `5964`/`268`, and the pool offset `10756` each have between two and five homes.

The track level is worse — it has **no** home. `DN2_KIT` has no `levelOffset`, so `0x1c` is written
as a bare literal in `src/librarian/tracksummary.ts:63` and `src/librarian/trackmove.ts:150`, and as
a local constant in `src/expand/convert.ts` and `src/sheet/collect.ts`.

They have already drifted:

```ts
src/sheet/collect.ts:70        kit[off + track * 2] | (kit[off + track * 2 + 1] << 8)   // u16le
src/librarian/tracksummary.ts:63   kit[0x1c + index * 2]                                // low byte only
```

Levels are 0–127, so the high byte is always zero and nothing is visibly broken today. It is a
divergence waiting for the first value above 255 — and it is exactly the class of defect the corpus
method exists to catch. The width itself needs settling against the corpus, not choosing.

## 3. `escapeHtml` exists seven times, in three behaviours

**Verified for the divergent one.** `web/src/grid.ts:277` does not escape `"`; `web/src/dom.ts`
does. `grid.ts` is the module *both* browser pages render every cell through, and it exports its
weaker copy, so a caller can pick it up by accident.

Seven copies in total: `dom.ts`, `grid.ts`, `web/src/render.ts`, `src/sheet/render.ts`,
`src/sheet/resultsform.ts` (as `esc`), `src/cli/hardwaretest.ts`, `src/cli/trackhwtest.ts`.

Today grid.ts only interpolates into element text, not attributes, so the missing quote escape is
latent rather than live. The `src/` copies cannot import `dom.ts` — that would invert the layering —
so the survivor has to be a platform-free `src/sheet/html.ts` that `dom.ts` re-exports.

Also duplicated: `ApiTransport` (probe vs `devicesource.ts` — the latter is the survivor),
`sharedPrefix`, `u32`, `readName` (four copies of "latin1, stop at NUL"), and five mutually
incompatible functions named `hex`, two of which `probe/main.ts` imports at once and has to alias.

## 4. The two hardware-test CLIs are a half-finished extraction

`src/cli/hardwaretest.ts` (476) and `src/cli/trackhwtest.ts` (766) share their design-token CSS,
`hhmm`, `escapeHtml`, `rowId`, `metaFields`, `exportSpec` and most of `renderSheet`'s prose.
`src/sheet/resultsform.ts` already owns the fillable-form half — the extraction was done once and
stopped, leaving the page around the form in both files. They have drifted: one writes `☐` as a
literal, the other as `\2610`, and only one has `td.num` rules.

`hhmm` alone has six copies (both hwtest CLIs, `cli/convert.ts`, `device/capture.ts`,
`web/src/app.ts`).

## 5. Layering: three Node-only modules sit in `src/`

`src/project/zip.ts` and `src/project/projectfile.ts` import `node:zlib`; `src/librarian/open.ts`
imports `node:fs`. All three are hand-listed as exclusions in `tsconfig.web.json`, and the browser
reimplements them — so there are two ZIP writers and two CRC-32s, with `test/web.test.ts` existing
to assert they agree.

`open.ts` documents its own violation and states the rule correctly. The other two carry no note. A
`src/node/` directory would turn a hand-maintained file list into a boundary that cannot go stale.

**Second violation:** `DropAction` lives in `web/src/manager/dragrules.ts`, but its strings become
CSS classes on the shared grid, are styled in the shared stylesheet, and are passed by the
*expander*. `grid.ts` types the action as bare `string` to avoid importing from a page folder —
the inversion is visible in the type system.

## 6. Cohesion and dead code

- `src/librarian/trackmove.ts` exports `trigCounts`, `lockCounts`, `trackMachines` — *readers* in a
  *mover*. So `tracksummary.ts` imports from the write module in order to summarise.
- `src/librarian/copy.ts` re-exports `SOUND_SIZE` as a pass-through, making it look like it owns
  geometry it does not.
- "Read a field out of a DN2 kit" is spread across five modules in four directories.
- Dead: `web/src/render.ts`'s `renderSummary` (never called), `trackhardwaretest.ts`'s
  `stepPatterns`, `web/src/app.ts`'s `live` set (assigned, never read), the probe's `awaitApi`.

## 7. Tests

**Seven silent skips break our own rule.** After the `{ skip: NO_CORPUS }` guard has already passed,
these do `if (!existsSync(...)) return;` — the corpus is present, the specific fixture is missing,
and the test reports green: `machine.test.ts` (×3), `web.test.ts` (×2), `plan.test.ts`,
`checksum.test.ts`, `container.test.ts`, `write.test.ts`, `soundmap.test.ts`. `capture.test.ts` and
`merge.test.ts` throw instead, which is the pattern the rest should follow.

**Untested subjects that matter:** `src/device/api.ts` (487 lines, eight response readers — the
existing `deviceapi.test.ts` tests the codec, not this); the whole `src/expand/` pipeline
(`route`, `allocate`, `ranking`, `rules`, `tracks`, `usage`) covered only indirectly;
`src/librarian/shuffle.ts`, where every operation's semantics originate; `web/src/grid.ts`, shared by
both pages, whose `nextSelection` is pure and trivially testable.

**Test names cannot identify their subject** while six names exist twice in `src/` (`plan`,
`convert`, `rearrange`, `rename`, `copy`, `hardwaretest` all appear in both `cli/` and a domain
folder).

**One test reaches past the public surface:** `trackmove.test.ts:448` reimplements the `0x1c` offset
rather than asserting through `summariseTracks` — a third copy of the constant from §2.

## 8. Naming

One real collision: **two different things are called "locks" on the same screen.**
`PatternSummary.soundLockCount` is trigs locking a *sound from the pool*;
`TrackSummary.lockCount` is *parameter* locks from the 80-record table. The manager prints
"· N locks" for a pattern at one line and "· N locks" for a track directly beneath it.
`trackhardwaretest.ts` carries a whole `QUIET_FAILURES` entry warning testers that "the count is
p-locks ONLY" — documentation patching a naming problem. Suggested: `TrackSummary.lockCount` →
`paramLockCount`, and label the cell to match.

Minor: `dom.ts` references `test/pages.test.ts`, which no longer exists — those checks moved into
`test/web.test.ts`.

---

## Proposed plan

Ranked by what the codebase most needs. Each is one PR.

| # | Change | Risk |
|---|---|---|
| 1 | ~~Give DN2 kit geometry one home~~ **DONE 2026-08-01.** `levelOffset/levelSize/levelCount` added, width settled as u16le against 49,152 corpus levels, `trackLevel`/`setTrackLevel` accessors added, six re-declarations and two bare literals removed, `test/dn2image.test.ts` added | shipped |
| 2a | Extract the reply-correlation transport into `web/src/devicelink.ts`, taken from `devicesource.ts`; both the probe and the expander use it | **high** — hardware path, almost no coverage. Fixes the known global-slot collision. Re-probe a real DN2 after |
| 2b | Split the rest of `probe/main.ts` into `ports`/`cards`/`capture`/`dumpio`/`storageio`, leaving `main.ts` as wiring | **high** — same; ship separately from 2a |
| 3 | Extract the hardware-sheet page scaffold into `src/sheet/page.ts` + `src/sheet/html.ts`; reconcile the drifted `☐` encoding | low |
| 4 | Collapse the seven `escapeHtml`s (fixing grid.ts's missing quote escape), export `u32` once, rename the colliding `hex`s, delete the four dead exports | low |
| 5 | Move `zip.ts`, `projectfile.ts`, `open.ts` to `src/node/`; `tsconfig.web.json` excludes a directory instead of a list | low-medium — import churn; `web.test.ts` catches mistakes immediately |
| 6 | Share the grid view-model: `slotViewFor` and `countOccupiedIn` in `grid.ts`, replacing three parallel copies across the two pages | low |
| 7 | Move `DropAction`/`actionFor`/`Modifiers` up into `grid.ts`; the manager keeps its own policy | low |
| 8 | Add `src/cli/args.ts` (`arg`, `flag`, `fail`, `readProjectImage`) and route the eleven CLIs through it | low, but eleven untested entry points — ship with a smoke script |
| 9 | Move the track counters out of the mover into `tracksummary.ts`; drop the `SOUND_SIZE` pass-through | low |
| 10 | Convert the seven silent skips to throws, add `api`/`route`/`shuffle`/`grid` tests, disambiguate the six colliding test names | low for the new tests; **medium** for the throws — it may turn a green run red, which is the point. Own PR so failures are attributable |

## Checked and found healthy

Recorded so this reads as an audit rather than a complaint list:

- **No import cycles** anywhere in `src/` or `web/src/` (full DFS over the relative-import graph).
- **No `src/` → `web/` import.** The one-way dependency holds absolutely.
- **No DOM, WebMIDI or `localStorage` consumed in `src/`.** The only hits are inside the browser JS
  that `src/sheet/resultsform.ts` *generates* as text — a code generator, and honest about it.
- **`src/expand/`'s deliberate split survives** — `usage` reads, `tracks` budgets, `rules`/`ranking`
  decide, `allocate` assigns, `route` maps, `convert` writes. None has grown a second job.
- **`src/sheet/`'s collect/render/naming split is clean.**
- **Position vocabulary is exemplary** — one home for `A1`…`H16`, one for `T1`…`T16`, an explicit
  `nameAt(level, index)` at the ambiguity, and `patternIndex` as a real inverse returning `undefined`
  rather than guessing.
- **"A track is sequence + preset" is carried consistently** through `TrackScope`, `TrackPart` and
  the manual citations.
- **The device modules are honestly layered** — `session` correlates, `api`/`storage` codec,
  `storagesession`/`storagewrite` sequence, `deviceproject` composes. Only the browser transport is
  duplicated, not the protocol knowledge.
- **Long files are mostly coherent, not god files.** `expand/convert.ts` (858) is one transplant in
  eight private writers; `device/storage.ts` (814) is one wire protocol of which roughly 60% is
  recorded evidence; `project/dn1.ts` and `expand/fieldmap.ts` are lookup tables. A big table is not
  a god file.

**Where a split is recommended above, the comments travel with the code they explain.** The recorded
evidence in `storage.ts`, `trackmove.ts` and `probe/main.ts` — wrong hypotheses alongside right ones,
with the bytes that settled them — is the most valuable thing in the repository. None of the size
findings is an argument for deleting any of it.
