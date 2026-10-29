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

## Back up the device settings

The instrument keeps PERSONALIZE, USB CONFIG and probably MASTER TUNE in the first 256 bytes of the saved state, outside the +Drive. Only the diagnostics firmware can read them.

1. Press **Back up**.
2. DNX reads `/devslots/0`, `/1` and `/2`. If `devslots` is not there, it stops with the same message as Capture.
3. DNX saves `dn2-settings_YYYYMMDD-HHMM_<OS build>.json` in the `Backups` subfolder.
4. DNX shows the settings in a table.

The file holds the running header (`/devslots/2`) as hex, and each slot's header beside it. The table shows each option with its value and its bytes. A value that nobody measured shows as a number with "not named yet". The bytes that have no name show as numbers.

MIDI CONFIG is not in the backup. CLOCK SEND survived a power cycle on the unit, but the header did not change. Its store is not found yet.

Stock's record ends at `+0x51`. The bytes `+0x52` and `+0x53` are the PERSONALIZE toggles of the reloadconfirm and arpscale mods. Stock does not read them, and they are 0 when the mod is not installed.

DNX checks the checksum at `+0x04` and says when it does not match. The checksum is the sum of the 18 big-endian words from `+0x08` to `+0x4f`, each XORed with its number counted from 1. It does not cover `+0x50` and after. The formula matched the stored value in five real headers on 2026-10-29.

The offsets were measured on OS 1.11 (build 0059). For a file from another build, DNX says that some values can be wrong.

### Show or compare

<!-- ste-lint ignore -->
1. Press **Open…**.
2. Choose one settings file to show it, or two files to compare them.

In a comparison, a row that differs has a `≠` mark. The table also lists the other header bytes that differ, for example the checksum at `+0x04`.

### Restore

DNX does not write the settings. A slot holds the whole 12.9 MB state, and a bad slot affects the start-up. A write needs new firmware code that calls stock's own setters. To restore, open the file and set each value on the instrument by hand. The table is in menu order: SYSTEM, then PERSONALIZE.

## Releasing the instrument

The capture opens its own connection, never the page's, and closes it at the end, also after an error. DNX drops its listeners and leaves the MIDI port open for the page, as every other DNX job does. Closing the tab releases the port.

If replies to requests DNX did not send arrive during the run, the message says another application is using the port. On Windows, a port that Transfer holds cannot be opened at all, and the connection fails with "check that no other application is holding it".

## Tests

- `test/devslots.test.ts`: the block numbers, the list check, the refusal before any open, the read order, the names, and the zip.
- `test/devsettings.test.ts`: the header out of a devslots file, the settings file, the values, and the differences.
- `test/devslotsbridge.test.ts`: the route in the emulator with `DNX_DEVSLOTS_FIRMWARE`, and stock as the control. See [`emulator-tests.md`](emulator-tests.md).
