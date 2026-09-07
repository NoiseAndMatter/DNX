# The `.dnx` backup format

A whole-instrument backup, written by DNX and readable by anything.

## It is a zip

Rename a `.dnx` to `.zip` and it opens in Windows Explorer, in Finder, in any archiver. Every file
inside is an ordinary Elektron file that Elektron Transfer will accept.

That is the point. **A backup format only its author can read is a way of losing music slowly.**
This one degrades into a folder of `.dn2prj` files the moment somebody needs it to, including in
ten years when DNX is gone.

```
manifest.json
projects/001 PRESETS.dn2prj
projects/002 COREVAULT.dn2prj
projects/018 DNX_CAP_01.dn2prj
```

## `manifest.json`

```json
{
  "dnx": 1,
  "taken": "2026-09-07T04:21:09.000Z",
  "device": { "name": "Elektron Digitone II", "productId": 12, "firmwareVersion": "1.10E" },
  "contents": ["projects"],
  "form": "stored",
  "entries": [
    {
      "file": "projects/001 PRESETS.dn2prj",
      "source": "/projects/1",
      "slot": 1,
      "name": "PRESETS",
      "bytes": 91234
    }
  ]
}
```

| field | why it is there |
|---|---|
| `dnx` | Format version. Bumped when a reader would get it wrong, never for a new field. |
| `taken` | ISO 8601. Also the sortable part of the file name. |
| `device.name`, `device.productId` | Which instrument. A restore refuses a backup from another model. |
| `device.firmwareVersion` | **Absent when the instrument did not answer.** See below. |
| `contents` | Which kinds of thing were read. |
| `form` | Always `stored`. See below. |
| `entries[].slot` | **The reason the manifest exists.** |
| `entries[].source` | The +Drive path it came from, which is what a restore writes back to. |

## The manifest is what makes a restore possible

A `.dn2prj` does not know which slot it came from. The +Drive addresses projects **by index**:
`/projects/1` opens, and `/projects/PRESETS` is answered `invalid project id`. So a folder of files
alone cannot be put back, however well named.

`slot` and `source` carry that. Everything else in the manifest exists so a restore can tell you
what it is about to overwrite before it does.

## `form` is always `stored`, and a raw backup is not a backup

The +Drive answers one path two ways. Ask with a trailing `0x01` and you get the **stored** payload;
omit the byte and you get the **expanded image**.

| | a DN2 project |
|---|---|
| stored | ~90 KB, about 40 chunks |
| raw | 12,889,647 bytes, 6,294 chunks |

**Only the stored form can be written back.** `refuseRawForm` rejects the other at the write, so a
raw backup is unrestorable by the very tool that made it.

> This is recorded rather than assumed. On 2026-08-15 the first overwrite run on hardware backed up
> a slot in raw form: 12.9 MB, no container header, saved under a `.dn2prj` name it had no right to,
> and refused by the writer. The manifest carries `form` so a restore can say so before it starts
> rather than failing at the last step of a long operation.

It is also the difference between a backup that takes minutes and one that takes an hour.

## Empty slots are skipped

A +Drive has **128 project slots**. The instrument this was built against uses 18. Reading all 128
would spend most of an hour on slots holding nothing, so the listing is filtered on the name, which
is what a listing gives for an unoccupied slot.

Measured on a Digitone II, 2026-09-07: 18 occupied slots of 128.

## A slot that fails is reported, never dropped

`backupDevice` returns the entries it read **and** the slots it could not. A backup missing one
project is worth having; a backup that quietly lost one is not, and nothing downstream can tell
those apart unless the reader says which happened.

## Firmware is absent rather than invented

`ConnectedDevice.firmwareVersion` is `undefined` when the instrument did not answer, and the
manifest omits the field rather than writing a guess. A restore that refuses on a firmware mismatch
has to be able to tell **different** from **unknown**, and a manifest claiming a version nobody read
is the plausible-looking wrong field this project keeps paying for.

## What is not in it yet

**Soundbanks.** Eight banks of 256 sounds each. `/soundbanks/A` lists them, but opening one sound
needs a path form nobody has tested, and `0x54` is the message that froze a Digitone 1 three times
(`device-storage.md`). One experiment settles it.

`contents` is a list for exactly this reason: a backup with no `soundbanks` entry is one that never
read them, and a reader inferring that from an empty folder could not tell it apart from an
instrument with no sounds.

**Global device settings.** Probably not readable at all today. The instrument advertises dump types
`0x50`–`0x5e` and we name five; `0x55`–`0x5e` are unidentified, and if settings can be dumped they
are among them. See `capabilities.ts`.

## Restore

Not built. Backup first, on the reasoning that a backup you have never restored is worth more than a
restore you have never backed up for.

When it lands it is a **write** of every entry in the manifest to the slot it names, which means it
goes through the write-enable switch and `safeWriteFile` like every other write here: each
destination read back and saved before it is overwritten.

## Where the code is

| | |
|---|---|
| `web/src/dnxfile.ts` | the format: manifest, naming, packing. No instrument, so a test can read it |
| `web/src/backup.ts` | the device read |
| `web/src/settings.ts` | the row that starts it |
| `test/backup.test.ts` | |

The split exists because `backup.ts` reaches Web MIDI through `devicesource.ts`, and importing that
from a test drags `MIDIInputMap` into the Node typecheck. `driveslot.ts` was split from
`driveproject.ts` for the same reason.
