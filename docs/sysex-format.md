# Elektron Digitone SysEx — what we know

Everything on this page was verified against real files unless explicitly marked as
unconfirmed. Where a public source disagrees, the real files win and the disagreement
is noted.

## Container

```
 0        F0                SysEx start
 1..3     00 20 3C          Elektron manufacturer ID
 4        <productId>
 5        <devId>           0x00 in every dump seen so far
 6        <dumpType>
 7..8     01 01             container version
 9        <objNr>           slot number (0..127 for sounds within a bank)
10..n-6   <payload>         8-in-7 encoded
n-5..n-4  <checksum>        14-bit, MSB first
n-3..n-2  <length>          14-bit, MSB first
n-1       F7                SysEx end
```

### Product IDs

| Device | ID | Provenance |
|---|---|---|
| Digitone | `0x0D` | corroborated by libdigitone and digitools |
| Digitone II | `0x15` | **established here** by inspecting real DN2 pattern dumps; absent from every public source found |

Note this is a different ID space from Elektron's "Transfer" protocol (header byte
`0x10`), where Digitone is 20 and Digitone II is 43.

### Dump types

**All five are confirmed on both instruments, counted from real captures.** `0x53` is the same
message on each; only the object inside differs in size.

| Type | Byte | Digitone captures | Digitone II captures |
|---|---|---|---|
| Pattern+Kit | `0x50` | 516 | 1,032 |
| Pattern | `0x51` | 1 | 1 |
| Kit | `0x52` | 1 | 2 |
| Sound | `0x53` | 818 · 302-byte object | 1,008 · 359-byte object |
| ProjectSettings | `0x54` | 5 | 9 |

Four further Digitone types appear in captures and nothing has named them: `0x58`, `0x59`, `0x5a`
and `0x5b`. They are recorded as `UNNAMED_DN1_TYPES` rather than guessed at.

> **This table was wrong until 2026-09-16, and the error escaped the repository.** It credited
> `0x53` to the Digitone alone and marked four Digitone II types unconfirmed, while the corpus held
> 1,008 Digitone II Sound dumps. `inspect` therefore told anyone reading an ordinary Digitone II
> sound file that it carried an "unconfirmed product/type combination", and a reader who trusted
> that went looking for a Digitone-format variant of a file that was already correct.
>
> The lesson is not "check more carefully". It is that **a table of what has been observed cannot
> be maintained by hand**. `test/dumptypes.test.ts` now walks every capture and fails on any
> combination not written down — and it caught three the first correction had still missed.

`src/sysex/devices.ts` holds the same table in code, and `inspect` flags anything unrecognised.
Checking the type byte matters: `digitools` omits that check, so it will happily decode a pattern
dump as a sound and re-emit it with the type byte overwritten.

### Checksum and length

- **Checksum** — low 14 bits of the plain sum of the *encoded* payload bytes
  (offsets `0x0A` through `n-6`). No weighting, no XOR.
- **Length** — `(total message bytes - 10)`, i.e. from offset 7 through the end of the
  checksum, keeping only the **low 14 bits**. This wraps for large dumps and that is
  correct behaviour, not corruption: a DN2 pattern's true length of 114,108 is stored
  as 15,804.

Both are stored MSB-first as two 7-bit bytes.

### 8-in-7 payload encoding

SysEx data bytes cannot use bit 7, so seven raw bytes are packed into eight wire bytes:

```
msb: [ 0  d0.7  d1.7  d2.7  d3.7  d4.7  d5.7  d6.7 ]
        bit6  bit5  bit4  bit3  bit2  bit1  bit0
```

The order is **MSB-first**, unlike the more common Roland/Yamaha LSB-first convention.
A trailing partial group is allowed: n raw bytes encode to n+1 wire bytes.

There is **no RLE and no compression** in sound or pattern dumps, contrary to what the
Monomachine documentation describes for that older device. (aPLib LZ does appear in
Elektron *firmware* containers, but that is a separate format.)

