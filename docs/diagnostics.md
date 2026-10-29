# The diagnostics capture

DNX can read a diagnostics build's `/devslots` files into one zip. The firmware side compares the zip with a clean unit's files. The control is hidden, and it reads only.

The route is `dn2_firmware/docs/for-dnx-devslots.md` rev 2. Released and stock builds do not have it.

## Open it

1. Flash the diagnostics firmware, for example `devslotsfull1-wr-layermidi-arpmodes-lfowaves-lfo4-bootscreen_DN2_1.11.syx`.
2. Close Elektron Transfer and Overbridge.
3. Open the manager or the library with `#diagnostics` at the end of the address, for example `manager.html#diagnostics`.
4. DNX opens Settings. The Diagnostics group is under The instrument.

The probe page does not show the group. The probe holds the MIDI ports itself, and it reads these paths by hand.

## Capture the saved state

Press **Capture**. DNX does these steps:

1. It lists `/`. If `devslots` is not there, it stops with "This needs the diagnostics firmware. Flash it first." It opens no file.
2. It reads `/modinfo/0`, then `/devslots/0` to `/devslots/5`.
3. It saves `dn2-diagnostics_YYYYMMDD-HHMM_<image id>.zip` in the `Probe` subfolder of the DNX folder. Without a DNX folder, the browser downloads the zip.

Each CRC file (`/devslots/3` to `/5`) took 3.2 to 4.1 s to open on the unit on 2026-10-29. The other files take less than 0.1 s each. Each request has a 15 s limit.

## Read blocks

Type the block numbers the firmware side sends, for example `1000, 1256, 1512`. Then press **Read blocks**. A block number is `1000 + source x 256 + block`, with source 0 (slot `0x40000`), 1 (slot `0x48000`) or 2 (RAM), and block 0 to 196. DNX refuses the whole list before it sends anything if one number is not a block, or if there are more than 16. Each block took about 0.3 s on the unit.

The zip is `dn2-diagnostics-blocks_YYYYMMDD-HHMM_<image id>.zip`.

## What the zip holds

- Each file as the unit sent it, in the transfer container: a 31-byte header, the body, and a 12-byte trailer. DNX reads without the form byte, as the probe page does, so the files match the probe's files byte for byte.
- `manifest.json`: the DNX version, the time, the mode, and the instrument's name and OS version. It also holds the build tag, image id, OS and commit from `/modinfo`. For each file it holds the path, entry name, size, SHA-256, read time in ms, and whether the close was confirmed.

The image id is `unknown` in the name when `/modinfo` does not parse, for example on a website build with an unfilled record. The manifest then says why, and the raw record is still in the zip.

The zip holds no project, sound, kit or name from the +Drive. The slots contain the working project, but only a block read reaches it, and only the blocks somebody types.

## Releasing the instrument

The capture opens its own connection, never the page's, and closes it at the end, also after an error. DNX drops its listeners and leaves the MIDI port open for the page, as every other DNX job does. Closing the tab releases the port.

If replies to requests DNX did not send arrive during the run, the message says another application is using the port. On Windows, a port that Transfer holds cannot be opened at all, and the connection fails with "check that no other application is holding it".

## Tests

- `test/devslots.test.ts`: the block numbers, the list check, the refusal before any open, the read order, the names, and the zip.
- `test/devslotsbridge.test.ts`: the route in the emulator with `DNX_DEVSLOTS_FIRMWARE`, and stock as the control. See [`emulator-tests.md`](emulator-tests.md).
