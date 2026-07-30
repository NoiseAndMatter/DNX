# Probing a device safely

**The question that prompted this document:** *could any of the messages erase the devices or
corrupt them?*

**Yes.** Some certainly can, one whole class of them can, and a handful are genuinely unknown.
So "let's just send them all and see" is the one experiment not to run — and the rest of this
page is how to get almost all of the same information without that risk.

---

## What can hurt

### Named, and obviously destructive

`DirDelete` (`0x12`), `FileDelete` (`0x20`), `ItemRename` (`0x21`), and the `FileWrite` family
(`0x40`–`0x42`). Neither Digitone advertises any of these, so on this hardware they are moot —
but the classification exists because a Digitakt II does have them, and because "the device we
happened to test does not implement it" is not a safety property.

### The dumps, which is the one people miss

**In this family, a dump *is* the data.** The device sends `0x50` to hand you a pattern; you send
`0x50` to give it a pattern. So an advertised dump code is not a question you can ask — it is a
sentence you can say, and the sentence is *"here, store this."*

That makes the `0x50`–`0x5e` band, which is **most of what a Digitone advertises**, the largest
hazard on the list. Sending `0x50` with an empty or malformed body is not a harmless ping; it is
an attempt to overwrite a pattern slot with nothing.

Requesting a dump is a **different code** — `0x60` and up — and that is the read half.

#### Where that comes from, graded

There is **no public specification**. Elektron publishes nothing about this protocol; everything
below is either our own captures or elk-herd's reverse-engineering.

| Claim | Evidence | Strength |
|---|---|---|
| `0x50` and `0x53` carry data **on a Digitone** | our own corpus captures are these types, and we parse them byte-exactly | **verified** |
| `0x5n` = data, `0x6n` = request | elk-herd `SysEx/Dump.elm` pairs every one: `0x50`/`0x60`, `0x51`/`0x61`, `0x52`/`0x62`, `0x53`/`0x63`, `0x54`/`0x64`, with the `0x5n` carrying a decoded struct and the `0x6n` an empty body | **verified on the Digitakt family**, a working implementation against real hardware |
| Sending a `0x5n` **writes** | elk-herd uploads via `SendDump`, documented in `Client.elm` as *"Sends a Dump Response"* — the response codes are the `0x5n` | **verified on the Digitakt family** |
| `0x6n` requests behave the same **on a Digitone** | family convention only; we have never sent one | **inferred** — `devices.ts` says as much |
| The `0x50`–`0x5e` in `supportedMessages` **are** dump types | the values coincide with known dump types and the band is contiguous | **inferred.** That list comes from an API message, and every API code we can source is `0x01`–`0x4x`. They could be undocumented API messages in a `0x5n` band |

**The refusal does not depend on that last inference**, which is the point of stating it. If they
are dump types they are writes; if they are not they are undocumented API messages. Both are
things not to send, so the gate is right either way — and for a reason that can be checked rather
than a guess that happened to land.

### The unknowns

`0x03` and `0x04` on both Digitones, plus `0x06` and `0x07` on the Digitone II, appear in no
source we have, elk-herd included. They could be reads. They could be `factory_reset`. There is
no way to find out by sending them that is also a way to find out safely.

---

## The regime

### 1. Allowlist, never blocklist

An allowlist fails safe; a blocklist fails dangerous. `src/device/capabilities.ts` classifies
every message as `read`, `write` or `unknown`, and the probe sends **only `read`** through a
single gate, `safeToSend`.

`unknown` is kept distinct from `write` deliberately. Collapsing them would lose the fact that
the unknowns are the interesting ones — *"this is dangerous"* and *"we have no idea"* are
different states, and only one of them is worth research.

### 2. Prefer `Query`, because it is a read by design

`0x09` takes a key and returns a tagged value, and an unrecognised key answers `none` rather than
failing. That makes key-guessing free: a wrong guess costs one round trip and tells you the key
does not exist.

It is the **right way to interrogate a device**, and it is why the probe now sweeps a list of
keys rather than a list of message codes. Digitone II only — the DN1 does not advertise it.

### 3. Back up before, verify after

The +Drive is the only copy of that work. Export anything you care about first.

Afterwards, check the device still behaves: does the project load, are the patterns intact, does
`npm run project -- <exported file>` still parse it. A corruption you do not look for is one you
find weeks later.

### 4. One at a time, on something expendable

Load a **scratch project** as the active one, so anything that writes to "current" hits something
you do not mind losing. Send one message per run and record the result. A batch that changes
something tells you far less than a sequence that does.

### 4a. …except for messages already proven, where volume is a separate question

