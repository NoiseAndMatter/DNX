# Reference material

Elektron publishes no format documentation for these devices, so everything in `docs/` was
derived from real files. The manuals are still the authority for the **user-facing** side —
parameter names, ranges, page layouts, what a control actually does — and are the thing to
check before assuming anything about a field's meaning.

## Elektron official manuals

| Device | OS | URL |
|---|---|---|
| Digitone (DN1) | 1.41 | <https://www.elektron.se/wp-content/uploads/2024/09/Digitone_User_Manual_ENG_OS1.41_231108.pdf> |
| Digitone II (DN2) | 1.00A | <https://elektron.se/wp-content/uploads/2024/10/Digitone-2-User-Manual_ENG_OS1.00A_241023.pdf> |

Local copies live in the private corpus at `00_References/`, beside `00_Examples/`. They are
not in this repository — it holds code and documentation only.

**Check the OS version before trusting a parameter list.** Working from 1.00A while the device
ran a later OS produced a whole sheet of wrong controls: WAVETONE's SYN page 2 lists `SYNC` in
1.00A and does not in 1.10D, which is what the device shows. Parameters move and disappear
between OS releases. Use the newest manual, and treat the device as final.

**The manual is not always right about ranges.** It gives `VFAD` as `-64–64`, which is 129
values and cannot fit a byte; the device offers `-64–63`, confirmed on hardware 2026-07-26.
Where the manual and the device disagree, the device wins and the disagreement gets recorded.

## Third-party guide

The Synthdawg Digitone II guidebook and cheat sheet are more exhaustive than Elektron's own
manual, and the better first stop for what a control does. They are **all rights reserved**:
consult them, never quote them, and keep their text out of this repository — cite Elektron's
manuals for anything that needs a source.

The author holds a copy; its location is recorded in the private corpus at
`00_References/README.md`, not here.

## Capture corpora

- **Matched pairs** — DN1 projects beside Elektron's own DN2 conversions of them. The backbone
  of every correspondence in `docs/`, because the DN1 side is fully decoded, so the right answer
  is known before looking at the DN2 bytes.
- **Single-variable SysEx captures** — `emnyeca/digitone-syx-toolkit`, 419 native DN2 pattern
  dumps, each isolating one user action.
- **Device-authored captures** — built to a plan in `docs/dn2-capture-plan.md` and saved from
  the hardware. These are what name fields the corpora can only locate.
