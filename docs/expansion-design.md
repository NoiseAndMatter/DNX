# Expansion design

How a DN1 project's sound-locked trigs get spread across the DN2's 16 tracks.
Decisions here were taken 2026-07-25; open questions are marked as such.

## The problem

On the DN1, four tracks each carry one "home" sound. Extra sounds are squeezed in by
sound-locking individual trigs, so a single track interleaves several instruments that
must share one voice and one set of track parameters.

On the DN2 there are 16 tracks and 16 voices. The conversion should give each distinct
sound its own track with its matching trigs, so it can be muted, mixed and tweaked
independently.

## Scope: one global map per project

A conversion covers a **whole project with a single sound-to-track map shared by every
pattern**. Sound X lands on the same DN2 track in every pattern it appears in.

The alternative — expanding each pattern independently — produces a locally better fit
but destroys cross-pattern consistency: mutes stop meaning anything when you switch
pattern, track-level tweaks do not carry, and live performance becomes unpredictable.
Consistency was judged worth more than per-pattern optimality.

**The cost, accepted deliberately:** the union of distinct sounds across a whole project
will usually exceed 16, so **overflow is the normal case, not an edge case**. Overflow
handling is a core feature, not a fallback. Task #6 measures how bad this actually is.

## Track budget

The DN1 has **8 sequencer tracks: 4 synth + 4 MIDI**. The MIDI tracks carry real data
(notes, CC locks, channel assignment) that must survive the conversion.

The DN2 has **16 tracks that are each either synth or MIDI** — one shared pool, not two.
Elektron's specification is literally "16 x synth or MIDI tracks". A MIDI track therefore
consumes a slot that a promoted sound could otherwise have used.

### How Elektron's own import lays them out — VERIFIED

