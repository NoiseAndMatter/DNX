# Running the tests that need the emulator

Status: VERIFIED, 2026-10-13. Every number below came from a run on this machine.

Seventeen tests in this repository skip unless an emulator is configured, and for months that was
all of them. They are the only tests that put DNX's requests in front of **the firmware's own
handlers** rather than in front of our model of them. With the three variables below they run, and
the whole suite goes from 17 skipped to 1.

## The variables

| | |
|---|---|
| `DNX_SYSEX_BRIDGE` | `sysex_bridge.exe`, from the digikit Rust emulator |
| `DNX_EMU_FIRMWARE` | **Stock** Digitone II 1.11, for the tests that assert stock behaviour |
| `DNX_WAVERIDER_FIRMWARE` | A **modded** image carrying the `/waverider` route |
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
```

Prefer `syncpos2` over the newer `destlist2`: syncpos2 is the build on the instrument's current
line, so a green run there is evidence about the hardware somebody might flash. A newer image that
has never been flashed is evidence about a build nobody is running.

Each bridge start boots the OS, which is about 25 s, and every test starts its own. A full emulator
run is therefore a few minutes rather than a few seconds. That is the price of testing against real
handlers and it is worth paying.

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

## Two things the first real run found

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
