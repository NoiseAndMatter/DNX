# Samples: the DNX back end

Written 2026-10-22. **Design and back end only.** No page uses it yet, and nothing in it sends
anything to a device.

DNX gets a sample library for the DN2's planned granular machine, Bloom. The owner's decisions of
2026-10-21 set the model:

1. Follow the Digitakt II. DNX holds the master copy, and the device holds a cache of a project's
   samples.
2. One stored format: 16-bit, 48 kHz, mono or interleaved stereo. DNX converts at import.
3. Folders, and samples linked to sounds by hash and size. A move or a rename never changes a
   link.
4. DNX plays its own copy for preview.
5. The device-side layout waits for format v1, agreed with the firmware side.
6. Wavetables keep their own store.
7. The transfer layer stays swappable, because digikit is working on a faster upload path.

The firmware-side plan is the vault note "Sample region plan" (03_dn2_firmware).

## Where the code is

Everything is in `packages/core/src/sample/`, except the two audio readers and the preview.

| File | Job |
|---|---|
| `audio/wavfile.ts`, `audio/aifffile.ts`, `audio/readaudio.ts` | Read WAV and AIFF exactly, and pick the reader from the bytes |
| `format.ts` | The stored sample, its canonical bytes, and its float view for preview |
| `xxhash64.ts` | The 64-bit content hash |
| `identity.ts` | A sample's identity: hash and size |
| `resample.ts` | Change the rate with a windowed-sinc filter |
| `convert.ts` | The import conversion |
| `importfile.ts` | Read, convert and identify one file |
| `library.ts` | Objects, the catalog of folders and names, and project uses |
| `pool.ts` | A project's sample memory, with the DT2's allocation rule |
| `transfer.ts` | What a transfer would send |
| `devicestore.ts` | The device's store, as an interface only |
| `web/src/samplepreview.ts` | Play a stored sample in the browser |
| `digikitstore.ts` | digikit's card store, through digikit's own client |
| `../vendor/digikit/` | digikit's client and converter, copied unchanged |

The WAV reader moved from `waverider/` to `audio/` when the sample importer became its second
caller. It throws `AudioError` now, not `WaveriderError`.

## Identity

**A sample's identity is the xxHash64 of its canonical bytes, plus their size.** The canonical
bytes are the interleaved samples as little-endian `int16`, and nothing else. The hash's seed is
the channel count. Without the seed, four mono frames and two stereo frames of the same points
would share one identity. A DT2 sample file carries a mono/stereo flag in its header, so
Elektron's hash also sees the channel count.

The identity does not depend on the file name, the folder, the source file or the device's
layout. Elektron links samples the same way: the DN2's `.metadata` template has
`"sample_references":[{"hash":…,"size":…}]`.

Why 64 bits: with 10,000 samples, a 32-bit hash collides with a chance of about 1 %. The hash is
checked against five published vectors and against xxhash-wasm 1.1.0 at 18 lengths. It runs at
about 16 MiB in 0.44 s here, so a 100 MB sample takes about 3 s.

**Status: proposed.** The hash and the canonical bytes are DNX's choice for format v1, and the
firmware side has not agreed them yet.

## Import conversion

The steps, in order:

1. **Channels.** Mono and stereo are kept. Mono on request averages the channels. More than two
   channels are refused unless mono is asked for.
2. **Rate.** Anything not at 48 kHz is resampled. The filter is a sinc with 24 zero crossings
   under a Kaiser window (beta 9), with its cutoff at 0.97 of the lower Nyquist frequency.
3. **Rumble high-pass, optional.** A 2nd-order Butterworth, run forward and then backward, so
   it adds no phase shift. It is -3 dB at the frequency asked for and falls at 24 dB an octave.
4. **Normalise, optional.** The peak goes to 0.98 of full scale.
5. **16 bits.** TPDF dither of one LSB either way, then rounding and clipping.

Two rules keep the identity stable:

- **A source already at 16 bits and 48 kHz, with no step asked for, is copied exactly.** No
  dither is added. The check reads the values, not the file's label.
- **The dither is seeded.** The same file with the same options gives the same bytes, and so
  the same identity. A re-import is a duplicate, not a new sample.

The Python reference is `dnfw/bloom/sample.py` in dn2_firmware. It uses FFT resampling over the
whole file and applies the high-pass on the FFT bins, at 12 dB an octave. DNX uses a time-domain
filter instead, because one FFT of a 10-minute stereo file needs 29 million points.

The tests measure each step against synthesised signals. They check a tone's level and
frequency, and a 30 kHz tone that must not fold to 18 kHz. They also check the high-pass at 5, 20
and 1,000 Hz, a DC offset, and the mean of a dithered quarter-LSB constant.

## The library

The library holds three things:

1. **Objects.** One for each identity, with its channel count and frame count. The bytes are
   not in the library. The caller stores them by identity.
2. **The catalog.** Folders as paths (`/drums/kicks`), and entries that give an object a name in
   a folder. One object can have several entries. A move or a rename edits the catalog only.
