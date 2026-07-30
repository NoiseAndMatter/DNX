# The Digitone's storage API

**How a Digitone exposes its +Drive: projects, sound banks, listings and whole files.**

Established 2026-07-30 by capturing Elektron's own **Transfer** application talking to a Digitone 1
while `/probe` listened on the same MIDI input. Everything here is **[verified]** from that
capture, decoded offline; the request side is **inferred**, and this document says which is which.

---

## The headline: it exists, and we had concluded it did not

`docs/ROADMAP.md` §3c-iv and `docs/device-probing.md` both said the +Drive file API is **not
implemented on either Digitone**. That was wrong, and the way it was wrong is worth keeping.

The evidence had been:

1. Neither machine advertises elk-herd's file-API codes (`0x10`, `0x30`–`0x32`, `0x40`–`0x42`).
2. `DirList` (`0x10`) timed out.

Both observations were true. **The conclusion did not follow.** The file API exists on a Digitone
at *different codes* — `0x53`–`0x5a` in the **API** space.

> [!warning] **And the second pillar is no better than the first — corrected 2026-07-30**
> This section first said *"`0x10` timing out means only that `0x10` is not implemented, which is
> exactly what it says."* **It does not say that.** It says nothing came back, and we cannot show
> anything went out.
>
> `output.send()` does not throw when another application holds the port — it returns normally and
> the bytes go nowhere. If Transfer was running when we probed, **`DirList` may never have left the
> machine.**
>
> So `0x10` is **untested, not absent**, and it should be retried with Transfer definitely closed
> and a link check first. If it answers, elk-herd's implementation may apply directly, which is a
> far better starting point than reverse-engineering `0x53` from responses.
>
> The pattern is the point: the first pillar was corrected, and then the same overconfidence was
> rebuilt on the second within the hour.

The first observation was worthless on its own and this project had already proved it: neither
Digitone advertises `0x60`–`0x6f` either, and both honour them. That lesson was written down in
`device-probing.md` and then contradicted two sections later.

**What broke the deadlock was the user, three times**: *Transfer demonstrably writes projects into
chosen slots, so a mechanism exists* · *storage is a flat list, not a filesystem — `DirList` may be
the wrong question* · *Transfer shows sounds at exact positions, so the protocol carries position.*
Each time the model was patched instead of replaced. The test that settled it — capture Transfer
itself — was also the user's proposal.

---

## 1. The codes — **[verified]** as responses, requests inferred

Captured response codes, with the request each implies by the API's `+0x80` convention:

| Response | Request | What it does |
|---|---|---|
| `0xd3` | **`0x53`** | **Directory listing.** Answers `Invalid path` when the path is wrong |
| `0xd4` | **`0x54`** | File open — body 10 bytes |
| `0xd5` | **`0x55`** | File read — returns content in chunks |
| `0xd6` | **`0x56`** | File close — body 9 bytes |
| `0xda` | **`0x5a`** | A mutating operation; acknowledged with a single `01` |
| `0xdb` | **`0x5b`** | Another mutation, same single `01` |
| `0xdc` | **`0x5c`** | A third mutation, same single `01` |

> [!note] These are **API** messages — header `0x10`, `F0 00 20 3C 10 00 …` — not the dump
> protocol. They appear in no public source, elk-herd included, which implements the same ideas at
> `0x10`/`0x30`/`0x31`/`0x32` for the Digitakt.

**Only responses were observed.** Web MIDI let us listen on the input while Transfer held the ports,
so we saw the device's half of every exchange and none of Transfer's. Request *arguments* — the
path strings, the indices — are therefore **not** established.

---

## 2. The directory listing — **[verified]**

### Response header, 13 bytes

| Offset | Type | Meaning |
|---|---|---|
| `0` | u8 | `1` on success |
| `1` | u32be | index of the first entry in this page |
| `5` | u32be | **next cursor** — where a following request would resume |
| `9` | u32be | number of entries in this page |
| `13` | — | the entries |

It is **paginated**, and the cursor is a 32-bit field — so nothing here is limited by the dump
protocol's 7-bit object number.

### Entries

Each entry is a **NUL-terminated name followed by a fixed trailer**, and the trailer differs by
kind.

