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

### 5. Empty payload is not the same as safe

A command with no arguments may still be *"do the thing"*. `Device` and `Version` take no
arguments and are safe — not *because* they are empty, but because we know what they are. The
reasoning has to come from the message's meaning, never from the size of its body.

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

| Device | Product id | Firmware / build | File API | Query |
|---|---|---|---|---|
| Digitone 1 | 20 | 1.42A / 0097 | none | no |
| Digitone II | 43 | 1.10E / 0050 | none | yes |

Both advertise `0x01 Device`, `0x02 Version`, `0x03`, `0x04`, and the dump band. The DN2 adds
`0x06`, `0x07` and `0x09 Query`.

See `docs/ROADMAP.md` §3c-iv for how this was found, including the assumption it corrected.