Measured across all 9 matched pairs, every one of their 128 pattern slots, by counting
trigger records (each record's first byte is the track index):

```
  DN1 synth track N  ->  DN2 track N        (1-4)
  DN1 MIDI  track N  ->  DN2 track 4+N      (5-8)
  DN2 tracks 9-16    ->  ZERO trigs, in every project, always
```

Total trigs per DN2 track across all nine converted projects:

```
  T1 2521   T2 2167   T3 1912   T4 1138
  T5  302   T6  129   T7   51   T8   37
  T9    0   T10   0   T11   0   T12   0   T13 0   T14 0   T15 0   T16 0
```

The mapping is confirmed by two independent cases: `ORION_MIDI_TEST` uses only DN1 MIDI
track 2 and lands on DN2 track 6 with track 5 empty; `JAM` uses MIDI track 1 and lands on
track 5. Nothing ever reaches tracks 9-16.

### Budget

**Tracks 9-16 are guaranteed free — exactly 8 slots, always**, regardless of MIDI usage,
because the import reserves 5-8 for MIDI whether or not they are used.

Tracks 5-8 are additionally available when the source project uses fewer than four MIDI
tracks, which is the common case: only 3 of 9 projects use MIDI at all, and only one uses
more than a single MIDI track. So in practice the pool is usually **12 slots**, not 8.

**The synth/MIDI discriminator has been found**, which resolves the question that was
blocking those extra four. It is not in the pattern record at all: it is a `u16be` bitmask
at **kit+10260**, where bit *t* means track *t* is a MIDI track. Every one of the 1,152
converted kits reads `0x00F0` — bits 4..7, i.e. DN2 tracks 5-8 — and every one of the 419
native SysEx captures reads `0x0000`.

So an unused track 5-8 **is** configured as MIDI and does need its type switched, but doing
so is a single bit. `useFreedMidiTracks` can default on once the expander clears the
corresponding bit when it claims one of those tracks.

Worth remembering the measured value of this: enabling freed MIDI tracks raises promotions
on already-overflowing projects but flips **none** from overflowing to clean. The headline
stays 44/53 either way.

Destinations available to promoted sounds:

- Whatever remains after home sounds and used MIDI tracks are placed.
- DN2 tracks 1-4 are normally reserved for the four DN1 home sounds — **except** where a
  DN1 synth track has no trigs at all, in which case its counterpart is free to use.
- Because DN2 tracks are switchable rather than drawn from a fixed MIDI pool, an unused
  DN1 MIDI track frees a slot for synth use with no special handling.

MIDI tracks are **transferred, not expanded**: they have no sounds and therefore no
sound-locks, so there is nothing to promote. They just need to land intact.

Two independent user-facing controls:

- **Source-track order** — which of the four DN1 tracks gets its locked sounds promoted
  first. When slots run out, later source tracks keep their locked sounds in place.
- **Destination-track order** — which DN2 tracks get filled first, so tracks can be kept
  free or grouped by type.

### Hybrid core/flex allocation (to evaluate)

Worth testing once the reuse distribution from task #6 lands. Split the destination pool:

- **Core tracks** — sounds appearing across many patterns get a globally stable track.
  These are the sounds you actually mute and mix live, so consistency matters most here.
- **Flex tracks** — a small pool reassigned per pattern, absorbing the long tail of sounds
  used in only one or two patterns.

This keeps consistency where it counts without spending all 16 slots on rarities. Whether
it is worth the complexity depends entirely on the reuse distribution: a long tail makes it
valuable, a flat distribution makes it pointless.

## Terminology (exact, because the two are different mechanisms)

- **Sound lock** — a trig plays a different *sound* from the track's home sound. This is
  what crowds a DN1 track, and unfolding these is the entire point of the tool.
- **Parameter lock** — a trig overrides *parameter values*. These are never promotion
  candidates; they are per-trig automation that must travel with their trigs to whatever
  track those trigs end up on.

A busy pattern may hold hundreds of parameter locks but only a handful of sound locks.
Conflating them would be a serious design error.

Possible later feature: a sound that is p-locked so heavily on certain trigs that it is
effectively a different instrument might deserve its own track. Deferred — "how different
is different" has no clean answer.

## Promotion policy

Aim to promote every sound-locked sound to its own clean DN2 track, carrying its trigs,
parameter locks and per-trig values with it.

When slots run out, the remaining sounds **stay sound-locked on their origin track**,
exactly as they were on the DN1. Lossless, and the pattern still plays correctly.

Consequence of the global-map scope: because one assignment covers the whole project, a
sound that misses a slot stays locked in **every** pattern — there is no pattern where it
gets lucky. Equally, a destination track counts as available only if it is free across all
patterns, which is considerably more restrictive than per-pattern availability. This is the
price of cross-pattern consistency and it was accepted knowingly.

## Scope option: compact per pattern — IMPLEMENTED, opt-in

`planExpansion(image, { compactPerPattern: true })`, or `--compact` on `npm run convert`.

The global map's cost is visible the moment you look at a single pattern: `MORNING_JAM` A1
uses three expanded tracks, and T10, T11 and T12 sit empty because their sounds belong to
patterns in bank B. Nothing is wrong, but the layout looks sparse and the free tracks are
not doing any work in that pattern.

With this option each pattern is allocated independently, from the first free destination
up, so there are no holes. It is not only cosmetic: allocation happens against a pattern's
own candidates, so a pattern that needs three tracks gets them **even when the project as a
whole overflows**. On `MORNING_JAM` the global map leaves 8 sounds sound-locked; compact
leaves zero, and promotes 223 trigs instead of 201.

**What it costs**, and why it is not the default: a sound can land on a different track in
different patterns, so a mute, a level or a mixer position stops meaning the same thing after
a pattern change. That is precisely the property the global map exists to protect. The two
modes are a genuine trade — live performance wants the global map, a dense arrangement wants
compact — so the choice belongs to the user, not to us.

Unchanged either way: overflow stays lossless, and a sound that misses a slot keeps playing
from its origin track.

## Reusing source tracks the project never uses — IMPLEMENTED

`planExpansion(image, { useEmptySourceTracks: true })`; on by default whenever
`compactPerPattern` is set.

A DN1 synth track with no trigs still reserves its DN2 counterpart, because the layout is
positional. When that track also holds nothing but the factory init sound, the reservation
protects nothing.

**The trig count alone is not a safe test.** Of the 48 trigless synth tracks in the 55-project
corpus, **13 hold a real patch** — `WHALE_O1`, `FAVPAD`, `TX BASS 1 MF`, `SHY DREAMER` — most
plausibly loaded to play live from a keyboard. Taking those tracks would lose the sound. The
other **35** carry the factory init sound in all 128 kits and are genuinely free.

Detection compares the sound itself, not its name: CRC-32 of the 302-byte sound object with
its 16-byte name field blanked, against the init sound's fingerprint. A name test ("still
called `SOUND 3` and identical in every kit") selects the same 35 tracks on this corpus, but
it would throw away a sound whose parameters were edited and which was never renamed. If a
future DN1 OS ships a different init sound, nothing matches and nothing is freed — the right
direction to fail.

**Measured benefit: layout, not capacity.** Enabling this promotes exactly the same sounds in
every one of the 55 projects, in both global and compact mode — 149 overflowing sounds either
way, and 56 per-pattern overflows either way. The projects with a spare synth track are simply
not the projects that run out of tracks. So it defaults on only in compact mode, whose purpose
is to remove holes, and stays off in the global layout, whose purpose is to mirror Elektron's.

**Not done: shifting the survivors down.** Freeing track 2 offers exactly as many destinations
as moving tracks 3 and 4 into it. Renumbering would cost the positional 1:1 property, require
permuting the per-track MIDI channel array at DN1 `0x299A1B`, and need a song-table guard for
the eight per-track bytes whose position in a song row is unknown — all for contiguity. If
contiguity is wanted for its own sake it belongs in the manager, where the user is asking for
a layout change and can see it.

## Dedup: one sound locked on several source tracks

**Merge into one shared destination track, splitting only on genuine conflict.**

### Hard constraint: merged source tracks must share length and speed — IMPLEMENTED

A destination track carries **one** length and speed per pattern, written from one source
track. So two source tracks may only be merged when they agree, otherwise half the trigs run
at the wrong period — a failure that loses nothing and corrupts nothing, and is therefore
inaudible in any byte test and obvious to the ear.

The comparison is per pattern and covers what a destination inherits: **track length and
track speed**. The pattern-level scale settings — master length (RESET), change length
(CHNG), and PER PTN vs PER TRK — need no comparison, because they belong to the pattern:
two tracks in the same pattern always agree on them.

Measured across the 53-project corpus: 70 sounds are locked on more than one source track,
15 (sound, pattern) pairs draw on two at once, and only **2** of those disagree — both in
`040 250314-D&B`, where slot 0 is locked on a 64-step T1 and a 16-step T2. So the split
costs a destination track almost nowhere, and where it does the merge was wrong.

A sound whose source tracks conflict becomes **two candidates**, one per compatible group,
each competing for its own destination. Identity for planning and routing is therefore
`(pool slot, source track)`, not the pool slot alone.

Later, a smarter mechanism could make incompatible tracks compatible — repeating a 16-step
part across the pages of a 64-step destination, for instance. Until that exists, refusing
the merge is the honest behaviour.

A clap sound-locked on both track 1 (steps 5, 13) and track 3 (steps 8, 16) becomes a
single DN2 track carrying steps 5, 8, 13, 16 — the same musical result for one slot
instead of two. Slot economy matters here because the free pool may be as small as 8.

Simultaneity alone is not a conflict: DN2 tracks are polyphonic, so two source trigs on
the same step with different notes merge cleanly into one chord trig. The real blocker is
**conflicting parameter locks** — if track 1's step-5 trig locks cutoff to 40 and track 3's
step-5 trig locks it to 90, one trig cannot express both. Only then does the sound spill
onto a second destination track.

Same sound, same step, same note, same locks is a true duplicate and collapses to one trig.

## Sharing a track between sounds (later)

If there are not enough tracks to unfold everything, two sounds can share one destination
track, with the second sound-locked onto it. This is a partial win, not a clean track: the
*origin* track gets less crowded and the pair can share track parameters that suit them
both, but one of them is still sound-locked.

**The hard constraint is non-overlap, not similarity.** Two sounds whose trigs never land
on the same step can share a track with essentially no musical compromise, regardless of
what they are tagged. This is an interval-packing problem over the union of all patterns.

Tags are the right *tiebreaker* — they say which pairings are sonically tolerable — but a
poor primary key, since they are frequently absent in sketch projects.

## Using empty MIDI tracks — IMPLEMENTED, opt-in

`planExpansion(image, { useFreedMidiTracks: true })`, or `--free-midi` on `npm run plan`.

When a DN1 MIDI track carries no trigs, its DN2 counterpart (track 4+N) is unoccupied and
can take a promoted sound. Those destinations are appended **after** 9-16, so the
guaranteed-free tracks always fill first and the extras are only reached on overflow.
Enabling the option never changes which sounds win, only how many fit — there is a test
asserting exactly that.

Off by default. The original reason — that the per-track synth/MIDI discriminator had not
been located — **no longer applies**: it is the `u16be` at kit+10260, the writer clears the
bit when it claims a track, and `docs/dn2-pattern-format.md` §7 has the evidence. What is
left is a plain policy question, not a blocker, and it is still off pending hardware
confirmation that a switched track behaves.

Measured impact across the 53 projects: it raises promotions on already-overflowing
projects (`TECNO_EXP` 8 -> 12) but flips **none** from overflowing to clean. The headline
stays 44/53 either way. Useful, but not the lever it first appeared to be.

## Placement rules by tag — PLANNED

The user's own layout convention is percussive sounds on tracks 1-8 and melodic on 9-16,
and the tool should let that be expressed rather than filling destinations in numeric order.

**Tags are viable here, contrary to an earlier assumption in this document.** Measured
across all 53 projects: **99.8%** of named pool sounds carry a non-zero tag bitfield, and
**98.9%** of the sounds actually used as sound locks do. The worry that sketch projects
would be untagged is simply not true of this library.

Design sketch:

- The user defines rules mapping a tag (or set of tags) to a preferred destination range,
  e.g. `PERCUSSION -> 1..8`, `BASS|LEAD|PAD -> 9..16`.
- Rules are **preferences, not constraints**: a sound whose preferred range is full falls
  back to any free destination rather than being dropped.
- Tags remain a tiebreaker for track *sharing* decisions (see below), where the hard
  constraint is still non-overlap.

### Two layout modes

The user chooses between them; neither is forced.

**Preserve mode (default).** DN1 synth track N pins to DN2 track N, DN1 MIDI track N to
DN2 track 4+N, exactly as Elektron's own import does. Promoted sounds fill the free tracks.
The converted project stays recognisable against the original.

**Rearrange mode (opt-in).** Home sounds move too, placed by tag preference alongside the
promoted ones. Whole tracks move as a unit — sound, trigs, per-track settings and parameter
locks travel together.

**Rearrange must key off tags, not source track position.** There is a loose DN1 convention
— track 1 tends to be percussive and heavy, track 2 bass, tracks 3 and 4 synths — but it is
a tendency, not a rule, and encoding it as one would silently mis-place sounds in the
projects that break it. Tags are present on 99.8% of sounds and are the reliable signal.

### Why preserve mode is the default

Not just familiarity: **preserve mode is verifiable and rearrange mode is not.** In preserve
mode we can diff our output against Elektron's own conversion of the same project and
demand a match. Rearrange mode has no reference implementation, so its correctness rests
entirely on our own reasoning. Ship the testable path first, and give rearrange mode a
preview so the user can see the layout before committing.

### Risk to check before shipping rearrange mode

The 55,552-byte project-settings region in the DN1 tail is unmapped. If it holds song or
arranger data, mute states, or anything else that references tracks **by index**, moving a
sound from track 2 to track 11 would desync it — the pattern would play correctly while the
arrangement pointed at the wrong track. Preserve mode is immune because indices do not
change. Map that region, or at least establish that it contains no per-track references,
before rearrange mode is offered.

### The tag table — DONE and verified

`src/project/tags.ts`. Names come from `ashojaeddini/digitools`, checked against 541
distinct named sounds from the 53 projects using sound names as an independent signal:
KICK 45/45, SNAR 39/39, PAD 13/13, LEAD 4/4, ARP 1/1, BASS 39/40, HHAT 30/31, PERC 34/36.
The two near-misses were probe false positives ("THAT ORGAN SM" contains HAT; "SUB KICK FP"
contains SUB). **CYMB (bit 7) is unconfirmed** — set on none of the five RIDE sounds that
imply it.

### The wrinkle: 30% of sounds are tagged both ways

Across all 283 sound-locked sounds: **164 percussive, 30 melodic, 85 mixed, 4 untagged**.

Mixed is not rare and it is not noise-free. `CLAP SM` carries `[BRAS PERC]`; `POP HZ X2`
carries eight tags including `KICK SNAR DEEP BRAS STRI PERC HHAT TXTR`. People tag
generously, so a naive "is it percussive or melodic" test fails on nearly a third of sounds.

A **percussion-first** rule — any percussive tag wins, regardless of what else is set —
classifies both examples correctly and suits this domain, since sound-locked sounds skew
heavily percussive by the nature of the DN1 workflow. It would misplace a pad that someone
also tagged PERC, which is the rarer error.

`soundCharacter()` deliberately returns `mixed` rather than resolving it, so the tie-break
stays a policy decision at the placement layer instead of being buried in the classifier.
Worth putting the percussion-first default in front of the user rather than assuming it.

## Promotion order

**Deliberately not decided.** Do not build a scoring function until task #6 reports how
often and how badly overflow occurs. Ship a trivial rule plus manual override first.

Candidates considered:

- **Trig count / p-lock presence** — simple and predictable, but frequency correlates
  poorly with which sounds are actually suffering. A sound on 16 non-overlapping trigs is
  fine where it is.
- **Voice contention** — promote the sounds that actually conflict: overlapping the home
  sound's envelope, getting choked, or fighting for the track's voice. Targets the real
  reason to move a sound, but needs note-length and envelope data.
- **Sound tags** — the DN1 tag bitfield is 4 bytes in the decoded sound and the tag-name
  table is public, so this is readable. But tags are user-assigned and frequently absent
  in exactly the sketch projects this tool targets (MORNING_JAM contains a sound named
  `SOUND 3`). Useful as a tiebreaker; unreliable as a primary key. Machine type and
  envelope shape are better percussion/sustained signals because they derive from the
  sound itself rather than from metadata someone forgot to set.

## Fallback and lossiness

When a sound cannot be promoted it **stays sound-locked on its origin track**, exactly as
it was on the DN1. That is lossless — the pattern still plays as it did — so overflow
degrades gracefully rather than dropping music.

Lossiness reporting is a first-class output. The tool must say what stayed behind and why,
never silently drop trigs.

## Open questions

- **Voice budget.** The DN1 has 8 voices and the DN2 has 16, so there is headroom, but
  expanding does not create polyphony from nothing. Whether promoted tracks need voice
  allocation checks is untested.
- **Machine mapping — SOLVED.** The DN1 has no selectable machines: one FM engine per synth
  track, whose DN2 equivalent is FM TONE, and MIDI tracks map to MIDI tracks. The full
  302-byte to 359-byte sound field mapping is derived and reproduces Elektron's own
  conversion byte-for-byte on all 5,760 available sound pairs. See `docs/sound-mapping.md`
  and `src/project/soundmap.ts`. Residual risk is confined to a handful of fields that never
  vary in the corpus and are flagged as inferred rather than verified;
  `convertDn1SoundToDn2Detailed` returns per-field warnings so the expander can refuse or
  flag rather than silently write a guess to hardware.
- **Dedup across source tracks — SETTLED**, see the dedup section above.

## UI implication

Ship a heuristic plus a preview with manual override, not a perfect heuristic. A
drag-to-reassign preview beats any scoring function, costs less than tuning one, and
handles the cases no heuristic will get right. The score picks the default order; the user
fixes what it gets wrong.
