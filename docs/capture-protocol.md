# Capture protocol

The DN1 pattern format is undocumented and no public samples exist. The only way to map it
is a **differential corpus**: a series of dumps where each file differs from the previous one
by exactly one deliberate action. Diffing consecutive files then localises the bytes that
encode that action.

This is the same method that produced the DN2 corpus we are using as reference, and it is the
long pole of the project. The tooling exists to make each capture cheap; the discipline of
changing one thing at a time is what makes the results usable.

## Setup

1. On the device: `SETTINGS` → `SYSEX DUMP` → `SEND` → choose `PATTERN` (or `PROJECT`).
2. Record the SysEx to a file — Elektron C6, `amidi -d`, or any SysEx librarian.
3. **Note the OS version once per session** and put it in the folder's `NOTES.md`.
   Sound dump sizes already differ across DN1 OS versions, so patterns likely do too.

Save as `00_Examples/01_DN1/patterns/<Experiment>/NN_description.syx`, numbered so they sort
in capture order. `diff --chain` sorts numerically, so `2_x.syx` correctly precedes `10_x.syx`.

## The rules that make this work

- **One variable per file.** If you change two things, the diff cannot tell you which bytes
  belong to which.
- **Always start from the same base pattern.** Capture that base first as `0_base.syx`.
- **Never save the project between captures** unless the experiment is about saving —
  the device may rewrite unrelated fields.
- **Capture the reverse too** where it is cheap. Add a trig, capture, remove it, capture.
  If the bytes do not return to their original values, something else is also moving.

## Experiments, in priority order

The first three are what the expander actually needs. The rest fill in the format.

### 1. Sound locks — the critical one

This is the mechanism the whole project depends on: it is how a DN1 sketch fits extra sounds
onto four tracks, and finding it is what lets us pull them apart.

| File | Action from base |
|---|---|
| `0_base.syx` | Base pattern, one trig on track 1 step 1, no locks |
| `1_soundlock_step1.syx` | Sound-lock step 1 to a different sound |
| `2_soundlock_step1_other.syx` | Change that lock to a third sound |
| `3_soundlock_step5.syx` | Also sound-lock step 5 |
| `4_soundlock_cleared.syx` | Clear the lock on step 1 |
| `5_soundlock_track2.syx` | Sound-lock a trig on track 2 instead |

Goal: locate the sound-lock array, its per-track stride, and how a sound is referenced
(slot index into the +Drive pool, or an inline sound?).

### 2. Trigs

Add a trig at each step 1..16 in turn, one file per step. Then the same on track 2 to
establish the per-track stride. Then remove trigs in a different order than they were added,
which reveals whether records are slot-allocated or kept compact.

### 3. Parameter locks

| File | Action |
|---|---|
| `1_plock_one.syx` | P-lock one parameter (e.g. filter cutoff) on step 1 |
| `2_plock_same_step2.syx` | Same parameter, also on step 2 |
| `3_plock_second_param.syx` | A second parameter on step 1 |
| `4_plock_track2.syx` | The first parameter on track 2 |
| `5_plock_cleared.syx` | Clear the step 1 lock |

Goal: confirm whether DN1 uses the Rytm/Digitakt `{paramId, track, steps[64]}` slot shape,
and how many slots exist. Push until the device refuses another lock — that gives the cap.

### 4. Per-trig values

Note, velocity, length, micro-timing, retrig, trig probability and conditions. One file per
value change on a single known trig. Include the `inherit` → `explicit` transition, since the
DN2 encodes that as `0xFF`.

### 5. Per-track and per-pattern settings

Track length, track speed, scale mode, pattern tempo, pattern name. For the name, capture a
few lengths and a few unusual characters — the DN1 charset includes `Å`, and the DN2
reportedly stores the name twice.

### 6. Machine and sound assignment

Change a track's machine type, then its assigned sound. This is what maps onto DN2 machines
during conversion, and it is where the two devices are least likely to line up.

## Working the diffs

```bash
# Each file against the previous, with record-stride detection
npm run diff -- --chain --stride 00_Examples/01_DN1/patterns/SoundLocks/

# Merge runs separated by a few unchanged bytes, so a 6-byte record reads as one entry
npm run diff -- --gap 3 --chain 00_Examples/01_DN1/patterns/SoundLocks/

# Everything against the base, to see cumulative structure
npm run diff -- --base .../0_base.syx 00_Examples/01_DN1/patterns/SoundLocks/
```

A clean result looks like the DN2 trig array: a handful of changed bytes, at a constant
stride, with values that obviously correspond to what you changed. A messy result — hundreds
of scattered changes — usually means two variables moved, or the project got saved in between.

Record findings in `docs/sysex-format.md` as they firm up, and mark anything not directly
observed as unconfirmed.
