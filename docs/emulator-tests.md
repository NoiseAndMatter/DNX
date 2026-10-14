# Running the tests that need the emulator

Status: VERIFIED, 2026-10-14. Every number below came from a run on this machine.

Thirty-one tests in this repository skip unless an emulator is configured, and for months that was
all of them. They are the only tests that put DNX's requests in front of **the firmware's own
handlers** rather than in front of our model of them. With the variables below they run, and
the whole suite goes from 32 skipped to 1 — 1,910 passing, measured on 2026-10-14.

## The variables

| | |
|---|---|
| `DNX_SYSEX_BRIDGE` | `sysex_bridge.exe`, from the digikit Rust emulator |
| `DNX_EMU_FIRMWARE` | **Stock** Digitone II 1.11, for the tests that assert stock behaviour |
| `DNX_WAVERIDER_FIRMWARE` | A **modded** image carrying the `/waverider` route |
| `DNX_ERASE_FIRMWARE` | A modded image carrying the erase capability, `0x80`. Only `erase2` and later have it |
| `DNX_EMU_STATE` | Optional. A booted snapshot, which saves about 30 s per bridge start |
| `DNX_DN2_CARD_IMAGE` | Optional. A formatted +Drive underneath, so stock directories are real |

**The two firmware variables are not interchangeable, and pointing both at the modded image fails
three tests in a way that looks like a firmware fault.** `stock has no /waverider route, and says
so` is a test about the stock build; give it the modded one and it correctly reports that the route
is there. That mistake cost a confusing run here, so it is written down rather than remembered.

On this machine, as of 2026-10-13:

```
DNX_SYSEX_BRIDGE=D:/01_Code/Z_Personal/digikit-rust/out/native/target-host/release/examples/sysex_bridge.exe
DNX_EMU_FIRMWARE=D:/01_Code/Z_Personal/dn2_firmware/00_Resources/00_Firmware/Digitone_II_OS1.11_dist/Digitone_II_OS1.11.syx
DNX_WAVERIDER_FIRMWARE=D:/01_Code/Z_Personal/dn2_firmware/00_Resources/02_Builds/waverider-syncpos2-usbprobe_DN2_1.11.syx
DNX_ERASE_FIRMWARE=D:/01_Code/Z_Personal/dn2_firmware/00_Resources/02_Builds/waverider-erase2-usbprobe_DN2_1.11.syx
```

Prefer `syncpos2` over the newer `destlist2`: syncpos2 is the build on the instrument's current
line, so a green run there is evidence about the hardware somebody might flash. A newer image that
has never been flashed is evidence about a build nobody is running.

Each bridge start boots the OS, which is about 25 s, and every test starts its own. A full emulator
run is therefore a few minutes rather than a few seconds. That is the price of testing against real
handlers and it is worth paying.

## The page can use it too

**The same variables, and `npm run web`.** The dev server offers one *Emulator* entry per
configured image beside the MIDI ports, so the Library and the Manager can be opened and used with
nothing on the desk. `src/cli/emulatorroute.ts` carries each `ApiTransport.request` across as one
POST; `web/src/emulatorsource.ts` is the page's side of it.

It exists because the UI was unusable without an instrument. With the Digitone off or mid-flash
there were no MIDI ports, so the Library could not be opened at all — not to look at a layout, not
to take a screenshot, not to run a release check that has nothing to do with the wire.

| | |
|---|---|
| Works | the +Drive API: listings, opening a stored project, the wavetable store, the pool, writes, the erase |
| Refused | the dump protocol — *Open device…*, the active project, *Write to device*. There is no MIDI peripheral to carry it, and the page says so rather than timing out |
| Absent | anything on the card. It is blank unless `DNX_DN2_CARD_IMAGE` is set, so there are no presets, kits or projects to browse |
| Never | the deployed static build. It has no server, the page's probe 404s, and no entry appears |

**One bridge at a time.** Choosing a different image closes the one running and boots the new one,
about 25 s. Two pages using the emulator share it, and one of them closing takes it away from the
other.

The picker rule is worth knowing before it looks like a bug: **one connected instrument still wins
outright**, emulator images listed or not. The picker appears so an image can be chosen
deliberately, with the instrument already selected. With no instrument and one image, that image is
taken; with no instrument and several, it refuses and asks, for the reason in the warning above.

`test/emulatorroutebridge.test.ts` runs the page's own transport module over the route against real
firmware, rather than re-sending the POST it sends.

## What this does and does not prove

`src/node/emulatorbridge.ts` injects a message into the firmware's **own router** and captures what
reaches the firmware's **own sender**. From the router down it is the code the instrument runs.

**There is no USB model and no MIDI model in the way.** The firmware session confirmed on
2026-10-13 that digikit models neither: a grep of `native/machine` for usb or midi finds nothing,
and the bridge exists to stand in for that missing layer rather than to wrap it. So a green run
here says nothing about the transport that carries the bytes on real hardware.

It is also not a +Drive. The card is blank unless given an image, and state does not persist
between runs. A green run is a reason to try something on hardware with more confidence, never a
reason to skip trying it.

## Three things the first real runs found

**The root listing has grown to six.** `waverider-syncpos2` advertises `projects`, `soundbanks`,
`kits`, `waverider`, `wavepool` and `modinfo`. The last two are routes DNX already addresses, so
what changed is that the root now says they are there. `test/waveriderroute.test.ts` pinned four
and failed, which is the tripwire working; it now pins six and finds `/waverider` by name rather
than by position, because the entry it checks had already moved once.

**A slot-sized table survives the trip.** 64 x 4,096 is 524,288 bytes, which is exactly
`SLOT_BYTES`: the largest table the format allows and the boundary an off-by-one would land on. It
writes, the listing shows it, and it reads back identical. Nobody had measured a receive-side limit
before, on either side, and the evidence for a large write was that a small one worked. There is no
limit below the maximum table size.

That one matters for the Library's importer, which can build a table that size from a dropped file.

**The pool's compare-and-swap works, and nobody had seen it.** `writePool` shipped with no
emulator test at all: its only mention in `test/` was as a forbidden name in the Library's
read-only check, and the firmware session had not tried a non-zero project slot either. So the
thing that stops two writers losing each other's work was, on both sides, what the specification
said. `test/wavepoolwritebridge.test.ts` now writes a record at project slot 7, confirms the
entries read back, and then sends a record carrying a generation that has since moved and confirms
the record is left alone.

That second half needs its control, and the first version of it did not have one. An unchanged
record is equally consistent with *refused because stale* and *refused because those bytes were
malformed*, and `wavepoolwrite.ts` says in as many words that the two cannot be told apart from
here. The test now sends the same record again with the current generation and requires it to
land, so the generation is the only difference between the attempt that was refused and the one
that was not.

It also pins the empty-slot rule from both sides: a write into a project slot with no record takes
no backup, because `refuseUnlessEmpty` has already proved there is nothing to copy, and the write
after it does take one. That rule has caught me out twice, which is why the assertion is written
as the rule rather than as the expectation.
