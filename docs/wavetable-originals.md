# Prim. and Harm.

Some Waverider builds have no built-in tables. These builds set capability bit `0x100` (`poolOnly`) in `/modinfo`. `TBL` item 0 is then silence, and every other value is a pool table. The firmware does not write the +Drive, so DNX offers to install the two original tables.

## The files

`web/vendor/tables/` holds the files. They come from `dn2_firmware/00_Resources/12_WaveriderOriginalTables`, which has the same AGPL-3.0-or-later licence as DNX.

| Store name | File | sha256 |
|---|---|---|
| `Prim.` | `Prim.wav` | `b406f635226ecb277516f488ef2ced3b7329cb20d99606b69ac38e1da052cc2b` |
| `Harm.` | `Harm.wav` | `e1d2739aec3e49414924670a35dfe4c1d3c133ad84ca781531a7f51d3d50e93b` |

Each file is mono, 16-bit, 48 kHz, with 16 frames of 512 points. The tables are formulas in the firmware's code, with no Elektron data. `originalTablePending` copies the PCM to the table and does not normalise it.

## Install

The **Install** control shows only when the instrument reports `poolOnly` and the store listing does not hold one of the names. DNX compares names, not contents. The tables go to the lowest free store slots, through the same write as an import, after one question.

## An older project

Saved `TBL` values do not change on load, and the two builds read them differently:

| Coarse value | Build with built-in tables | `poolOnly` build |
|---|---|---|
| 0 | Prim. | no table |
| 1 | Harm. | pool index 0 |
| `c >= 2` | pool index `c - 2` | pool index `c - 1` |

**Keep old TBL values** puts Harm. at pool index 0 and moves each entry up one. Each value except 0 then plays the table it played before. A sound on value 0 stays silent, because only a rewrite of the project's sounds and locks could change it. The new sound default is also 0.

A pool has no marker that says which build it was made on. On a project made on a `poolOnly` build, the shift moves each sound to a different table. So the control runs only on request, after a question. It refuses when Harm. is already at index 0, which stops a second press, and when pool slot 128 holds a table.

The firmware session confirmed this numbering on 2026-11-03. It also applies to parameter locks.
