# Structure audit — 1 August 2026

A sweep of all 156 TypeScript files (39,298 lines: `src/` 108, `web/src/` 11, `test/` 55) against
`docs/PRINCIPLES.md`. **Findings and a plan only — nothing here has been acted on.** Each item is
sized as an independent PR so the plan can be taken in any order, or not at all.

Two findings were spot-checked by hand before being recorded; those are marked **verified**. The
rest are the sweep's reading and should be confirmed when the work is picked up.

---

## 1. `web/src/probe/main.ts` — 2,438 lines, the one real god file — **DONE**

2.4× the next-largest file, 6× the largest `src/` module, and eleven distinct jobs: port discovery,
card/table renderers, the probe run, capture listening, dump requesting, whole-project read, two
different write flows, link liveness, four +Drive transports, and a second `ApiTransport`.

Eight functions exceed 80 lines (`probe` 210, `writeToChosenSlot` 195, `writeBack` 208, `listPath`
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

## 3. `escapeHtml` exists seven times, in three behaviours — **DONE**

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

## 4. The two hardware-test CLIs are a half-finished extraction — **DONE 2026-08-04**

`src/cli/hardwaretest.ts` (476) and `src/cli/trackhwtest.ts` (766) share their design-token CSS,
`hhmm`, `escapeHtml`, `rowId`, `metaFields`, `exportSpec` and most of `renderSheet`'s prose.
`src/sheet/resultsform.ts` already owns the fillable-form half — the extraction was done once and
stopped, leaving the page around the form in both files. They have drifted: one writes `☐` as a
literal, the other as `\2610`, and only one has `td.num` rules.

`hhmm` alone has six copies (both hwtest CLIs, `cli/convert.ts`, `device/capture.ts`,
`web/src/app.ts`).

`src/sheet/page.ts` owns the page: doctype, design tokens, the forty lines of CSS, and the export
bar and script in the order the form needs them. Two lengths stay parameters — the track sheet has
more columns — and everything else is the same sheet. **469 → 414** and **759 → 703** lines.

The drift was resolved rather than merged: the CSS escape `±0` over the literal `☐`, because it
survives a file opened without a charset; `td.num`, `.scope` and the rule under `td.note` present
for both, since a rule a sheet does not use costs nothing and a class with no rule is the `.sw` bug.

`hhmm` and the project-name stamping moved to `src/sheet/naming.ts`, removing five and two copies.
Extracting the stamper surfaced a discrepancy neither copy explained: both cap at **15** while
`NAME_SIZE` is **16**. Preserved and documented rather than corrected — a name that overruns on
hardware is worse than one character wasted, and nothing here establishes which is right.

**Verified by generating both sheets before and after and diffing them**, which is the only check
that means anything for a code path whose entire output is a string. The only differences are the
three intended ones.

## 5. Layering: three Node-only modules sit in `src/`

`src/project/zip.ts` and `src/project/projectfile.ts` import `node:zlib`; `src/librarian/open.ts`
imports `node:fs`. All three are hand-listed as exclusions in `tsconfig.web.json`, and the browser
reimplements them — so there are two ZIP writers and two CRC-32s, with `test/web.test.ts` existing
to assert they agree.

`open.ts` documents its own violation and states the rule correctly. The other two carry no note. A
`src/node/` directory would turn a hand-maintained file list into a boundary that cannot go stale.

**Second violation — FIXED 2026-08-01, see item 7:** `DropAction` lives in `web/src/manager/dragrules.ts`, but its strings become
CSS classes on the shared grid, are styled in the shared stylesheet, and are passed by the
*expander*. `grid.ts` types the action as bare `string` to avoid importing from a page folder —
the inversion is visible in the type system.

## 6. Cohesion and dead code — **readers/pass-through DONE 2026-08-04**

- `src/librarian/trackmove.ts` exports `trigCounts`, `lockCounts`, `trackMachines` — *readers* in a
  *mover*. So `tracksummary.ts` imports from the write module in order to summarise.
- `src/librarian/copy.ts` re-exports `SOUND_SIZE` as a pass-through, making it look like it owns
  geometry it does not.
- "Read a field out of a DN2 kit" is spread across five modules in four directories.
- Dead: `web/src/render.ts`'s `renderSummary` (never called), `trackhardwaretest.ts`'s
  `stepPatterns`, `web/src/app.ts`'s `live` set (assigned, never read), the probe's `awaitApi`.

### What the move actually needed — 2026-08-04

**The prescription was wrong, and the diagnosis was right.** "Move the counters into
`tracksummary.ts`" assumed they were readers the mover merely re-exported. They are not: the mover
*uses* all three, in `planTrackMove` and `verifyTrackMove`, and they are built on `liveRecords` and
the two record tables, which were the mover's own private machinery. Moving only the counters would
have forced the tables to be exported from the mover — leaking more, not less.

So it split in two:

- **`TrackTable`, `TRIG_TABLE`, `LOCK_TABLE`, `liveRecords` → `project/dn2pattern.ts`.** They are
  record geometry, built from `PATTERN`, which already lives there.
- **`trigCounts`, `lockCounts`, `trackMachines` → `librarian/tracksummary.ts`**, whose stated job is
  exactly "what one pattern's 16 tracks hold".

`trackmove.ts` imports both, and its export surface is now plan / apply / verify and their types —
nothing a reader would want. **`dn2pattern` ← `tracksummary` ← `trackmove`**, with no cycle and no
summariser reaching into a write path.

Two more found on the way:

- **`DN2_TRACK_COUNT` and `TRACK_COUNT` were both 16**, and `expand/convert.ts` already aliased one
  to the other's name. Collapsed onto `dn2pattern`'s, aliased at the import where the longer name
  reads better — the precedent `convert.ts` had already set.
- **The `SOUND_SIZE` re-export had no importers at all.** Deleted rather than relocated.

`test/trackmove.test.ts` no longer reimplements `0x1c`; it reads levels through `summariseTracks`.
The hand-rolled version also took only the low byte of a u16le, so a level above 255 would have
compared equal while being wrong.
## 7. Tests

**Seven silent skips break our own rule — FIXED 2026-08-04.** After the `{ skip: NO_CORPUS }` guard has already passed,
these do `if (!existsSync(...)) return;` — the corpus is present, the specific fixture is missing,
and the test reports green: `machine.test.ts` (×3), `web.test.ts` (×2), `plan.test.ts`,
`checksum.test.ts`, `container.test.ts`, `write.test.ts`, `soundmap.test.ts`. `capture.test.ts` and
`merge.test.ts` throw instead, which is the pattern the rest should follow.

`test/corpus.ts` now has `requireCorpusFile` and `requireCorpusFiles`, which throw naming the
missing fixture, and all seven sites use them. The four list builders throw when the corpus exists
but the directory does not, and return `[]` only when there is no corpus at all — the one case that
is genuinely a skip.

**All seven fixtures turned out to be present**, so nothing was passing on nothing here. That is
the good outcome and not the point: the guard was unenforceable, and on any other machine the same
suite would have gone green while checking less. `test/corpus.test.ts` proves the new guard fires,
because a guard that never fires is the same bug one level up and this is the last place anyone
would look for it.

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
| 2a | ~~Extract the reply-correlation transport~~ **DONE 2026-08-01.** `web/src/devicelink.ts`, used by both the probe and `devicesource.ts`. Found on the hardware pass: the fix's own `input.open()` call stalled on an already-open port — both writes hung past their timeout. Fixed by skipping `.open()` when already open and capping the genuinely-closed case at 2s. See `docs/device-probing.md`. | shipped, re-verifying on device |
| 2b | ~~Split the rest of `probe/main.ts`~~ **DONE 2026-08-01.** `cards.ts` (rendering), `ports.ts` (selection), `storageio.ts` (+Drive conversations), `dumpio.ts` (dump conversations). **2,625 → 2,353 lines**, and what is left is genuinely this page's own work: the flows, the safety confirmations and the narration. **Wants a hardware pass** — every conversation with an instrument moved | shipped, unverified on device |
| 3 | ~~Extract the hardware-sheet page scaffold~~ **DONE 2026-08-04.** `src/sheet/page.ts`; drift resolved on the CSS escape; `hhmm` (×5) and the name stamper (×2) moved to `sheet/naming.ts`; both sheets diffed before and after; `test/sheetpage.test.ts` added, 7 tests | shipped |
| 4 | ~~Collapse the seven `escapeHtml`s~~ **DONE 2026-08-01.** One home in `src/sheet/html.ts`, re-exported by `dom.ts`; `grid.ts`'s quote-dropping copy gone; `u32` exported once; `apiprobe`'s `hex` renamed `hexBody` so the probe no longer aliases at the import; `renderSummary`, `stepPatterns`, `soundLockPoolOffset` and `app.ts`'s unused `live` deleted; `test/html.test.ts` added | shipped |
| 5 | ~~Move the three Node-only modules to `src/node/`~~ **DONE 2026-08-04.** Config excludes a directory; 40 files' imports rewritten; `test/web.test.ts` now *enforces* the boundary across all of `src/`, verified by planting a violation; 757 pass | shipped |
| 6 | ~~Share the grid view-model between the two pages~~ **DONE 2026-08-01.** `web/src/slotview.ts` — DOM-free, so it is testable — owns `SlotView`, `BANK_SIZE`, `patternSlotView` and `countOccupiedIn`. Three copies of the mapping gone; the expander's source grid keeps its one real difference as a `live` argument. `test/slotview.test.ts` added, 9 tests | shipped |
| 7 | ~~Move `DropAction`/`actionFor`/`Modifiers` up into `grid.ts`~~ **DONE 2026-08-01, and the proposed destination was wrong.** They went to a new DOM-free `web/src/dropaction.ts`: `dragrules.ts` is type-checked by the root config, which has no DOM library, so pointing it at `grid.ts` failed immediately on `NodeListOf` having no iterator. `grid.ts` now types its `action` as `DropAction` rather than `string`, and the stylesheet guard reads the union from its real home | shipped |
| 8 | ~~Add `src/cli/args.ts`~~ **DONE 2026-08-04.** `cliArgs`, `fail`, `readProjectFile`, `readProjectImage`; ten commands rewired, nine `arg` closures and four `fail`s gone; **the shared `arg` fixes a bug all nine copies had**; `test/clismoke.test.ts` runs all seventeen commands as subprocesses and `test/cliargs.test.ts` covers the parser; 785 pass | shipped |
| 9 | ~~Move the track counters out of the mover~~ **DONE 2026-08-04.** Geometry to `dn2pattern.ts`, counters to `tracksummary.ts`, so the mover exports only plan/apply/verify; duplicate track-count constant collapsed; dead `SOUND_SIZE` re-export deleted; the `0x1c` reimplementation in the tests replaced by `summariseTracks` | shipped |
| 10 | ~~Silent skips, missing tests, colliding names~~ **DONE 2026-08-04.** Throws in #136; `shuffle` (17), `nextSelection` (9) and the four uncovered `api.ts` readers (12) added; `nextSelection` moved to a DOM-free `selection.ts` to be testable; names resolved by a documented convention rather than a rename. 823 pass | shipped |

## Item 10 finished — 2026-08-04

**New tests for the untested subjects the audit named:**

- **`shuffle.ts`** (17) — where every slot operation's meaning originates, and covered only
  *indirectly* before, through tests that apply a shuffle to a real project and check bytes. A wrong
  semantic and a wrong writer were indistinguishable, and both needed the corpus to notice.
- **`nextSelection`** (9) — pure, shared by both pages, and the only thing making the two tools
  behave alike was that they call the same function.
- **`api.ts` response readers** (12) — the four `deviceapi.test.ts` does not reach. Fixtures are
  built rather than captured, which is what allows the cases no working device would ever send: an
  empty listing, a value above 2^53, a chunk whose declared length disagrees with its payload.

**`nextSelection` had to move to be testable at all.** It lived in `grid.ts`, which draws cells, so
importing it needs `DOM.Iterable` — which the root config does not have. That is the same wall
item 7 hit, and the same answer: `web/src/selection.ts`, DOM-free, imported directly rather than
re-exported through `grid.ts`. **A pure thing inside a DOM module is a pure thing nobody can test.**

**The six colliding names were resolved by convention rather than by renaming.** Every one of those
tests covers the *domain* module, and the alternative — `librarianhardwaretest.test.ts` — is worse
to read than what it replaces. `CLAUDE.md` now states the rule: the unprefixed name means the domain
module, a `cli` prefix would mean the command, and the commands are covered collectively by
`clismoke.test.ts` so no per-command file is expected.

**Observed and left alone:** `test/rename.test.ts` carries literal `NUL` and `BEL` bytes as test
data, so tools report it as binary. The data is deliberate and the tests pass; escaping it is
cosmetic and something in the toolchain reverts the edit, so it is recorded here rather than
half-done.

## The bug nine copies shared — found 2026-08-04

Every command built its own `arg`:

```ts
const i = argv.indexOf(`--${name}`);
return i === -1 ? undefined : argv[i + 1];
```

So `npm run convert -- --from --expand` read `"--expand"` as the filename and died with a raw
`node:fs` stack trace — no usage text, nothing naming the argument actually left out. **A missing
value is the one case where the usage message is the entire answer.**

The shared version refuses a `--`-prefixed token as a value. That is safe here because nothing this
tool takes as a value begins with `--`: they are paths, slot names like `A1`, track numbers and
project names.

The smoke test was written **before** the refactor, so there was a baseline to change against — and
its first version proved nothing, because it aimed at `project`, which parses positionally and never
had the bug. Pointed at `convert` it failed, which is what made it worth having.

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
