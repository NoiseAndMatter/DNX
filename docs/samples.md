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
| `digikitstore.ts` | digikit's converter, and digikit's own client for a build with its runtime |
| `routerecords.ts` | the bytes of the firmware's `/samples` route |
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

## The sample store

On 2026-10-30 the owner chose digikit's card store as the sample storage for every sample machine. Wavetables keep their own store. On 2026-11-12 the owner dropped the digikit runtime from our builds. The store keeps digikit's format (store v3), and our own firmware reads and writes it.

- The store is the `samples/` folder of the card store, on DN2 sectors `0x800000` to the card end (about 22 GiB). Folders are part of the paths.
- The id of a file is the SHA-256 of the whole native file. DNX computes it, and the instrument stores it.
- digikit's converter, `web/vendor/dksample.wasm`, turns a WAV into the DT2 native file: a 64-byte header, big-endian 16-bit PCM at 48 kHz, and a 16-byte zero trailer. The converter runs on the host only.

### The `/samples` route

The firmware writes the store through a `/samples` route on the Data API. The contract is the firmware's `docs/for-dnx-samples.md` (2026-11-15). `sample/routerecords.ts` holds the bytes, and `device/samplesroute.ts` holds the conversation.

| Request | Path | What it does |
|---|---|---|
| LIST | `/` | lists `samples` when the build has the route |
| READ | `/samples/info` | 96 bytes: the part size, the free space, and the state of the open upload |
| READ | `/samples/index` | the id, the length and the path of each file, at most 1,024 |
| WRITE | `/samples/<n>` | part `n` of a file |
| DELETE | `/samples/<id>/` | removes the file, or drops the open upload with that id |

- A file goes up in parts. The part size comes from `info` (524,288 bytes today). Each part is one write session: a raw container of kind `0x53`, then a 256-byte part record, then the part's bytes. One file is at most 64 MiB.
- Stock answers the commit before the firmware's code runs. So after each part DNX reads `info`. The part went in when four things are true. The handled count moved, and the result is 0. The xxHash32 is DNX's own of the part, and the upload expects the next part.
- The firmware reads each part back from the card for that xxHash32. After the last part, `index` must list the id with the path and the length sent.
- A send that stops leaves the upload open. The next send of the same file goes on from the part that `info` expects. A send of another file drops the open upload first. An open upload is not a stored file, so the drop loses no sample.
- One id is one file. The firmware refuses a second copy of a sound under another path, so DNX reads `index` first and sends nothing when the id is there.
- The firmware refuses a path that is taken. A replace deletes the old file, then sends the new one.
- `safeWriteSamplePart` in `safewrite.ts` is the only door to `/samples/<n>`. A part is not a slot, so the slot rules have nothing to check. The proof is the firmware's xxHash32.

Version 1 of the route has no read of a stored file, no empty folders, no rename and no move. Paths use ASCII 0x20 to 0x7E only.

The Library's **Samples** mode shows the store (`web/src/library/samples.ts`) as one outline with the free space (`sample/storeoutline.ts`). One read of `index` gives the whole store, so the outline and the search make no further request. `storelisting.ts` turns the rows into one folder and holds the store's path rules. A delete keeps no copy, because the route cannot read a file back. Rename, move and the pool wait on the firmware and the owner.

The Samples entry shows only when `/` lists `samples`. The page asks once when an instrument connects.

**Import.** Import WAV converts the chosen files on the host with `dksample.wasm`. Nothing is sent until Send plan.

- Each file keeps the folder that was selected when it was chosen. A second Import adds to the list, so one send can fill several folders.
- A drop goes to the folder under it, and a dropped folder keeps its subfolders (`web/src/library/droppedfiles.ts`). The store makes a sample's folders from its path. A row of the list can be dragged to another folder. The left pane holds this list until the sample pool exists.
- `importplan.ts` plans the import, with a folder for each file. It gives the path of each file and whether the file replaces a sample. It also says why DNX refuses a file: its name, a second file of that name, or a folder of that name.
- `fitProblem` in `importplan.ts` is the check that a batch fits. Today it compares the bytes with the free space. A pool budget check goes there later. The firmware puts a file in a free gap that holds it, so a batch that passes can still get result -52 (no free gap).
- `nativepcm.ts` reads the converted file back for the preview. Stereo frames are interleaved L, R. The test checks this against a file that digikit's converter wrote.
- Send plan sends the files one by one with `uploadSample`. A failure stops the batch and names the files already sent.
- DNX cannot see when the unit loads a project. The confirmation and the help tell the user not to load one during a send.

`test/samplesroute.test.ts` checks the bytes against the contract's tables. `test/samplesroutebridge.test.ts` runs the client against the firmware's route in the emulator: `docs/emulator-tests.md` gives its variables. `test/digikitstore.test.ts` still checks the converter.

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
- No device implementation of `devicestore.ts`. `samplesroute.ts` gives what it needs, and the map from DNX's xxHash64 id to the store's SHA-256 is not built.
