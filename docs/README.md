# What is in `docs/`

Twenty-five files, and they are not the same kind of thing. This says which, and which three to
read first.

Elektron publishes no format documentation for the Digitone family. Everything here was derived
from real files and from captures taken off the instrument, and **every claim carries a status**:
VERIFIED, SOLVED, DECODED, INFERRED, SPECULATIVE or UNKNOWN. Those words are load-bearing. A field
marked INFERRED has a name taken from its position in a related structure, not from anything
anybody measured.

## Start here

| | |
|---|---|
| [`dn2-pattern-format.md`](dn2-pattern-format.md) | The Digitone II pattern record, byte by byte. The largest and most active document here, and the one most of the hardware work went into. |
| [`PRINCIPLES.md`](PRINCIPLES.md) | How this code is meant to be written. Short. |
| [`capture-protocol.md`](capture-protocol.md) | How a byte gets from an instrument's screen into a document above. Read it before adding a claim to any format reference. |

## Format references

The reason anybody else would want this repository. All current.

| | |
|---|---|
| [`dn2-format.md`](dn2-format.md) | The DN2 project container: image layout, LZ4 codec, CRC, where each object lives |
| [`dn2-pattern-format.md`](dn2-pattern-format.md) | The pattern record: trigs, locks, track settings, chord memory, both storage versions |
| [`dn2-song-format.md`](dn2-song-format.md) | The 16 song arrangements in the image tail |
| [`dn1-project-format.md`](dn1-project-format.md) | The Digitone 1 project |
| [`dn1-tail-format.md`](dn1-tail-format.md) | The DN1 tail, and the per-track references in it |
| [`sysex-format.md`](sysex-format.md) | The SysEx container and the 8-in-7 encoding |
| [`sound-mapping.md`](sound-mapping.md) | How a 302-byte DN1 sound becomes a 359-byte DN2 sound. Derived from nine pairs Elektron converted themselves, validated on three withheld from the derivation |
| [`device-storage.md`](device-storage.md) | The +Drive file API, decoded from Elektron Transfer's own traffic |
| [`dnx-backup-format.md`](dnx-backup-format.md) | `.dnx`, the whole-instrument backup. A zip with a manifest, so it opens without DNX |

## Method

| | |
|---|---|
| [`PRINCIPLES.md`](PRINCIPLES.md) | The rules the code follows |
| [`capture-protocol.md`](capture-protocol.md) | How to design a capture that cannot lie to you |
| [`help-captures.md`](help-captures.md) | The in-app help's screenshot slots, which exist and which are outstanding |
| [`device-probing.md`](device-probing.md) | Talking to an instrument over SysEx, and what it does when you get it wrong |
| [`analysis.md`](analysis.md) | The musical analysis subsystem, and the boundary that keeps it testable |

## Live tracking

These change. Everything else here is a record.

| | |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | What is next, and what was deliberately not done. 2,291 lines, and part diary |
| [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) | Defects, gaps, and the traps that have already cost time |
| [`dn2-capture-plan.md`](dn2-capture-plan.md) | The questions a matched pair can never answer, waiting for an instrument |
| [`references.md`](references.md) | Manuals, corpora and prior art, with what each is good for and what it costs |
| [`MILESTONES.md`](MILESTONES.md) | When things landed |

## Plans, and what became of them

**A plan that has been executed is history, not documentation.** These are kept because the
reasoning in them is not written down anywhere else, and a decision without its reasons is a
decision nobody can revisit. Each says at the top when it was written.

| | state |
|---|---|
| [`ui-plan.md`](ui-plan.md) | **built.** The manager is what this describes |
| [`expansion-design.md`](expansion-design.md) | **built.** How sound-locked DN1 trigs become 16 DN2 tracks |
| [`song-mode-plan.md`](song-mode-plan.md) | **partly built.** Songs are read and shown; editing is not |
| [`SOUND-AND-KIT-PLAN.md`](SOUND-AND-KIT-PLAN.md) | **design only.** Nothing here is implemented |
| [`STRUCTURE-AUDIT.md`](STRUCTURE-AUDIT.md) | **partly acted on.** A sweep of every file against `PRINCIPLES.md`, sized as independent PRs |
| [`UI-CONSISTENCY.md`](UI-CONSISTENCY.md) | **open.** Why the four tools look like four utilities |
| [`hardware-test-rearrange.md`](hardware-test-rearrange.md) | **done, and it is now a result.** Nine operations on a Digitone II, all passed |

## Two rules that keep these honest

**Search before deriving.** If a fact feels like it ought to be recorded somewhere, it is. This
project has three times written a hardware test for a question these files had already answered,
and once shipped a caveat to users about a table that had been solved on hardware two months
earlier. `grep -rn -i "<term>" docs/` first, using the words for the *symptom* as well as the
mechanism.

**A status is a claim about evidence, and a summary table is where they rot.** Each format
reference opens with a table of offsets and their status, then decodes fields in prose below. The
tables have twice fallen behind the prose, saying UNKNOWN about bytes solved a hundred lines
lower. `test/docstatus.test.ts` now fails when that happens, because the two statements are never
on the same screen and no reviewer will catch it.