3. **Uses.** Which projects use which object. `deleteObject` refuses while a project uses the
   object, and names the projects. A forced delete reports which projects it breaks.

The library saves to JSON (`kind: "dnx-sample-library"`, version 1). The reader checks every
rule again, so a damaged file throws.

## Sample memory

A sample machine plays from the DSP's DDR, so a project's samples load into a pool. `pool.ts`
follows the DT2's allocator, which the firmware side read statically in DT2 1.16:

- An allocation is the length plus 16 bytes, rounded up to 8 KiB.
- No sample loads twice.
- A load takes the first freed region that is big enough, or else grows the pool at its end.

`planPool` sums a project's allocations and says whether they fit. `requireFits` refuses a plan
past the budget. `SamplePool` models loads and unloads in sequence, including fragmentation.

The DN2 budget is **an estimate**: about 180.5 MiB, because Waverider reserves 258.5 MiB of the
DDR for table levels today. Nobody has measured it on the unit. The DT2 has 400 MiB.

Which length the DT2 rounds, the samples alone or a header with them, is not traced. DNX uses
the stored samples' length.

## Transfer plan

`planTransfer` compares the samples a project needs with the samples the device holds, by
identity. It lists what to send, what is already there, and an estimate of the time. The rate is
the Data API's measured 350 KB/s unless the caller passes another. The estimate counts sample
bytes only.

`devicestore.ts` is an interface with three methods: `holdings`, `put` and `remove`. Nothing
implements it yet. The implementation follows format v1 and the transport choice.

## digikit's card store

On 2026-10-30 the owner chose digikit's card store as the sample storage for every sample machine. Wavetables keep their own store.

- The store is the `samples/` folder of digikit's store, on DN2 sectors `0x800000` to the card end (about 22 GiB). Folders are part of the paths.
- Only digikit's runtime writes the store. So an upload needs the digikit runtime in the image. DNX does not keep a second client: `vendor/digikit/` is digikit's own client at commit `11ad79ee`, and its `README.md` says how to update it.
- `digikitstore.ts` adds a transport over DNX's `SysexPort`. The transport passes only digikit messages (`F0 7D 64 6B`), so traffic for the Elektron API cannot reach the session.
- digikit's converter, `web/vendor/dksample.wasm`, turns a WAV into the DT2 native file: a 64-byte header, big-endian 16-bit PCM at 48 kHz, and a 16-byte zero trailer.
- An upload is proven by VERIFY. The runtime reads the file again from the card and sends its sha256, and DNX compares it with the sha256 of the bytes sent. LIST then gives the path, the size and the sha256. LIST does not give the first sector.

What the protocol does and does not do:

- It uploads, lists, deletes, makes folders, reports the free space and verifies.
- It has no rename and no move. A move is a new upload and a delete.
- It reads at most 768 bytes per request. DNX has no download yet.
- On the unit on 2026-10-29, uploads ran at about 216 KB/s. A minute of mono audio takes about 27 s.
- The runtime puts a file in the first gap that holds it. A file larger than the largest gap is refused, even when the total free space is larger.
- An upload while the unit loads a sample makes that load fail. It does not damage the store. Do not upload while the unit loads a project.

The store holds the sha256 of each file. A link from a sound by sha256 would survive a move. That is not agreed with digikit yet: its sampler design binds by path. DNX's own identity (above) is xxHash64, not sha256.

The test in `test/digikitstore.test.ts` checks the transport and the converter. Only digikit's runtime can answer the protocol, so `scripts/digikit-emu-store.mjs` runs the store path against digikit's DN2 emulator.

## Open questions for format v1

These need an answer from the firmware side, and the owner, before DNX writes a sample:

1. **The hash.** xxHash64 with the channel count as seed, over little-endian `int16`, is DNX's
   proposal. Does the firmware agree, or does ekFS bring its own hash?
2. **The byte order on the device.** DNX hashes a canonical order, so the device can store
   either. The device-side writer then needs to know which order to use.
3. **The file layout on the device.** A DT2 sample file has a 64-byte header with a mono/stereo
   flag and the rate, then 16-bit samples, then a 16-byte trailer. That comes from third-party
   research. Does format v1 copy it?
4. **What the DT2 pool rounds.** The samples, or the whole file.
5. **The real DN2 budget.** 180.5 MiB is derived from Waverider's reservation. A measurement on
   the unit would settle it.
6. **The capability keys.** `sample_file.sample_rates` and `sample_file.mono_support` were never
   asked. A read-only query sweep on the DN2 under 1.11 waits for the owner's go.
7. **Limits.** The largest sample, and the most objects and folders, which size the metadata.

## Not built yet

- No page uses the library, the import or the preview.
- Nothing stores the master copy's bytes. The DNX folder is the likely place.
- No project format holds a sample list, because the DN2 has no sample machine yet.
- No device implementation of `devicestore.ts`. `digikitstore.ts` does not implement it yet.
