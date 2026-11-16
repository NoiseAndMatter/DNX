# The layout test

`test/layout.test.ts` opens each page in a browser and measures it at four window widths: 1,500, 1,110, 800 and 480 px. It is the measurement from the layout audit of 2026-11-15, kept as a test.

## How to run it

1. Build the page: `npm run build:web`.
2. Set `DNX_CHROME` to the path of `chrome.exe` or `msedge.exe`. A Chromium of version 105 or later is necessary.
3. Run `npx tsx --test test/layout.test.ts`.

Without `DNX_CHROME`, or without the built page, the test is skipped. `npm test` then shows one more skipped test.

The test starts the browser headless, with a profile folder of its own in the temporary folder. It does not use the browser that is open on the desk, and it does not ask for MIDI.

## What it checks

For each of the five pages, at each width:

| Check | It fails when |
|---|---|
| no sideways scroll | the page is wider than the window |
| each button's label is on one line | a label breaks into two lines. A pattern cell is a button with three lines, and is not counted |
| no bar takes more than three lines | the controls of a `.bar` or of the top bar wrap to four lines or more |

Each page is measured as it opens, with no project and no instrument. The test does not see a table with rows, so it does not find a fault in a row.

## No check is marked todo

Every check passes at every width. At 480 px the manager's Open group and the library's Instrument group are wider than the window, so each group wraps inside (`.bar .bargroup` in `web/dnx.css`).

If a new fault must wait, mark its check `todo` and name the fault. A `todo` check that fails does not fail the run.