**Directory** — `name\0` + `01 01` + u32be child count:

```
"projects\0"    01 01 00 00 00 80    ->  128 children
"soundbanks\0"  01 01 00 00 00 08    ->    8 children
```

**File** — `name\0` + `00 02` + u32be index + u32be size + u16be *(unidentified)* + `01 01`:

```
"DIGIT-ONE\0"        00 02  00000001  0000012e  0012  0101
"CHAPPET DL\0"       00 02  00000002  0000012e  0012  0101
"HH TICK_PITX_AR\0"  00 02  0000001c  0000012e  007e  0101
```

`0x12e` = **302**, exactly a DN1 sound record. `0x1c` = 28, and 28 is the slot the user moved
during the capture — the index is the **position**, stated by the device.

### What that settles

**Position is carried explicitly**, with names and sizes, in 32-bit fields. Reading the +Drive does
not depend on send order and is not affected by the object-number saturation that limits bulk dumps
(§5c). This is the mechanism Transfer uses to show a sound in its exact slot, which is what the
user pointed out must exist.

### The shape of the store, read off the listings

- **`/projects`** — 128 entries
- **`/soundbanks`** — 8 entries, each listing **256** sounds

### Unidentified

- **The u16be before `01 01` in a file entry.** Constant width, varies per sound: `0x0012` for
  `DIGIT-ONE`, `0x007e` for `HH TICK_PITX_AR`. **Hypothesis: the sound's tag bitmask**, which
  `src/project/tags.ts` already models for DN1 sounds. Testable — tag a sound on the device and
  re-list.
- **The trailing `01 01`**, constant on every entry seen. A version or terminator.
- The leading pair (`01 01` for directories, `00 02` for files) is read as a kind marker, but only
  two kinds have been observed.

---

## 3. Reading a whole file — **[verified]** in shape

The sequence around a project download was `0xd4` → `0xd5` (repeatedly) → `0xd6`:

```
0xd4  body 10   open
0xd5  body 22   ...
0xd5  body 151  ... {"metaversion": 1, ...
0xd6  body 9    close
```

The chunks carry **`manifest.json`** — byte for byte the same manifest `src/project/projectfile.ts`
parses out of a `.dnprj`. Another read returned `0097`, the DN1 format version.

**So Transfer pulls the actual project file off the +Drive**, and a project read this way would be
complete — no 257 requests, and none of the 0.49% a dump-based rebuild has to borrow from a donor
(§3c-vi).

## 3a. The read protocol, decoded — **[verified]** 2026-07-30

All 27 read replies in the capture, across a manifest, a sound and a project.

### Open reply, `0xd4` — 10 bytes

| Offset | Type | Meaning |
|---|---|---|
| `0` | u8 | `1` on success; `0` then the device's own sentence on failure |
| `1` | u32be | **handle** — counts up from 1 per open |
| `5` | u32be | **chunk size, 2,048** — identical on all three opens |
| `9` | u8 | `1`, unidentified |

A failure reads `00 "Error: Could not resolve …"`. The device explains itself, which is how
`invalid project id` taught us `0x54` takes a slot rather than a path.

### Read reply, `0xd5`

| Offset | Type | Meaning |
|---|---|---|
| `0` | u8 | `1` on success |
| `1` | u32be | handle |
| `5` | u32be | **chunk index, 1-based** |
| `9` | u32be | unidentified — climbs to exactly `1000` on the last chunk |
| `13` | u8 | **`1` on the final chunk** |
| `14` | u32be | unidentified — plausibly a checksum; `ffffffff` on the leading reply |
| `18` | u32be | **data length** |
| `22` | — | the data |

**The declared length matched the payload on 27 of 27 replies**, and the flag at 13 fired exactly
once per file — on chunk 1 of 1 for the manifest, and on chunk 22 of 22 for the project.

> [!important] **The end of a file is the flag, never a short chunk.**
> The manifest arrived as a *single* 129-byte chunk with the flag set; the project ran 21 full
> 2,048-byte chunks and one short one. A reader that stopped on a short chunk would have truncated
> the first file and worked perfectly on the second — which is the worst way to be wrong.

### The leading reply carries no data