> Correcting a published claim: libdigitone's notebook states the Digitone patch dumps
> are not packed. They are. Reading through the encoding happens to work for ASCII names
> because those bytes have bit 7 clear, but it silently corrupts any value ≥ 0x80 — and
> it produces the tell-tale "17 bytes for a 16-character name", which is really 16 bytes
> plus an interleaved MSB header byte.

## Digitone 1 — Sound dump

Verified against the two 256-sound banks in `00_Examples/01_DN1/`.

- 338-byte messages: 323 encoded payload bytes → **282 decoded**.
- All 512 sounds parse, checksum and length verify, and re-encode byte-for-byte.

Decoded layout:

| Offset | Size | Field |
|---|---|---|
| `0x00` | 4 | magic `BE EF BA CE` |
| `0x04` | 4 | version, `uint32be` = 2 |
| `0x08` | 4 | tag bitfield, 32 flags |
| `0x0C` | 16 | name, up to 15 chars then `0x00` |
| `0x1C` | 254 | synthesis parameters — not yet mapped |

Names use an extended character set, not plain ASCII: several factory presets end in the
Swedish `Å` (`0xC5`), e.g. `MODULÅR =) JA` and `DISTORTED EÅ`. Decoding these correctly is
a useful smoke test that the 8-in-7 unpacking is right.

**Dump size varies by OS version.** These banks are 338-byte messages / 282 decoded, while
the sample banks shipped with `digitools` are 361 / 302. Any parser must key off the version
field rather than hardcoding offsets, and every capture should record the OS version.

## Digitone II — Pattern+Kit dump

Verified against captures in `00_Examples/02_DN2/reference_captures/`.

- A single 114,118-byte message decoding to exactly **99,840 bytes**.
- Checksum and length verify; re-encodes byte-for-byte.

Mapped so far, by differential analysis:

| Offset | Finding |
|---|---|
| `0x04`… | Repeating 4-byte groups (`00 00 00 10` at rest). Rewrites to `03 81 03 91 …` as trigs are added, so it tracks step state. Not yet resolved. |
| `0x4A34` | Start of the **trigger slot array**: fixed 6-byte records, stride confirmed by `diff --stride`. |

Trigger record: three trigs on track 0 at steps 0/1/2 with note C4 encode as

```
00 00 3c 00 00 00 | 00 01 3c 00 00 00 | 00 02 3c 00 00 00
   ^  ^  ^
   |  |  note (0x3C = C4)
   |  step index
   track
```

The trailing three bytes are unidentified. Per the emnyeca README, `0xFF` means "inherit
from track default", explicit infinite length is `0x7F`, and finite lengths are `0x00..0x7E`.
The pattern name is reportedly stored twice ("primary" and "shadow").

## Sources and their reliability

| Source | Use it for | Caveat |
|---|---|---|
| `emnyeca/digitone-syx-toolkit` | 424 labelled DN2 pattern captures in 34 single-variable folders | No source code, no spec. The corpus is the value. |
| `emnyeca/changes` | Published source plus `docs/hardware-validation/` logs | Consumer of the above |
| `ashojaeddini/digitools` | 8-in-7 codec, tag-name tables | Dead since 2021, no tests, unsafe on non-sound dumps |
| `d-huck/libdigitone` | Sound parameter offsets | Wrong about packing — see above |
| `bsp2/libanalogrytm` | Analog Rytm pattern model as a structural template | Different device |
| `mzero/elk-herd` | Digitakt/DT2 pattern structs; versioned-struct design | No Digitone support |
| `ot-tools` (GitLab) | Architecture: binary ↔ YAML round-trip | Octatrack |

Elektron does not publish SysEx documentation for the Digitone family. The Machinedrum and
Monomachine manuals are the only first-party specs that exist, and requests to support for
Digitone documentation have been declined as recently as the Elektronauts "Decoding the
Digitone SysEx" thread.
