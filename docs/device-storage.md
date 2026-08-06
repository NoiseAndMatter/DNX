# The Digitone's storage API

**How a Digitone exposes its +Drive: projects, sound banks, listings and whole files.**

Established 2026-07-30 by capturing Elektron's own **Transfer** application talking to a Digitone 1
while `/probe` listened on the same MIDI input. Everything here is **[verified]** from that
capture; the **requests** were later read off a USB capture (§7), so both halves are now verified.

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

> [!success] **Retried, and now genuinely absent — 2026-07-30**
> `0x10` was sent from the probe's **Ask** control with Transfer closed. No reply within 4 seconds,
> and the **link check passed** — the device answered `Device` immediately afterwards, so the
> silence is the instrument's and not a blocked send.
>
> **`DirList` is not implemented on a Digitone.** Verified, not assumed. elk-herd's file API does
> not apply to this family, and reverse-engineering `0x53`–`0x5c` from Transfer's responses was
> necessary rather than redundant.
>
> Worth keeping for the shape as much as the answer: the original negative was *right about the
> conclusion and wrong about the evidence*, and it stayed unverified for three days because being
> right by accident feels identical from the inside to being right on purpose.

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
| `0xd7` | **`0x57`** | Open for **writing** — declares the total length up front |
| `0xd8` | **`0x58`** | Write a chunk |
| `0xd9` | **`0x59`** | Close a writer — **this is the commit** |
| `0xda` | **`0x5a`** | **Move** — source and destination paths |
| `0xdb` | **`0x5b`** | **Copy** — same arguments |
| `0xdc` | **`0x5c`** | **Delete** — one path |

> [!note] These are **API** messages — header `0x10`, `F0 00 20 3C 10 00 …` — not the dump
> protocol. They appear in no public source, elk-herd included, which implements the same ideas at
> `0x10`/`0x30`/`0x31`/`0x32` for the Digitakt.

> [!success] **Both halves are now verified — 2026-07-30, from a USB capture**
> This section said *"only responses were observed"* for three days, and everything built on it was
> a reconstruction from replies. The reconstruction was **wrong about `0x54` three times** — each
> version froze the instrument — and **wrong about `0x55` twice**.
>
> Wireshark with **USBPcap** captures below the MIDI layer, where Transfer's own requests are
> visible. One project download, one upload, and a handful of moves, copies and deletes settled
> every open question in about a minute. §7 has the requests, byte for byte.
>
> The lesson is not subtle: **we spent three days inferring what one capture stated.** The reason it
> was not done sooner is that the native routes had not been exhausted, and doing it first would
> have been reaching for a tool before asking the instrument — `device-probing.md` rule 0a-prime.
> Both halves of that are true, and the order still mattered.

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

- ~~**The u16be before `01 01` is probably the sound's tag bitmask.**~~ **Wrong — it is a permission
  mask, and the two bytes after it are occupancy. See §8.** The hypothesis had two samples,
  `0x0012` on `DIGIT-ONE` and `0x007e` on `HH TICK_PITX_AR`, and fit both. They are a factory sound
  and a user sound.

  > [!question] **And on a `/projects` listing it may answer a different question entirely.**
  > It varies there too — `PRESETS` reads `0012 0101`, `MORNING_JAM` and `AMBZ` read `007e 0101` —
  > and the tag-bitmask reading came from *sound* listings and was never tested on projects.
  >
  > The question worth the most right now is **which project is currently loaded**, and the dump
  > protocol cannot answer it: the project name lives at image offset 8, in the header, which is
  > exactly the region no dump carries.
  >
  > **The experiment is free.** List `/projects`, change the project on the device, list again. The
  > probe keeps the previous listing per path and reports the diff, so the device answers rather
  > than us reasoning — which is the method that has worked on this protocol every time reasoning
  > has not. `Entry.trailer` carries all four bytes for exactly this.
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

**What a project read actually returns is not a `.dnprj`** — verified 2026-07-30 by reading 131,072
bytes of `/projects/1` ourselves. There is no `PK` header. The stream opens:

```
ac 11 d3 03 02 00 05 00 09 30 30 39 37 ...        "0097", then "PRESETS"
```