**Read project** breaks rule 4 on purpose: it sends 257 requests in a row. That is defensible only
because of *what* it sends — every one a `0x6n` request with an empty body, the same five messages
already verified twice on both machines, through the same code path as the single **Request**
button. Rule 4 is about **unknown** messages, and none of these are unknown any more.

What it does introduce is a **volume** risk, which is a different thing and is handled separately:
one request in flight at a time, a stop button, and a confirmation naming the size before anything
goes out. A device answering 257 questions is still only ever answering questions.

### 5. Empty payload is not the same as safe

A command with no arguments may still be *"do the thing"*. `Device` and `Version` take no
arguments and are safe — not *because* they are empty, but because we know what they are. The
reasoning has to come from the message's meaning, never from the size of its body.

---

## Writing to a device

Everything above is about reading. **This section is about the first thing in DNX that can destroy
someone's work**, and it is written before the code rather than after it.

A `0x5n` sent *to* an instrument means **store this**. There is no dry run on the wire, no undo,
and no confirmation prompt from the device — it takes the bytes and keeps them. elk-herd writes a
project this way, which is the direct evidence for what these messages do in this direction.

### The one thing that changed, and why writing is now testable

Until a device could be *read* by request, "did that write land correctly?" could only be answered
by looking at the instrument's screen. It can now be answered exactly: **write a record, request it
back, compare the bytes.** That is the same round trip that caught `G11`, and it is what makes a
write verifiable rather than merely apparently-successful.

So the rule is: **a write is not finished until it has been read back and compared.** Not "the
device did not complain" — the device does not complain.

### Start with the write that cannot change anything

The first write should be a **null round trip**: take a record just read from this device and send
it back to the slot it came from. Identical bytes to the same place.

- If the write path works, nothing changed.
- If the write path is broken, nothing changed either.
- If the bytes land somewhere else, the read-back shows it and the original is still in the
  capture.

Only after that succeeds is it worth writing a record to a *different* slot, and only then a
record from a *different* project.

### Five guards, and what each one is for

1. **A scratch project, loaded on the device.** Same rule as probing an unknown code, for the same
   reason. Export everything first and confirm the exports parse.
2. **The object number.** It is the only thing standing between the intended slot and someone's
   work, and it is one byte. Range-checked in code, and shown in the confirmation.
3. **Payload size must equal the record's size for that family.** A short payload is not a partial
   write to be tolerated; it is a message that means something else.
4. **Storage version must match.** A record captured under one firmware, written to a device
   running another, is precisely the corruption this project has spent its whole life avoiding.
   The strong form of the check is the one to use: *the record being written must match the
   version of a record read from this same device in this same session.*
5. **Never `0x54` ProjectSettings, and never `0x53` on a Digitone 1, without a specific reason.**
   Settings is global state rather than one slot. And a DN1's `0x53` is ambiguous in the *read*
   direction — kit sound or pool sound — so its write direction is unproven, and an unproven write
   is not a place to find out.

### What is still unknown, and must be treated as unknown

- ~~Does a write reach the +Drive project or the active copy in RAM?~~ **ANSWERED 2026-07-30: the
  active project, not the +Drive.** A written pattern survives a power cycle and is **lost when
  another project is loaded without saving**. The device's own SAVE PROJECT is the commit step.

  **The obvious test was worthless and is worth remembering as a trap.** Power-cycling without
  saving proves nothing here, because a Digitone restores its exact working state on boot — so
  both possible answers predict the same observation. Switching projects is what discriminates. A
  test that cannot come out both ways is not a test.

  Practical consequence: a write is **reversible until the user saves**, which is a stronger undo
  than anything in this codebase — but only for someone who has been told.
- **Whether a write to an occupied slot prompts, overwrites, or is refused.** Unknown. This is why
  the first non-null write went to an empty slot.

  **Do not expect a handshake.** The device answers a write with *nothing at all* — success and
  refusal are both silence, which is the entire reason the read-back exists. elk-herd writes whole
  Digitakt projects by sending `0x5n` directly, with no confirmation step anywhere in it. Something
  could still be hiding in the unidentified `0x55`–`0x5e`, but nothing observed points at one, and
  a guard rail nobody can see is not a guard rail.

  So the outcome has to be read back and compared **three** ways, not two: against what was sent
  (**overwritten**), against what the slot held before (**refused**), and against neither
  (**something else**). Comparing only against what you sent makes a refusal and a mangled write
  look the same.

  **The experiment is free**, because of the finding above: a write lands in the active project, so
  loading another project without saving discards it. Nothing needs restoring, and that is a better
  safety net than any handshake would be.

---

## Trying an unidentified request — and why the earlier conclusion was too strong

**Corrected 2026-07-30.** This document, and ROADMAP §3c-iv, concluded that whole projects cannot
be addressed on a Digitone because neither machine advertises the file API and `DirList` timed out.

