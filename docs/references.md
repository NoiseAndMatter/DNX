# Reference material

Elektron publishes no format documentation for these devices, so everything in `docs/` was
derived from real files. The manuals are still the authority for the **user-facing** side —
parameter names, ranges, page layouts, what a control actually does — and are the thing to
check before assuming anything about a field's meaning.

## Elektron official manuals

| Device | OS | URL |
|---|---|---|
| Digitone (DN1) | 1.41 | <https://www.elektron.se/wp-content/uploads/2024/09/Digitone_User_Manual_ENG_OS1.41_231108.pdf> |
| Digitone II (DN2) | 1.00A | <https://elektron.se/wp-content/uploads/2024/10/Digitone-2-User-Manual_ENG_OS1.00A_241023.pdf> |

Local copies live in the private corpus at `00_References/`, beside `00_Examples/`. They are
not in this repository — it holds code and documentation only.

**Check the OS version before trusting a parameter list.** Working from 1.00A while the device
ran a later OS produced a whole sheet of wrong controls: WAVETONE's SYN page 2 lists `SYNC` in
1.00A and does not in 1.10D, which is what the device shows. Parameters move and disappear
between OS releases. Use the newest manual, and treat the device as final.

**The manual is not always right about ranges.** It gives `VFAD` as `-64–64`, which is 129
values and cannot fit a byte; the device offers `-64–63`, confirmed on hardware 2026-07-26.
Where the manual and the device disagree, the device wins and the disagreement gets recorded.

## Third-party guide

The Synthdawg Digitone II guidebook and cheat sheet are more exhaustive than Elektron's own
manual, and the better first stop for what a control does. They are **all rights reserved**:
consult them, never quote them, and keep their text out of this repository — cite Elektron's
manuals for anything that needs a source.

The author holds a copy; its location is recorded in the private corpus at
`00_References/README.md`, not here.

## Capture corpora

- **Matched pairs** — DN1 projects beside Elektron's own DN2 conversions of them. The backbone
  of every correspondence in `docs/`, because the DN1 side is fully decoded, so the right answer
  is known before looking at the DN2 bytes.
- **Single-variable SysEx captures** — `emnyeca/digitone-syx-toolkit`, 419 native DN2 pattern
  dumps, each isolating one user action.
- **Device-authored captures** — built to a plan in `docs/dn2-capture-plan.md` and saved from
  the hardware. These are what name fields the corpora can only locate.

## digi-roll — prior art for authoring, not for managing

<https://github.com/zooloo303/digi-roll>, by zooloo303. Creates trigs in a **Digitakt II** and a
**Digitone II** from a piano roll.

**It is the only other project we know of that writes sequencer content to a DN2**, which makes it
the closest thing available to a second opinion on the half of the format DNX cares most about.
Everything in `docs/dn2-format.md` about trigs, notes and locks was derived from a corpus of real
files and cross-checked against nothing but itself and Elektron's own conversions. A tool that puts
notes *in* and gets a working pattern *out* has independently found the same fields — and anywhere
it disagrees with us, one of the two is wrong and it is worth knowing which.

**A different problem, though.** It is an authoring front end: you draw a part and it becomes trigs.
DNX moves what already exists between instruments and slots, and editorial features stay behind the
manager. So this is worth reading for what it proves about the format, not as a feature to match.

