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
projects/018 DNX_CAP_01.dn2prj
soundbanks/A/001 HIDDEN TEARS.dn2snd
soundbanks/H/256 ...
kits/A/001 SOLID.dn2kit
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
| `contents` | Which kinds were read: `projects`, `soundbanks`, `kits`. |
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

## What a whole instrument is

The +Drive root holds **three** directories. `device-storage.md` recorded two, from a listing taken
before `kits` was looked for.

```
/projects            128 slots
/soundbanks/A..H     256 sounds per bank    2,048
/kits/A..H           128 kits per bank      1,024
```

Sounds and kits open the way projects do, by index under their bank, confirmed again on a Digitone
II 2026-09-07.

> **This was written as though the path form had never been tried. It had.** `device-storage.md`
> has carried a kit section since 2026-08-06, including a read of `/kits/A/1`, and a **sound write
> to `/soundbanks/H/256` was committed and verified on hardware on 2026-08-04**. The summary list
> at the top of that document said the root held two directories, and that list was read instead of
> the document.

**A whole instrument, measured on the same device:**

| | |
|---|---|
| projects | 18 of 128 |
| sounds | 1,835 of 2,048 |
| kits | 16 of 1,024 |
| total | **1,869 items, 1.7 MB, 69 seconds** |

`contents` says which kinds were read, so a reader can tell a projects-only backup from a whole one
rather than inferring it from an empty folder.

## Progress

Everything is listed before anything is read. Listing costs 17 messages against 1,869 reads, so a
denominator that is right from the first item is effectively free — and one that arrived after the
projects were done would jump from "18 of 18" to "18 of 1,869" halfway through.

The bar and the count say the same thing two ways. A bar alone cannot tell you that 1,869 items is
a lot and 18 is not; a count alone is slow to read at a glance.

## What is not in it yet

**Global device settings.** Probably not readable at all today. The instrument advertises dump types
`0x50`–`0x5e` and we name five; `0x55`–`0x5e` are unidentified, and if settings can be dumped they
are among them. See `capabilities.ts`.

## Restore, and why it is not a single button

**A full 1:1 restore wipes an instrument in one act.** It stays on the list; it is not the first
thing built. The first thing is opening a backup and taking pieces out of it deliberately.

Because a `.dnx` holds real `.dn2prj` files, the read side is already done:

```ts
const files = await readZip(dnxBytes);
const loaded = await readProjectFile(entry.file, files.get(entry.file)!);
```

`readProjectFile` takes bytes from anywhere, so a backed-up project reaches the manager, the grid
and Insights through the path that exists.

| stage | what it needs |
|---|---|
| open a `.dnx` and browse it | nothing. No device, no writes |
| load a project from it into the manager | nothing new |
| write one project to one slot | `writeProjectToDrive`, which already backs up the destination and verifies the read-back |
| write a sound or a kit to a slot | the `0x57`/`0x58`/`0x59` path, **proven on a Digitone 1 on 2026-08-04** and never run against a DN2 |

The checksum those writes are validated against is `crc32ZeroInit`, solved 2026-08-06 and already
in `packages/core/src/project/checksum.ts`. See `device-storage.md`.

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
