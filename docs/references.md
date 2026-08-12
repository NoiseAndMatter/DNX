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

Not yet cloned or read. Three questions to take to it first:

- **Does it write over SysEx, or by building a project file?** That says which of the two protocols
  it trusts, and `docs/device-storage.md` records how differently those behave.
- **What does it do about the checksum?** T26 and T30 on the test sheet are still closing that from
  our side.
- **Does it handle the DT2 and the DN2 through one representation?** If so, that is direct evidence
  about how much of the pattern format the two devices share — something we have so far only
  inferred from elk-herd's Digitakt code.

**Check the licence before reading any of it closely**, the way `elk-herd`'s BSD 2-Clause was checked
below. Unknown until then, so treat it as all-rights-reserved and keep its text out of this
repository.

## elk-herd — the closest prior art

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