**Read, and two of its ideas are now in DNX.** Its per-device spec module became `src/project/spec.ts`
(#206) — one file per machine rather than twenty numbers spread across modules named after formats.
Its `safe-write.js` became `src/device/safewrite.ts` (#207): backup, confirm, write, verify, in one
path a caller cannot go around.

The three questions this section used to hold are answered:

- **It writes over SysEx**, using the dump protocol rather than the +Drive file API.
- **It gates on OS build** — `WRITE_ALLOWED_BUILDS` per device, extended only after re-verifying on
  the new firmware. DNX's equivalent is stronger and different: it checks the storage version of the
  record being written against a record the device itself just produced, so the check is against the
  instrument rather than against our table. Worth noting their allowlist names `0049` for the DN2 and
  this author's instrument is on `0050`.
- **It handles the DT2 and the DN2 through one representation**, with a per-device `SPEC`. Direct
  evidence that the two share most of the pattern format — previously inferred only from elk-herd's
  Digitakt code.

What is still worth taking from it: its browser-side **backup stash**, so a restore does not depend
on a download the browser may have blocked. `safewriteui.ts` records why that was deliberately left
out of #207.

**Check the licence before copying any of it verbatim**, the way `elk-herd`'s BSD 2-Clause was
checked below. What has been adopted so far is shape and reasoning, attributed in the module headers.

## Digitone2Link — a third opinion on the +Drive API

<https://github.com/enshtein/Digitone2Link>, by enshtein. A Tauri desktop app — Rust backend,
TypeScript/React front end — that browses a Digitone II's preset library. **Read-only by design**:
it downloads sounds and states plainly that it never overwrites anything on the device.

**It independently implements the same +Drive file API**, which is the first outside confirmation
DNX has had that this protocol is real and read the right way:

| | Digitone2Link | DNX |
|---|---|---|
| header | `F0 00 20 3C 10 00` | the same |
| listing / open / read / close | `0x53` / `0x54` / `0x55` / `0x56` | the same |
| paths | `/soundbanks/{bank}/{slot}` | the same |
| banks | `A`–`H` | the same |
| framing | 7-bit packing, high bits gathered into a leading byte | `encode87` |

Everything DNX knows about this API was decoded from captures of Elektron Transfer plus our own
experiments. A second implementation arriving at the same codes and the same path grammar is a
cross-check we could not otherwise buy.

### Where it differs is the useful part — tags

DNX reads tags as a **`tagBits` u32be bitfield at object +8**, against a closed 32-name vocabulary in
`src/project/tags.ts`. **The table itself is not in doubt** — it is confirmed by photographs of the
device's TAGS screen and cross-checked against eight bit assignments derived independently from 664
named sounds in 53 projects.

What is fragile is **alignment**, not the table. A stored preset's body carries a 5-byte prefix
before the object, and `library.ts` finds the object by magic precisely because getting that wrong is
invisible: the vocabulary is closed, so a misaligned read still yields real tag names and looks
entirely plausible. That question was settled by checking the *name* decoded correctly, not the tags,
for exactly this reason.

Digitone2Link gets tags from somewhere else entirely — a ZIP manifest's JSON at `/MetaInfo/Tags`, and
a `sound_tags` array from the device's own `/.metadata`. **That is an independent route to the same
fact**, and a cheap standing check on alignment: run both over a bank, and agreement confirms the
object was found in the right place. It cannot be fooled the way a bitfield read at the wrong offset
can.

Two other things to take from it:

- **`/.metadata` is a path DNX does not use.** Worth listing, whatever it turns out to hold.
- **Its name parsing is cruder than ours** — it scans for printable runs (`0x20`–`0x7e`) rather than
  reading a known offset. Ours should win any disagreement, but a disagreement would still be worth
  understanding, because a printable-run scan finds names our offset would miss if the offset moved.

**No second opinion on writing.** It does not write, so it says nothing about `0x57`/`0x58`/`0x59`,
the chunk numbering, or the stored-versus-raw form question that `storagewrite.ts` settled.

**Licence unchecked.** Treat it as all-rights-reserved until confirmed and keep its text out of this
repository; the table above is protocol fact, which is not anyone's to license.

## Digitone 2 Pattern Manager — the same problem, over the wire

<https://www.elektronauts.com/t/digitone-2-pattern-manager/253425>, by moru. The app runs at
<https://digitone2.morukutsu.fr/>. Found 2026-09-06; everything below is from the announcement
thread, not from using it.

**The closest thing to DNX that exists.** A browser app over the Web MIDI API that moves patterns
between Digitone II projects, offline once loaded, Chrome and Edge only. Same instrument, same
operation, same delivery. It credits `emnyeca/digitone-syx-toolkit` and elk-herd, which are the two
corpora and the one prior art already in this file.

**It moves patterns as raw SysEx and reads only the name out of them.** That is the whole
difference. It transfers the bytes a device hands over and puts them back, so it needs none of
`docs/dn2-pattern-format.md` — and its author states the consequence: **sound locks are expected to
break across projects**, because a lock is an index into the destination's sound pool and nothing
remaps it.

`src/librarian/copy.ts` remaps those indices, which is only possible because the pool audit knows
what a lock points at. So the two projects have taken opposite routes at the same fork: transfer
the bytes and accept what breaks, or decode enough to carry the references. Worth watching for what
their route turns out to cost, and worth being honest that theirs ships against a device today.

**Alpha, no source yet.** The author says the source will follow once it is stable, so there is no
licence to check and nothing to read. Track the thread.

**Two things the announcement says that we have already paid for.** It asks the user to back up
before using it, and it warns against running another transfer app at the same time — the same
port-contention trap the notebook records under "Three traps worth carrying", which cost an
afternoon of wrong diagnoses here. Testing is stated as firmware 1.10 on Chrome under macOS only.

## elk-herd — the prior art for the architecture

<https://github.com/mzero/elk-herd>, by Mark Lentczner. A patch and pattern manager for Elektron
hardware, written in Elm. Cloned into the private corpus at `00_References/elk-herd/`.

**BSD 2-Clause.** Unlike the Synthdawg guide, this is permissive: its code can be used and
adapted with attribution. Worth knowing before reading it, because the reading changes when you
are allowed to borrow.

**It has no Digitone support.** `src/Elektron/` contains `Digitakt` and nothing else, so it
cannot cross-check any of our format work. What it offers is architecture and prior art for the
manager, which is what `ui-plan.md` describes wanting to build.

### What is worth reading

**`src/Bank/Shuffle.elm`** — a formal model of reordering items in a bank. A `Shuffle` is a pair
of dictionaries, `movesTo` and `cameFrom`, over `Trash | Dst Int` and `Empty | Src Int`, with
`mergeShuffles` for composition and **`rereference`** for fixing up references after a move.

That is the general form of a problem we currently solve narrowly: `src/librarian/copy.ts`
remaps sound-lock indices when a pattern is copied. A manager that moves patterns, sounds and
kits between arbitrary slots needs the general version, and this is a worked one under a licence
that permits borrowing.

**`src/SysEx/`** — Elektron's SysEx dump protocol, 1,546 lines, and the request/response
convention across a device family:

| Request | Response | Object |
|---|---|---|
| `0x60` | `0x50` | Pattern + Kit |
| `0x61` | `0x51` | Pattern |
| **`0x62`** | **`0x52`** | **Kit** |
| `0x63` | `0x53` | Sound |

**This corroborates something we had only inferred.** `src/sysex/devices.ts` lists `KIT: 0x52`
from the family convention, flagged as unconfirmed because no file we hold uses it. elk-herd
implements it as a working message type on the Digitakt, which is independent confirmation from
a sibling device.

### And it bears on what a kit is

`docs/ui-plan.md` records that the DN2's kits carry their own names and that a standalone kit
format has never been seen, so "save this as a named kit" is not currently possible.

**A dedicated Kit dump type existing family-wide is strong evidence that a kit is a first-class
transferable object**, not merely a region inside a pattern. If the DN2 answers a `0x62` Kit
Request, the response *is* the standalone kit format — the thing that has been missing.

That is a concrete experiment rather than more speculation, and it needs only SysEx I/O, which
`docs/ROADMAP.md` already has queued as WebMIDI transfer.