Transfer's project read opens with the same `ac 11`, so it is reading the same thing: the project's
**stored payload**, not the ZIP wrapper a `.dnprj` file puts around it. That is the more useful
form — the unzip step disappears.

The stream was checked for cycling before any of this was believed: 8,192 chunks, chunk 0 occurring
exactly once and never recurring. The repeated 16-byte values are constant runs in the data, not a
loop.

### And it is uncompressed — **[verified]** byte for byte

A `.dnprj` stores its image **LZ4-compressed**: `001 PRESETS.dnprj` holds a 77,832-byte payload
that expands to 2,781,700. **The +Drive sends those 2,781,700 bytes as they are**, wrapped in the
same 31-byte header and 12-byte trailer:

```
31-byte header  +  2,781,700-byte image  +  12-byte trailer  =  2,781,743
```

The header states the length itself at offset 25 (`00 2a 72 04` = 2,781,700) and the image begins
at 31, where `BEEFBACE` sits. So `decodeProjectImage` must **not** be pointed at a +Drive read — it
reads that magic as an LZ4 block length and refuses, claiming a 3.2 GB block. `drive.ts`'s
`imageFrom` tells the two apart by the payload's own declared length rather than by where the bytes
came from.

> [!success] **The strongest check this project has.**
> The corpus holds `001 PRESETS.dnprj` — the same project the device served as slot 1. Elektron's
> export, LZ4-compressed in a ZIP and decoded by our codec, against 1,358 SysEx chunks reassembled
> by a protocol we reverse-engineered from response bytes.
>
> **2,781,700 bytes, zero differences.** Two entirely independent paths off one instrument agreeing
> exactly, which puts the transport, the sequencing, the chunk assembly and the payload framing all
> beyond doubt together. Pinned in `test/drive.test.ts`.

### What the +Drive does not send: `manifest.json`

Reconstructed rather than invented — `drive.ts`'s `manifestFor`. `FormatVersion` is `"1.0"` in every
corpus manifest; `ProductType` is `["24","30"]` on a DN1 and empty on a DN2; `Payload` is the
project's name, which is also the ZIP entry name; `FirmwareVersion` comes from the device's own
`Version` reply rather than a guess.

With it, a project read off the +Drive can be written back out as a real `.dnprj`, and "downloaded
from the device" and "opened from a file" become the same `Project` to everything above.

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
| `5` | u32be | **chunk size the reader will use** — `2048` for Transfer, `16` for us |
| `9` | u8 | `1` on Transfer's, `0` on ours. Unidentified |

> [!note] **It is a chunk size the opener *asks for*, not one the device announces.**
> This field went through two wrong readings in an hour. First it was recorded as a constant 2,048
> — three of Transfer's opens agreed, and every full chunk in those reads carried exactly 2,048
> bytes. Then our own open of `/projects/1` answered **16**, which sank that, and it was demoted to
> "unidentified, carried through".
>
> Both readings missed the same thing: **the reply echoes an argument.** Transfer asks for 2,048;
> we asked for nothing and got a 16-byte default. Confirmed by what followed — 8,192 chunks of
> **exactly 16 bytes each**, 131,072 bytes, and no end in sight. A 45 KB project at 16 bytes a
> chunk is 2,900 messages; at 2,048 it is 23.
>
> So `0x54` takes a `u32` chunk size after the path. Safe to append: the path's NUL is already
> there, so it cannot recreate the unterminated body that froze the device three times.

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

### `0x03` does not carry the loaded project — **[verified]** 2026-07-30

Asked directly from the probe, several times, **with a different project loaded in between**:
`d2 ef a8 fd` every time. Identical to what Transfer saw across 1,991 samples.

That closes it as project state and narrows what it can be. Every sample until now had been taken
while Transfer sat *idle*, so constancy proved nothing; a value tracking the loaded project would
have looked exactly that constant. Now it has been varied against and did not move.

**It is device-scoped.** The remaining check is one click: ask a Digitone II. Different bytes
confirms a device identity outright; the same bytes make it a protocol constant and something else
entirely.

### What does *not* carry the loaded project

The question — *which stored slot is the instrument playing?* — is still open, and these are ruled
out, each tested rather than reasoned about:

| Route | Result |
|---|---|
| `/projects` listing, including the four unexplained trailer bytes | **no change** across a project load |
| `0x03` | **no change** across a project load |
| `0x09` Query | `project.`, `pattern.`, `kit.`, `sound.`, `device.` namespaces all answer `none` |
| `0x10` DirList | **not implemented** — verified with a proven link |
| The dump protocol | cannot reach it: the project name and slot live in the image **header**, which no dump carries |

The native surface for this one question is close to exhausted, which is what makes capturing
Elektron Transfer's own **requests** the next step rather than the first one.

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

### `0x54` — open a file **by path, ending in the index** — SOLVED 2026-07-30

```
0x54   /projects/<index>\0   u32 chunkSize
```

**The last segment is the index, not the name.** `/projects/1` opens; `/projects/PRESETS` answers
`invalid project id`, and so does `/projects/NOPE` — *byte for byte the same error*, which is the
tell: two different names failing identically means the name was never being looked at.

| Body sent | NUL-terminated | Device |
|---|---|---|
| `/projects/1\0` | yes | **opened, handle returned** |
| `/projects/PRESETS\0` | yes | `invalid project id` |
| `/projects/NOPE\0` | yes | `invalid project id` |
| `u32 id` | no | **froze** |
| `u32 id, u32 2048, u8 1` | no | **froze** |

The index is the one a `/projects` listing gives, 1-based — `PRESETS` is 1, `MORNING_JAM` is 2.

Transfer's own capture also produced `Error: Could not resolve path` from `0x54`, which is the
*other* failure: an id that resolves, a path that does not. Two distinct errors from one message,
which is what said the argument had more structure than a bare id.

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

### `0x55` — the read is addressed by **sequence number**

```
0x55   u32 handle   u32 sequence        (sequence starts at 1)
```

**The device named the field.** Two wrong shapes, each answered informatively:

| Sent | Device |
|---|---|
| `u32 handle` alone | 4,963 consecutive **zero-length chunks**, end flag never set |
| `u32 handle, u32 length, u32 start` — elk-herd's `FileRead` order | **`Invalid sequence number`** |

We sent `handle=2, 16, 0`; it read the second field as a sequence number, found 16 where it wanted
1, and said so. So this is **not** a byte-range API. It is a numbered-chunk API, and the number is
the one the reply has been echoing all along as 1, 2, 3 … 22.

**This is where following elk-herd stopped paying.** `FileRead` on a Digitakt takes fd, length and
start; the Digitone's `0x55` takes a handle and a chunk number. The reference held for the framing,
the `+0x80` convention and the argument encoding, and diverged on the one thing we assumed from it.

`0x56` refusing with **`Reader did not complete`** names the abstraction: the device holds a
*Reader* and tracks how far through it is.

### Three refusals, three named fields

`invalid project id` · `project id out of range` · `Invalid sequence number`

Every one names its field precisely, and none of them harmed the device. **The dangerous part of
this API was `0x54`'s framing, never its arguments** — a NUL-terminated body has always been
answered, and a raw integer body has always been fatal.

> [!note] **The guard was set at "impossible" rather than "implausible".**
> The loop's only stop condition was 8,192 chunks, so a request we had wrong cost five thousand
> round trips instead of an error. It now refuses after **three consecutive empty chunks** —
> Transfer's sequences begin with exactly one, so one is normal and three is a conversation going
> nowhere. The far guard stays as a backstop.

#### And the error message was misread — which is what cost the two power cycles

