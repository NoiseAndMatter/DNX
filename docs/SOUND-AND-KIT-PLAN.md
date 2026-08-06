# Preset pool manager, and a kit manager for the Digitone II

Design, not implementation. Raised 2026-08-06.

Two tools were asked for:

- **A preset pool manager**, both devices — *audit and edit, including bringing in new presets.*
- **A kit manager**, Digitone II — *browse the available kits, build kits from presets on the device,
  replace the kit in a pattern.*

Everything below about the instrument comes from `00_References/Digitone-2-User-Manual_ENG_OS1.10D`,
§5 and §9, checked against what this codebase has decoded.

---

## Vocabulary, because ours has drifted from the device's

The Digitone II says **preset**. It has a **preset pool**, a **+Drive preset library**, a
**PRESET MANAGER**, and **preset locks**.

This codebase says *sound* throughout — `readSoundPool`, `SOUND_SIZE`, `soundLockCount`. That was a
reasonable guess before the manual was read, and it is now a second name for a thing the hardware
already named. **New surfaces should say preset**; renaming the existing ones is a separate job and
worth doing, but not as a side effect of this.

Where this document says *preset*, the code currently says *sound*.

---

## The three collections, from the manual

> **+DRIVE** → Projects, Kits, Presets
> **PROJECT** → 128 patterns · **POOL: 128 presets**
> **PATTERN** → **1 kit per pattern** · 16 audio/MIDI tracks

| | Where | How many | Points at it |
|---|---|---|---|
| **Preset pool** | inside one project | **128** | **preset locks** — a trig saying "play *this* here" |
| **+Drive preset library** | device-wide | **2,048** — 8 banks × 256 | nothing; it is a library |
| **A kit's presets** | inside a kit | **16**, one per track | the track itself |

**`/soundbanks` is the +Drive preset library.** Eight banks of 256 is 2,048, which is exactly the
number the manual gives. What we have been listing and reading all along *is* the preset library —
we simply had the device's name for it wrong.

### Two rules from the manual that constrain the design

**1. The pool exists so that presets can be locked.**

> "The primary benefit of presets loaded to the pool is the possibility for them to be preset
> locked. This feature is not available for the presets in the +Drive library."

That is the entire reason the pool is worth managing, and it is what the expander is already built
around. An audit that does not report lock usage is missing the point of the thing it is auditing.

**2. Importing copies; it never links.**

> "A preset or kit that has been imported from the +Drive to a pattern becomes part of the active
> pattern. Any changes made to a preset/kit will therefore not affect the stored preset/kit."

So every operation here is a **copy**, and "update the original" is not a thing the device does.
A tool that implied otherwise would be inventing a relationship the hardware does not have.

**3. MIDI presets cannot go in the pool.** The manual states it flatly. The pool manager must
refuse it rather than write something the device will not use.

---

## Kits — what the manual establishes

**Kits are stored on the +Drive**, in banks, saved to numbered slots with names — the KIT menu has a
bank selector, a slot chooser, a naming screen and an overwrite confirmation, exactly like presets.

A **kit** contains, per the manual:

- 16 audio or MIDI track presets
- LEVEL settings for the audio tracks and the pattern
- compressor and master distortion settings
- compressor routing and Control All settings
- send FX settings
- track layering settings
- pattern transpose settings

That matches `DN2_KIT` — 10,752 bytes, 16 presets at offset 60 — and the track level at `0x1c` that
was derived from the corpus. **The manual and the bytes agree**, which is the best position to start
from.

The device's own kit operations, which are the ones worth mirroring:

| Menu | What it does |
|---|---|
| **LOAD (KIT)** | load a stored kit into the active pattern |
| **SAVE (KIT)** | save the active pattern's kit to a slot, named |
| **MANAGE (KIT)** | the library |
| *sorting* | ADD TO PRESET POOL — adds the kit's 16 presets to the pool |

### The one thing still unknown

**The +Drive path.** Every listing this project has taken was from a Digitone 1, whose root has only
`projects` and `soundbanks` — and the DN1 has no kits, so that tells us nothing about the DN2.

