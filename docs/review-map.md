# The review map

`npm run review` draws the repository as a layered diagram and marks in red or amber what a
reviewer should look at. It is for a review where nobody reads every line: the reviewer reads the
structure instead, and drills down where the map says to.

The idea comes from an interview with Robert C. Martin on The Hangar DX podcast. The New Stack
reported it in "If we stop reading the code, what do we read?" (Ankit Jain, 2026-11-21). Martin
reviews his agents' work as a diagram with three faults in red: CRAP scores, mutation scores, and
dependencies that point the wrong way. The agent stays attached to the diagram to answer what-if
questions. The review map builds that idea on what DNX already checks.

## Run it

1. Fetch `main`, so that the map can mark what your branch changed:
   `git fetch <token URL> main:refs/remotes/origin/main`. A plain `git fetch` fails here (see the
   README).
2. Run `npm run review`. The full test suite runs once with coverage on. It takes a few minutes,
   at below-normal priority.
3. Open `out/review/index.html` in a browser.

| Option | Effect |
|---|---|
| `--base <ref>` | Marks the files that differ from this ref. The default is `origin/main`. |
| `--no-tests` | Skips the test run. The map has no CRAP scores, and it takes seconds. |
| `--lcov <file>` | Uses the coverage of an earlier run, for example `out/review/coverage.lcov`. |
| `--move old=new` | A what-if: the map is drawn as if the file were at the new path. Several pairs can follow one `--move`. |
| `--days <n>` | The window for the change counts. The default is 90 days. |

The output goes to `out/review/`, which git ignores: `index.html`, `model.json` and
`coverage.lcov`.

## Read it

Each band is a layer of [`PRINCIPLES.md`](PRINCIPLES.md), section 3. The pages are at the top and
the core is at the bottom, so an import that follows the rules points down. Each box is a folder,
which the map calls a component.

- **Select a box** to list its files and draw its arrows. Select it again to clear it.
- **Select a file** to list its functions, highest CRAP score first.
- **Select a band title** to fold the band.
- **Add a folder after `#`** in the address to open the page with that folder selected. For
  example: `index.html#packages/core/src/project`. The address follows each selection, so you can
  share it.
- **Changed only** dims every folder that the branch did not change and that is not next to one
  that it changed.
- **Every arrow** draws all the arrows. By default the map draws red arrows and the arrows of the
  selected box only.

A dot after a name means that the branch changed it. A dashed box holds a file that a what-if move
put there.

### Red

A red box has at least one of these:

- **A wrong-way import.** A file imports a layer that its own layer may not use, or core uses a
  browser global. `test/layers.test.ts` fails on these, so `main` has none. A what-if move can
  make one.
- **A CRAP score over 30.** CRAP (Change Risk Anti-Patterns, Savoia and Evans, 2007) combines
  complexity with test coverage: `c² × (1 − coverage)³ + c`. A function scores high when it is
  complex and the tests do not run it. A fully covered function scores its complexity.

**Complexity** is cyclomatic complexity: 1, plus 1 for each `if`, `?:`, loop, `case`, `catch`,
`&&`, `||` and `??`. A nested function counts as its own function. **Coverage** is the share of a
function's statement lines that ran during the test suite.

A file that the tests never load shows "not run", not 0%. Most page code is in this group, because
the pages are checked in a browser (`test/layout.test.ts`, the emulator tests and by hand), not by
unit tests. "Not run" is a fact to weigh, not a fault.

### Amber

An amber box depends on a folder that is less stable than itself. Stability is Robert C. Martin's
instability, `I = Ce / (Ca + Ce)`:

- `Ce` is the number of folders this folder uses.
- `Ca` is the number of folders that use it.

A folder near 0 has many users and few dependencies, so a change to it reaches far. It should only
depend on folders that are at least as stable. Amber is advice. It fails nothing, and a reviewer
can decide that the arrow is right.

Each box also shows its commit count: the commits that touched its files in the window. A folder
that changes often and has a low `I` is a folder where changes are expensive.

## Ask the agent

The agent is the Claude Code session. It reads `out/review/model.json`, which holds the same data
as the page. Some questions it can answer:

- "Which red functions did this branch add?"
- "Why is `core/device` amber?"
- "What if `src/node/zip.ts` moved into core?" The agent runs `npm run review -- --no-tests --move
  src/node/zip.ts=packages/core/src/archive/zip.ts` and reports the new red and amber boxes. No
  source file changes until you agree to the move.

## What it does not do

- **Mutation testing.** The article names it as the third red marker. It needs Stryker, which adds
  several dependencies and runs the suite once for each change it makes. It is left for a later
  change, limited to the files that a branch changed.
- **Prove behaviour.** The map shows structure and test reach. A green map says nothing about
  whether a byte is right on the instrument. [`PRINCIPLES.md`](PRINCIPLES.md), section 7, still
  applies.
- **Count what the browser tests cover.** Coverage comes from `node --test` only.
- **Count what a skipped test would cover.** The emulator tests skip unless their variables are
  set (see [`emulator-tests.md`](emulator-tests.md)). Without them, most device write code, for
  example `uploadSample`, shows 0% and a high CRAP score. Set the variables before
  `npm run review` to measure that code.