`invalid project id` was recorded as the device *naming its own argument type*: "not `Invalid
path`, which is what `0x53` says — it objected to the **kind** of argument", written down as *"a
more useful error than most documentation"*.

**It says nothing of the kind.** It says the argument named no valid project id — which was exactly
true, three times running, of `/projects`, of `/projects/NOPE` and of `/projects/PRESETS` alike. The
message was accurate and unchanging while three different readings of it were tried.

> **An error names what failed, not what was wanted.** `0x53` says `Invalid path` when it cannot
> *parse* a path; `0x54` says `invalid project id` when it cannot *resolve* one. Two stages of the
> same string argument, not two argument types.

A graceful, accurate error was read as an invitation to change the argument type. The invitation
was imaginary and the device paid for it.

### What the listing shows

| Path | Entries | Notes |
|---|---|---|
| `/` **on a Digitone 1** | 2 | `projects` (128 children), `soundbanks` (8) |
| `/` **on a Digitone II** | **3** | `projects` (128), `soundbanks` (8), **`kits` (8)** |
| `/projects` | 128 | names, 1-based ids, **4,194,304 B each** |
| `/soundbanks` | 8 | `A`–`H`, **262,144 B each** |
| `/soundbanks/A` | 256 | sound names, ids, **302 B each** |

### The two families do not have the same root — confirmed 2026-08-06

A Digitone II answers `/` with **three** directories. The third is `kits`, with 8 banks — and its
absence on the Digitone 1 is not a difference in the storage API but a difference in the
instrument: **the DN1 has no kits at all.** Every listing this project took before today was from a
DN1, so the root looked like the whole story and was half of it.

That also confirms what the manual says the +Drive holds — *projects, kits and presets* — against
the wire, and settles the last thing blocking a kit manager. `/soundbanks` is the **preset**
library: 8 banks × 256 = 2,048, exactly the figure in the manual.

> **A capability absent on one device in a family is not evidence about the other.** The DN1 and
> the DN2 share a protocol and not a data model.

**Still unknown: how many kits a bank holds.** A preset bank holds 256 and a kit is 10,752 bytes
against a preset's few hundred, so the number is unlikely to be the same. One `List` of `/kits/A`
answers it.

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

---

## 7. The requests, from Elektron Transfer's own traffic — **[verified]** 2026-07-30

Captured with Wireshark + USBPcap while Transfer downloaded a project, uploaded one, deleted it, and
moved, copied and deleted sounds. Decoded with `npm run usbcap`.

### Reading

```
0x54   path\0   u32 chunkSize   u8 ?          open   → u8 ok, u32 handle, u32 chunkSize, u8 flag
0x55   u32 handle   u32 sequence               read   → chunk; sequence starts at 0
0x56   u32 handle                              close  → u8 ok, u32 handle, u32 totalLength
```

**Sequence numbers start at 0.** Transfer asks for 0, receives the 22-byte zero-length reply, then
asks for 1 and gets data. That reply was recorded here as an unidentified *metadata* message for
half a day; it is simply the answer to sequence zero.

**The close reply carries the file's total length** — 129 bytes for a sound's `.metadata`, 269 for a
sound, 21,522 for a project. That is how Transfer knows a size without reading the file.

> [!question] **`0x54`'s trailing byte is unexplained and may matter a great deal.**
> Transfer sends `01`. Our reads omitted the byte entirely.
>
> | | trailing byte | `/projects/…` returned |
> |---|---|---|
> | Transfer | `01` | **21,522 bytes** — the stored `.dnprj` payload |
> | ours | *absent* | **2,781,743 bytes** — the raw uncompressed image |
>
> Different projects, so not conclusive; but the same message returning the compressed file and the
> raw image is exactly what a format selector would look like. Worth one experiment.
>
> For DNX the **raw** form is the better one — byte-identical to the decoded image, no LZ4 step.

### Writing

```
0x57   u32 totalLength   path\0                        open   → u8 ok, u32 handle
0x58   u32 handle  u32 offset  u32 checksum  u32 totalLength  data
0x59   u32 handle  u32 1                                close  → the commit
```

Length **before** the path, which is not where anyone would put it. No trailing slash.

Arithmetic checks out both times: `0x57` declared `0x4690` = 18,064 and the `0x58` body was 18,080 =
16-byte header + 18,064; the sound declared 269 and carried 285.

> [!warning] **The checksum's algorithm is unknown, and it is the last thing standing between us
> and writing arbitrary content.**
> It is the **same field the read reply carries at offset 14**: the sound uploaded to
> `/soundbanks/C/29` declared `cb 49 92 19`, and reading that sound back reported `cb 49 92 19`.
> Two sides of one value — which identifies the field and not the function.

### The checksum — SOLVED 2026-08-06

It is **`crc32ZeroInit`**: ordinary CRC-32, ordinary polynomial `0x04C11DB7`, reflected, final
inversion — seeded with **zero** instead of all-ones.

```
/soundbanks/A/1   345 bytes
device reported   e48ff54e
crc32ZeroInit     e48ff54e
```

**The function was in this repository the whole time.** `src/project/checksum.ts` has used it for
the project payload's check field since the format was decoded. It went unrecognised because the
eleven forms tried against this field were tried as *whole algorithms* — and the one that fits
differs from `zlib.crc32` in a single parameter.

> Two fields in the same product, checksummed the same way, decoded eighteen months apart. When a
> device reuses arithmetic, look at what you have already implemented for it before looking
> outward.

Derived from a matched pair in `99_HardwareTest/API_17msg_2251.syx` — the same capture that carries
the first write. The bytes are kept as `99_HardwareTest/soundbank_A1_345B_e48ff54e.bin` and
`test/drivechecksum.test.ts` asserts against them.

**What this does not yet establish.** Matching a checksum the device *gave* us proves we reproduce
its arithmetic. It does not prove the device *accepts* a checksum we computed for bytes it has
never seen — which is the entire point of having it. That experiment writes edited content to an
empty slot; until it passes, this is verified against a capture and not against a write.

### The first write to a Digitone's +Drive — 2026-08-04, on a Digitone 1

Both halves of the experiment were run, and both answered.

**1. Writing back what was read: COMMITTED, and verified on the instrument.**

```
read   /soundbanks/A/1     345 bytes, checksum e48ff54e
write  /soundbanks/H/256   345 bytes in 1 chunk, checksum e48ff54e
commit 0x59 acknowledged
```

So `0x57`/`0x58`/`0x59` work end to end, and the destination guard — re-list the directory at the
moment of writing, refuse an occupied slot — held. **The acknowledgement was not taken as proof:**
the slot was checked on the device itself, because `0x59` says the device accepted the message and
not that the bytes are on the drive.

**2. The same write with one bit flipped in the checksum: REFUSED, in the device's own words.**

```
Error: Invalid package checksum; corrupt transfer
Link check: PASSED
```

> **The checksum is validated.** Writing *edited* content to the +Drive is blocked until the
> algorithm is fitted. Writing back bytes the device itself checksummed works today.

The link check matters as much as the error: a refusal and a silence are different findings, and
this project has already spent three days treating one as the other. The link was proven alive, so
the refusal is the device's answer rather than a message that never arrived.

#### What this changes about solving it

**The device is now an oracle.** It does not merely reject a bad checksum, it *names* the reason —
so a candidate algorithm can be tested directly, one attempt at a time, with an unambiguous yes or
no. That is a much stronger position than fitting a function to matched pairs and hoping:

- matched pairs say what the answer is for bytes we already hold
- the oracle says whether a *proposed function* is right, for bytes we choose

An algorithm search can therefore be driven from the instrument. It costs one round trip per
candidate and writes only to an empty slot.

#### The whole session, off the wire

`99_HardwareTest/API_17msg_2251.syx` carries both experiments end to end, which is what makes the
result evidence rather than a screenshot:

| # | code | what |
|---|---|---|
| 1–2 | `0xd3` | list `/soundbanks/H` — 256 entries, **0 named** |
| 3–6 | `0xd4` `0xd5` `0xd5` `0xd6` | open, two chunks, close — reading `/soundbanks/A/1` |
| 7–9 | `0xd7` `0xd8` `0xd9` | write-open, write-data, **commit acknowledged** |
| 10 | `0xd3` | list again — **256:"DIGIT-ONE" (302)** |
| 11–14 | `0xd4` `0xd5` `0xd5` `0xd6` | the same read again |
| 15–16 | `0xd7` `0xd8` | write-open, then `Invalid package checksum; corrupt transfer` |
| 17 | `0x81` | the link check — the device answers `Digitone` |

Two things fall out of that trace which neither card on screen could show.

**The write is confirmed by the device's own listing.** Line 10 is `/soundbanks/H` re-listed after
the commit, and slot 256 now carries the name `DIGIT-ONE`. That is the instrument reporting the
file, independently of the acknowledgement and of anyone reading a screen.

**The checksum is validated at `0x58`, not at `0x59`.** The refused attempt reaches write-open
(`0xd7`) and dies on write-data (`0xd8`); there is no commit response at all. So a bad checksum is
rejected before anything is provisionally stored — the failure is clean, and an algorithm search
cannot leave half-written files behind.

#### The listing's `size` is an allocation, not a file length

**Settled by the same capture, and it corrects a note in `storage.ts`.** Every empty slot in
`/soundbanks/H` listed at `size: 302`. After the write, the *occupied* slot 256 also lists at
`size: 302` — while the file itself read **345 bytes**.

So `302` is what a DN1 sound *slot* measures, not what a sound measures, and the listing reports it
whether the slot holds anything or not. Occupancy is read from the name and the permission mask, as
`Entry.occupied` already does; `size` must not be used for it.

## Kits on the +Drive — listed 2026-08-06

`/kits/1` answers **128 entries**, so the library is **8 banks × 128 = 1,024 kit slots** —
against 2,048 presets in banks of 256. A kit is a far larger object, so a smaller bank is what one
would expect.

### The device's own listing confirms our kit geometry

Every entry reads **10,752 bytes**, and `DN2_KIT.kitSize` is **10,752** — derived from the corpus,
months before anyone listed a kit bank.

> Two independent routes to the same number: differential analysis of fourteen project pairs, and
> the instrument's own directory listing. That is the strongest kind of agreement this project
> gets, and it did not require a single new byte to be decoded.

**It is the object's size, not the file's** — settled the same evening by a bank holding real kits.
All 128 entries read 10,752 whether occupied or empty:

```
1:SOLID  2:VERB  3:SINES  4:ICE  5:SLÖ  6:DARKWOODS  7:RIDERS
8:ACOUSTIC  9:ICKY  10:BROWN  11:TINY  12:CAVEDIVER  13:TENSE  14:WOOL
```

14 occupied, 114 empty, **one distinct size across all of them**. A number that does not move when
the content does is not measuring the content.

### Which suggests what a stored file actually is

The same pattern holds for presets, and gives the two halves of a hypothesis:

| | listed | read off the drive |
|---|---|---|
| DN1 preset | 302 | **345** |
| DN2 kit | 10,752 | ? |

302 is the DN1 preset's size in a project pool; 10,752 is `DN2_KIT.kitSize`. So **the listing
reports the object as the project holds it, and the stored file wraps that object in something
else** — 43 bytes of it, for a preset.

If the wrapper is a constant, a kit file is **10,795 bytes**. That is a prediction with a number in
it, and reading one kit tests it — which is worth doing before any code assumes a relationship
between a stored file and a pool or kit slot.

### Banks are addressed by number here, and by letter under `/soundbanks`

`/kits/1` works. `/soundbanks/A` and `/soundbanks/H` work. **Neither form has been tried against
the other directory**, so this is two observations rather than a rule — worth one probe before any
code assumes either.

### Occupancy reads correctly on kits

An empty slot carries the trailer `00 7e 00 01` — permissions `0x007e`, occupancy pair `00 01`. An
occupied one carries `01 01` and a name. `Entry.occupied` decodes both without change, which is one
more thing the kit directory did not need.

**A kit bank answers to both a letter and an index.** `/kits/A` and `/kits/1` each return the same
128 entries — probed deliberately, so this is a rule rather than a coincidence of two captures.
`/kits` itself answers 8 entries named `A`–`H` at 4,194,304 bytes each, the same flat allocation a
project slot gets.

### The permission mask reads occupancy on kits too

```
occupied   SOLID  10,752 B  [00 12 01 01]
empty             10,752 B  [00 7e 00 01]
```

`WRITABLE_BITS` is `0x7e & ~0x12` = `0x6c`, decoded on 2026-07-30 from sound slots. Against these:
`0x7e & 0x6c == 0x6c` so an empty kit slot is **writable**, and `0x12 & 0x6c == 0` so an occupied
one is **not**.

That is the mask working unchanged on a directory it was never derived from — and it means the
instrument marks a saved kit as protected. `writeStoredFile` refuses an occupied target anyway, so
the two agree; **replacing** a kit in place will need that permission understood rather than
assumed.

## A stored preset or kit is a container around the object — 2026-08-06

**The relationship between a file on the +Drive and the thing a project holds is: strip 43 bytes.**
That is not a wrapper anyone had to reverse-engineer; it is the container this codebase has parsed
since the project format was decoded.

```
kits/A/1     10,795 bytes on the drive   ->  parsePayload: kind 15, declares 10,752
soundbanks/A/1  345 bytes on the drive   ->  parsePayload: kind  9, declares    302
```

`BLOCK_CHAIN_START` is 31 and `TRAILER_SIZE` is 12. **31 + 12 = 43**, for both, which is why the
difference looked like a constant: it is a header and a trailer, not padding.

Both files begin `ac 11 d3 03 02 00 05 00` — the same magic a project payload carries. **They are
the same container**, holding a different object.

### The listing's size is the payload's declared length

| | listed | payload declares | file |
|---|---|---|---|
| DN1 preset | 302 | **302** | 345 |
| DN2 kit | 10,752 | **10,752** | 10,795 |

So the directory reports the object, the file adds the container, and the two numbers were never in
conflict — we were comparing a length against a length-plus-container and calling it a puzzle.

### The body is the object, uncompressed

`storedLength === computedLength` on both, and reading the body directly with the project's own
constants works:

```
body[SOUND_NAME_OFFSET]      (12) -> "DIGIT-ONE"
body[SOUND_MACHINE_OFFSET]  (244) -> FM TONE
```

No LZ4, no per-object framing. **A stored preset's body is byte-for-byte what sits in a pool slot**,
and a stored kit's body is what sits in a pattern's kit record.

> This is the whole of what the preset pool manager and the kit manager needed to know about the
> format, and none of it required new decoding. Reading a preset into a pool is `parsePayload`,
> take the body, write it to a free slot — all of which exists.

Writing the other way wraps the object in the same container. `buildPayload` already emits the
header and trailer; note that it also LZ4-compresses, which these objects are not, so exporting a
preset to the library needs the uncompressed path rather than the project one.

## The kit file corroborates the checksum, on a different object and a different device

`/kits/A/1` ends:

```
74 8c 1a e5   00 00 2a 00   aa a1 da aa
  check         10,752         footer