Every read sequence opens with a 22-byte reply whose declared length is **0**. Its index field
reads `0x4012c344` — constant across all three files — followed by a word that varies per file, and
its checksum field is `ffffffff`.

**Unidentified.** Reading that constant as a chunk index would produce confident nonsense, so
`parseRead` flags it (`metadata: true`) and `readStoredFile` skips it while keeping the bytes for
whoever solves it. Whether it is a stat, a header, or an artefact of Transfer sending something we
have not reconstructed is unknown.

### What is still guessed

`0x55`'s request. Reads are sequential and the device numbers the chunks itself, so a handle is the
only argument the sequence demonstrably needs — but if the device wants the index too, this is
where it goes. The failure mode is safe: the reply states its own index and `readStoredFile`
refuses one that is out of order rather than assembling it.

---

## 4. Transfer's idle poll — **[verified]**

With Transfer open and idle, the device answers a continuous loop of three:

| Response | Request | Body |
|---|---|---|
| `0x81` | `0x01` Device | 29 bytes — product `0x14` = 20, then `supportedMessages` |
| `0x82` | `0x02` Version | 11 bytes — `"0097"`, `"1.42A"` |
| `0x83` | **`0x03`** | **4 bytes, constant** — `d2 ef a8 fd` across 1,991 samples |

`0x03` is one of the four API codes that appear in no source. Its answer never changes, so it is
**not** a counter or a change-token — most likely a device identity, the same shape as the 4-byte
project identity at image `0x18`. Worth confirming by capturing a Digitone II's, which should
differ.

**This is also a trap.** 1,991 × 3 messages of background poll traffic arrive on the same input as
anything we do. See `KNOWN-ISSUES.md`: a probe that accepts "the next message" as its reply will
happily report Transfer's traffic as an answer.

---

## 5. Port exclusivity — **[verified]**

**Transfer must be started before anything else claims the ports.** With `/probe` listening,
Transfer will not launch; once Transfer is running, `/probe` can open the same input and listen.

The practical consequence is worse than the inconvenience: with Transfer running, **our sends may
not reach the device at all**, while its replies keep arriving. That combination produced a false
positive — see `KNOWN-ISSUES.md`.

---

## 5a. The request side — SOLVED for listing, 2026-07-30

**[verified] on hardware.** The requests were reconstructed from response shapes alone and then
confirmed one field at a time. `/` returned `projects` and `soundbanks` on the first attempt.

### `0x53` — list a directory

```
0x53   path\0   [u32 start]   [u32 count]
```

- **Paths are absolute and use `/`** — `/`, `/projects`, `/soundbanks`, `/soundbanks/A`. A bare
  `projects` or `soundbanks` is refused.
- **Directory-only.** `/soundbanks/A/DIGIT-ONE` and `/soundbanks/A/SIMPLE LEAD JM` both answer
  `Invalid path`. There is no stat; a file has no listing.
- **A bare path returns the whole directory** — 128 projects, 256 sounds, one response.
- **`start` alone returns nothing.** Sent a start of 28 with no count, the device answered
  `first 28, next 28, count 0` — on two different paths. It honoured the cursor and returned the
  zero entries we asked for, which is how the second field was found.

`listRequest` takes them as one `Page`, never separately, so a request for nothing cannot be
written by accident.

### `0x54` — open a file **by path** — three attempts, two of them fatal

```
0x54   path\0
```

| Body sent | NUL-terminated | Device |
|---|---|---|
| `path\0` | **yes** | answered `invalid project id` |
| `u32 id` | no | **froze** |
| `u32 id, u32 2048, u8 1` | no | **froze** |

**The freeze tracks the missing terminator, not the length or the content.** That is what a string
parse running off the end of a buffer looks like: the handler reads a NUL-terminated argument the
way every other message in this API does, finds no NUL, and walks until something gives.

So the request takes a **full path to a file** — `/projects/PRESETS`, not `/projects`.