The manual says the +Drive holds kits; it does not say what the storage API calls the directory.
**One `List` of `/` on the Digitone II gives it**, and it is the only fact missing before the kit
manager can be specified in detail. On the check sheet as **T27**.

---

## The other dependency: writing back

Both tools are editors, and an editor that cannot save is a viewer.

- **The dump protocol** writes into the project the instrument currently has **loaded**. Proven, in
  use today by *Write to device*.
- **The +Drive** writes any stored file. Proven for identical bytes (T15); arbitrary content depends
  on **T26** — the checksum is solved but the device has not yet accepted one we computed.

**T26 decides the shape of both tools.** If it passes they are read-edit-save; if it fails they are
read-edit-export, and this plan should be revisited rather than followed.

---

## Preset pool manager

### Audit — buildable now, no writes, no unknowns

- **Each of the 128 slots**: name, machine, empty or not.
- **What locks to it** — how many trigs, in which patterns. `collectSoundUsage` computes this today.
- **Unused slots**, per project *and* per selected patterns, because "unused" changes meaning with
  scope.
- **Dangling locks** — pointing at an empty slot, or past 127 entirely. **Ordinary in real
  projects**: `merge.ts` found slot 161 referenced in the wild. Reported, never silently repaired.
- **Duplicates** — by *bytes*, not by name. A name is a label somebody typed; the bytes are what
  plays.

### Edit, in the order worth building

1. **Delete a slot** — refused while any trig locks to it, naming them. Offered only at zero.
2. **Add a preset from the +Drive library** — browse `/soundbanks/A–H`, land it in the first free
   slot. This is the "adding new presets" request. **Refuse MIDI presets**, per the manual.
3. **Compact** — pack the used presets to the front and re-point every lock. **This is a shuffle**;
   `shuffle.ts` has said since it was written that *"the pool is the case where `rereference` stops
   being theoretical."*
4. **Export a slot to the library**, so a preset outlives its project.

### The unknown that blocks step 2

**A stored preset file and a pool slot are not the same bytes.** A DN1 preset on the +Drive read
**345** bytes; a DN1 pool entry is **302**. Presumably a wrapper — but *presumably* is not a format
claim, and writing 345 bytes into a 302-byte slot would corrupt the pool.

Cheap to settle, and **no hardware needed**: take the captured 345-byte preset and look for its 302
bytes verbatim inside a project's pool. If they are there, the wrapper is an offset and a length.

---

## Kit manager — Digitone II

Assuming T27 finds the path:

- **Browse the library** — name, the 16 tracks' machines, which presets. Reads like the pattern grid
  already does.
- **Build a kit from presets on the device** — choose 16 from the library, assemble, write. Same
  write path as everything else; needs T26.
- **Replace a pattern's kit.** The most useful operation and the most dangerous: trigs address
  *tracks*, and a kit defines what those tracks are. **Swapping the kit keeps the notes and changes
  every sound** — either exactly what you want or a catastrophe. It has to show before-and-after per
  track first, the same discipline as the expander's landing preview.
- **Add a kit's 16 presets to the pool** — the device offers this from its own kit sorting menu, and
  it is the natural bridge between the two tools.

---

## What both share, and should not each invent

`grid.ts` draws slots and handles selection and drag. `slotview.ts` maps an image to what a cell
says. `shuffle.ts` moves, copies, clears and re-points references — and the pool is indexed exactly
like a pattern bank. `drive.ts` lists and reads; `storagewrite.ts` writes.

**Neither tool needs new format knowledge except the two unknowns named above.** Everything else is
composition.

---

## Order

| | | why |
|---|---|---|
| 1 | **T26** — the device accepts a computed checksum | editors or viewers |
| 2 | **T27** — `List /` on the DN2 | where kits live |
| 3 | **Derive stored-preset ↔ pool-slot** | corpus only, unblocks "add a preset" |
| 4 | **Pool audit** | read-only, useful alone, needs none of the above |
| 5 | **Pool edit** | needs 1 and 3 |
| 6 | **Kit manager** | needs 1 and 2 |

**Step 4 is worth doing whatever 1 and 2 return.** It is useful on its own, it cannot damage
anything, and it exercises the pool decoding every later step depends on.