```

`748c1ae5` is `driveChecksum` over the payload body — **the same function derived the day before
from a 345-byte preset on a Digitone 1**, now accounting for a 10,795-byte kit on a Digitone II.

> A function fitted to one sample is a guess with good odds. The same function explaining an object
> of a different kind, from the other instrument, in a field nobody was looking at, is the sample
> that makes it a finding.

The container is internally consistent throughout: check field over the body, declared length
10,752, footer `aa a1 da aa` — the same trailer `buildPayload` writes.

### The metadata reply's two words are still unidentified

Opening a stored file answers a read chunk of length zero, whose header carries two words this
project has never named. For `/kits/A/1`:

```
40 17 3f de   44 62 67 80   00   ff ff ff ff   00 00 00 00
   word A        word B     last   checksum      length 0
```

Neither is the file's checksum, the body's checksum, or anything in the directory entry — all
checked. **One sample cannot identify a field**, and this project has already paid for reading two
samples as one 16-bit tag when they were two independent bytes.

**The cheap next step is a second metadata reply.** Read `/kits/A/2` — `VERB` — and compare. If the
words differ, they derive from the file; if they are identical, they belong to the device or the
session. Either answer halves the search.

### Moving, copying, deleting

```
0x5a   src\0  dst\0        move
0x5b   src\0  dst\0        copy
0x5c   path\0              delete
```

All three answer a single `01`. **The paths carry a trailing slash** — `/projects/55/` — which the
read and write opens do not. Two conventions in one API.

Move and copy are identical on the wire; the attribution comes from two independent sequences that
each only make sense one way, and the user confirmed the operations they performed:

- **Projects** — `0x5b` 55→56, then `0x5c` 56. A copy, then cleaning the copy up.
- **Projects** — `0x5a` 55→56, then immediately 56→55. A move, tested there and back.
- **Sounds** — the same shape on `/soundbanks/C/29` and `/30`.

### `.metadata` exists for sounds and not for projects

`0x54` on `/soundbanks/C/28/.metadata` **opens**, and its close reports 129 bytes.
`/projects/7/.metadata` answers `Error: Could not resolve path`. Transfer probes for it either way.

Unread so far. 129 bytes beside a 269-byte sound is a large proportion, and whatever is in it is
something Transfer wants before it touches the file.

---

## 8. The listing trailer, decoded — **[verified]** 2026-07-30

Four bytes per entry, carried but unexplained since the first capture. The user mentioning that
**projects and sounds can be write-protected** identified all four in one step.

| Trailer | Count in one `/projects` listing | Meaning |
|---|---|---|
| `00 7e 00 00` | 73 | **empty slot** — every one has a blank name |
| `00 7e 01 01` | 53 | occupied, writable |
| `00 12 01 01` | 2 | occupied, **write-protected** |

53 + 2 + 73 = 128. And the two `0x12` entries are **exactly** the two the device reports as
protected. A factory soundbank reads `00 12 01 01` on all 256.

So the last pair is **occupancy** and the `u16` is a **permission mask**:

```
0x7e = 0111 1110    full
0x12 = 0001 0010    protected — bits 2, 3, 5, 6 removed; 1 and 4 kept
```

A capability set, not a flag, which is why it never looked like a single bit. Which bit means what
is still unassigned.

> [!caution] **This overturns a recorded hypothesis, and the way it was wrong is the point.**
> The field was documented as *"probably the sound's tag bitmask, which `src/project/tags.ts`
> already models"*. It had **two samples** — `0x0012` on `DIGIT-ONE` and `0x007e` on
> `HH TICK_PITX_AR` — and a theory that fit both. They are a factory sound and a user sound.
>
> Two samples and a plausible story is not evidence. It is the same shape as the open reply's
> "constant 2,048" (three samples) and `0x03`'s "constant 4 bytes" (1,991 samples, all taken while
> nothing was changing).

**Consequence worth having:** a project or sound can now be reported as protected **before** a write
is attempted. Transfer only says `Slot 29 already taken` after the transfer fails; the listing knew
all along.

---

## 9. Writing, proved on hardware — 2026-07-30

**A sound was written to `/soundbanks/H/256` and appears on the instrument.** Read
`/soundbanks/A/1` (345 bytes), write those bytes back with the checksum the device reported:
`0x57` → `0x58` → `0x59`, all three acknowledged.

Confirmed twice over — by eye on the device, and by the protocol itself: a fresh listing then
reported H256 **occupied**, named `DIGIT-ONE`. The write guard refusing a second write to that slot
*is* the proof it landed.

**Sounds and projects share one container.** The sound read 345 bytes where the listing calls it
302; the difference is 43 — the same 31-byte header and 12-byte trailer that wrap a project payload.

### The checksum is enforced — and it is the last obstacle

The same write with **one bit flipped** in the checksum:

```
Invalid package checksum; corrupt transfer
```

Refused at `0x58`, so no `0x59` was sent, nothing was committed, and nothing appeared on the
instrument. That is the answer the experiment existed for:

- **Writing back what we read: available now.** The device supplies the checksum for its own bytes.
- **Writing anything new: blocked** until the algorithm is known. Which is what the expander needs
  in order to write an expanded project into a chosen slot.

### What the algorithm is not

Against **17** (data, checksum) pairs — fifteen 2,048-byte read chunks plus Transfer's two complete
uploads, 269 and 18,064 bytes:

- CRC-32 in six forms (IEEE, no xor-out, init 0, BZIP2, MPEG-2, POSIX), CRC-32C, Adler-32, a byte
  sum, positional XOR, FNV-1a — **none match**
- chained (each chunk seeding the next), cumulative, and byte-swapped variants — **none match**
- **it is not stored in the file.** The payload footer carries its own check field —
  `2d7aed58` for the sound whose transfer checksum is `cb499219` — and they are different values

So it is computed over the content by something custom.

### Next move on it

**CRC recovery.** A CRC is affine over GF(2), so polynomial, initial value and final XOR can be
solved for from a handful of known pairs rather than guessed. We hold 17, with the data for every
one, and it needs no hardware.

If that fails, the fallback is more pairs with **controlled inputs** — capturing Transfer uploading
files whose bytes we choose, where a checksum's structure is far easier to see.