> [!danger] **`0x54` froze a Digitone 1 three times — the most dangerous message we send**
> Each time the device stopped responding entirely: **capture 0 bytes**, no error, no reply. Only a
> power cycle recovers it, and anything unsaved in the active project goes with it.
>
> Three diagnoses, in the order they were believed:
>
> 1. **A leaked handle** — we never sent `0x56`. True, and worth fixing, but it never fit: a leak
>    does not kill a device on the *first* allocation and does not swallow the reply.
> 2. **A short body** — the reply carries a chunk size, so perhaps the request supplies one. Sent
>    `u32 id, u32 2048, u8 1`. **It froze the device again**, so length is not it either.
> 3. **The missing NUL**, above. The only body the device has ever answered.
>
> `storagesession.ts` guarantees the close regardless, and the message stays gated behind a token.
> **Two hypotheses have already been wrong; this is the third.**

#### And the error message was misread — which is what cost the two power cycles

`invalid project id` was recorded as the device *naming its own argument type*: "not `Invalid
path`, which is what `0x53` says — it objected to the **kind** of argument", written down as *"a
more useful error than most documentation"*.

**It says nothing of the kind.** It says the path resolved to no valid project — which was exactly
true, because the probe reused whatever sat in the listing box, and that was `/projects`: a
**directory**.

> **An error names what failed, not what was wanted.** `0x53` says `Invalid path` when it cannot
> *parse* a path; `0x54` says `invalid project id` when it cannot *resolve* one. Two stages of the
> same string argument, not two argument types.

A graceful, accurate error was read as an invitation to change the argument type. The invitation
was imaginary and the device paid for it.

### What the listing shows

| Path | Entries | Notes |
|---|---|---|
| `/` | 2 | `projects` (128 children), `soundbanks` (8) |
| `/projects` | 128 | names, 1-based ids, **4,194,304 B each** |
| `/soundbanks` | 8 | `A`–`H`, **262,144 B each** |
| `/soundbanks/A` | 256 | sound names, ids, **302 B each** |

**Those sizes are allocations, not contents.** A DN1 image is 2,781,700 bytes and a `.dnprj` is
~25 KB compressed, yet every project reads 4 MiB; 256 sounds of 302 bytes is 77,312, yet every bank
reads 256 KiB. Nothing should compute free space from them.

Names decode as Windows-1252 and the corpus proves it matters — `WÖÖPZ ZB`, `PLUCKY EÅ`.

## 5b. Mutation is **three** codes, not one — found 2026-07-30

Re-decoding `product16_Project_395msg_1353.syx` once the capture summariser understood API framing
turned up two codes that had been sitting in the file unread. That capture is a deliberate
experiment — the user drove Transfer through **move, copy and delete, on both a sound and a
project**, while `/probe` listened.

| Reply | Times | Body |
|---|---|---|
| `0xda` | 4 | `01` |
| `0xdb` | 2 | `01` |
| `0xdc` | 2 | `01` |

Eight mutations, three codes, every one acknowledged by a single `01` and **every one immediately
followed by a `0xd3` re-list** of the directory it touched — Transfer refreshing its view, which is
also how each ack was located.

**Which code is which operation is not established.** Three codes and three operation *kinds* is
suggestive and nothing more: the counts are 4/2/2 rather than the 2/2/2 that reading would predict,
so at least one operation is either two messages or was performed twice. Only Transfer's request
half would settle it, and we never see that half.

What it does settle is that **`0x5a` is not "the write message"**. Anything built on the assumption
that one code covers mutation is built on a sample of one.

> These are all **replies**, so nothing here says what the requests carry. Guessing the arguments
> for a message that moves or deletes a project on someone's +Drive is not in the same risk class as
> guessing a listing's — see `device-probing.md` rule 0.

## 6. What is still unknown

- ~~The request side.~~ **SOLVED for `0x53` and `0x54`** — see §5a. Reconstructed from responses
  and confirmed on hardware. `0x55` (read) and `0x56` (close) are still unattempted, deliberately:
  they wait until an open has returned a handle whose width we have seen, because guessing three
  messages at once produces a failure that cannot be attributed to any of them.
- **Writing.** `0x5a`, `0x5b` and `0x5c` acknowledge mutations (§5b) but we never saw what was
  asked, and which code is which operation is unknown. Upload was not tested.
- **Whether the Digitone II speaks the same API.** Everything here is from a Digitone 1.
- The three unidentified fields in §2.