**The first half of that is worthless, and this project proved it.** Neither Digitone advertises
`0x60`–`0x6f` either, and both honour them — the lesson *"`supportedMessages` enumerates responses,
so absence is not a refusal"* is written down two sections above, and was then contradicted by
using absence as evidence about the file API.

Two facts push the other way:

1. **Elektron's Transfer writes projects into chosen slots on a Digitone.** A mechanism exists.
2. **Project storage on both machines is a flat indexed list, not a filesystem** — no folders, the
   same shape as sound storage. So `DirList` may have been the *wrong question* rather than an
   unimplemented one: a Digitone has no sampler, so it has no files to manage. elk-herd's file API
   is a **Digitakt** feature because a Digitakt has samples.

A flat list addressed by index is what the **dump protocol** already does, and nine or ten dump
types per machine remain unidentified. That is where a project object would sit.

### The control on the probe page

**Try code** sends one `0x6n` request with an empty body and reports whatever comes back. It obeys
the rules above rather than sidestepping them:

- **One code per press.** There is no sweep-all, because rule 4 is one message per run and the
  whole value is knowing which code produced what.
- **The known five are in the list as controls.** A silent unknown code means nothing until a known
  one has spoken on the same connection — otherwise "not implemented" and "not listening" are
  indistinguishable.
- **Only `0x60`–`0x6f` can be built.** Enforced in `probecodes.ts`, not left to care: a `0x5n` is a
  write, and the difference is one bit in one byte.
- The reply is **measured against record sizes we can name**, because every record identified so
  far was recognised by its size first.

The safety argument is the same inference that made `0x60`–`0x64` acceptable — an empty body has
nothing to store — and it is still an inference. Scratch project, one at a time, look at the device
in between.

**Try the Digitone 1 first.** Not because it is likelier to answer, but because its answer is worth
more: the DN1's sound pool cannot be requested at all, so if a project-level object exists and
carries a whole project, on a DN1 it would likely carry the pool with it — removing the only manual
step in the expander flow. On a DN2 the same finding is merely convenient.

---

## If you want to probe an unknown code anyway

It is a legitimate thing to want, and this is how to make it as cheap as possible to be wrong:

1. Export every project you care about. Confirm the exports parse.
2. Load a scratch project and note its name, pattern and track.
3. Send **one** unknown code, with an empty body.
4. Look at the device: same project, same pattern, same track? Any prompt on screen?
5. Save and export. Diff against step 1's export — `npm run diff` will show it.
6. Only then move to the next code.

The probe does not offer a control for this, on purpose. Adding a button to send arbitrary codes
would make the dangerous thing the same number of clicks as the safe thing, and the safe thing is
what people should be able to do without thinking.

---

## What we know so far

| Device | Product id | Firmware / build | File API | Query | Dump types |
|---|---|---|---|---|---|
| Digitone 1 | 20 | 1.42A / 0097 | none | no | 14 (`0x50`-`0x5d`) |
| Digitone II | 43 | 1.10E / 0050 | none | yes | 15 (`0x50`-`0x5e`) |

### Query works, and answers instantly

Confirmed on a Digitone II: **all eleven keys answered in one sweep**, ten with `none` and one
with a value. So the original premise holds — an unrecognised key comes back `none` rather than
silence, which makes guessing keys genuinely free.

A slow sweep during testing looked like the device ignoring unknown keys. It was not: it was a
browser silently dropping SysEx. Worth recording, because the wrong lesson from that would have
been "do not sweep keys."

**The one key that answers:** `sample_file.interleaved_stereo_support` returns **`true` on a
Digitone II** — a machine with no sampler whatsoever. That makes the namespace a shared Elektron
platform one rather than a per-product list, and means a key can answer about a feature the
hardware does not have. It is the only confirmed key on this family.

Every `project.`, `pattern.`, `kit.`, `sound.` and `device.` guess returned `none`, so those
namespaces are wrong rather than those properties being absent.

### One browser note that cost an hour

**Firefox implements Web MIDI but gates SysEx behind a separate site-permission add-on, and drops
it silently when that is missing.** Ports open, `send()` does not throw, and nothing ever comes
back — identical to a dead device. The same probe succeeded in Chrome with nothing else changed.

Use **Chrome or Edge**. The probe now says so in its failure card when it sees zero bytes on a
non-Chromium browser.

Both advertise `0x01 Device`, `0x02 Version`, `0x03`, `0x04`, and the dump band. The DN2 adds
`0x06`, `0x07` and `0x09 Query`.

See `docs/ROADMAP.md` §3c-iv for how this was found, including the assumption it corrected.
