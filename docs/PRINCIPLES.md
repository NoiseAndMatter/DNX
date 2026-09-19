# Architecture principles

**These are binding on every change**, whether it is a new feature, a fix or a refactor. A change
that cannot follow one of them says so in its MR and explains why; silently breaking one is not an
option. They exist because each was learned by paying for it — the "found by" notes are what it
cost.

## 1. One job per module

A module has a subject and the reader can name it in a sentence without the word "and". Parsing,
deciding and rendering are three subjects.

**Size is a symptom, not the rule.** A 600-line translation table is one job; a 200-line file that
reads bytes, applies policy and writes HTML is three. Ask what would have to change for this file to
change: if the answer has an "or" in it, split it.

**Found by:** the status bar lived as four lines in `dom.ts` alongside `$` and `escapeHtml`. Filed
as a helper, it had no owner for the `status` class its whole appearance hangs off, so a caller was
able to pass an argument that erased it. It is now `web/src/statusbar.ts`, which owns the markup
contract, the class and the one way to write to it.

### Ask before writing, not before merging

**The question comes before the first line, not at the merge.** Before adding a function, an
interface, a type or an enum: does it belong in the file you have open, or in one of its own? A
lightbox written inside a help view is an image viewer living in a file about documentation; a set
of form-row builders written inside a settings sheet is a widget library filed under one caller.

Both of those happened on 2026-09-07, in one afternoon, and both were caught by the person paying
for the work rather than by the person writing it. **Nobody should have to remind you of this.**

Cheap test, and it takes a second: say what the new thing is, out loud, without naming the file it
is going into. If that sentence does not contain the file's subject, it belongs somewhere else.

## 2. Anything a second caller needs moves up

The moment a second page, CLI or module needs something, it leaves the folder it was written in and
goes to the shared level. Not "later", not "when there is time".

**Found by:** the slot grid stayed in `manager/`, so the expander grew its own typed slot box
instead of using it — two implementations of one gesture, and only one of them had drag feedback.

## 3. The layering, and it goes one way

```
src/                pure and platform-free. No DOM, no WebMIDI, no fs.
src/cli/            the only place in src/ that touches the filesystem or argv.
web/src/*.ts        shared browser code: dom, statusbar, grid, devicesource, project, render.
web/src/<page>/     one page and nothing else.
test/               one file per subject.
```

`src/` never imports from `web/`. A page never imports another page's folder. Anything crossing
those lines is a design error, not a shortcut.

**Why it holds here:** `src/` is the part that has been proven byte-for-byte against Elektron's own
output. Keeping it free of the browser is what lets a CLI, a test and a page all exercise the same
proven code.

## 4. Reuse means the shared thing, not a copy of it

Before writing a function, look for it. Two near-identical implementations are worse than one
imperfect one: they drift, and the second set of bugs is invisible because the first one is fixed.

When something is extracted, the old copies go — an extraction that leaves the original in place has
added a module and solved nothing.

## 5. Anything reused says what it assumes

A module used by two callers documents what it needs from them. If it assumes a layout, a class, a
parent element or a call order, that assumption is written down in the module, not learned by the
next caller breaking.

**Found by:** `.status` assumed it was the last child of a viewport-height flex column. Reused on a
flowing page it became an unstyled line at the bottom of a long document. Twice over: the expander
was also given the manager's app shell while using markup that shell had never styled, and the
layout came apart at the first resize.

## 6. A default that gets smarter needs a caller sweep

When a function starts doing something better by default, every caller passing the corresponding
override keeps the old behaviour. Those callers are precisely the ones written before the
improvement.

**Found by:** `planPatternMerge` learned to scope its plan to the patterns being merged. The page
passed `plan: state.plan` — the whole-project plan — so the fix was inert everywhere the user could
see it, while the unit tests were green.

## 7. Verify through the surface the user touches

A unit test proving the unit is not evidence the feature works. Load the page, run the CLI, read the
file on `main`. Tests that pass while the product is broken have happened here more than once.

**Found by:** the page test suite was green while the expander threw at module load and attached no
listeners at all — the tests checked that ids exist, not that the page runs.

## 8. Never invent data

If a value cannot be derived or captured, it is reported, not guessed. Dangling references are
described and left alone. This is the difference between a tool and a corruption source: everything
written here ends up on hardware that somebody's music lives on.

## 9. Report volume is a design decision

Diagnostics are not findings. When output can grow with the data — conversion notes, warnings, per
field messages — it is scoped to what the user asked about, folded by message with counts, and put
somewhere bounded. A panel that can grow without bound will, and it will take the page with it.

## 10. Vocabulary follows the hardware

A **track** is a sequence plus a preset, because that is what the device shows. Positions are named
as the device names them — `A1`, `B12`, `H16` — through `src/project/naming.ts`, never as raw indices
in anything a person reads. One name per concept, across CLI, page and docs.

---

## 11. Documentation is written for the people who come after

Every `.md` and every module comment here has three readers, and the third one is the reason the
first two are worth the effort:

1. **Whoever picks this up cold**, including the author in six months. Facts, with the evidence and
   the date attached. A claim with no source becomes a claim nobody can check.
2. **Whoever builds the next thing.** What is settled, what is open, what was tried and refused, and
   what a number was measured against. A roadmap says what to build; the format records say what is
   safe to build on.
3. **Whoever joins.** DNX is going public, and a stranger reading this repository should be able to
   work out **how decisions get made here** without being told: nothing is claimed that was not
   measured, a status word means what it says, a summary that disagrees with the section under it is
   a bug, and a fix without the failure that caused it is half the value.

That third reader is why the "found by" notes exist and why a comment explains a decision rather
than restating the code. **A repository that only says what the code does teaches nobody how to add
to it.**

Some of this record is for the archive rather than the public repository — working notes, a corpus
of somebody's music, three months of commit messages written for an audience of one. Deciding what
is gated is a separate act from writing it. **Write it fully, then decide what ships.**

## Applying these to a change

Before opening an MR:

- **Before you wrote it**: did you ask whether each new function, interface or type belonged in the
  file you had open?
- Can each file you touched be described without an "and"?
- Did you copy anything that already exists? Did the copy you replaced actually get deleted?
- Does anything in `src/` now know about a browser?
- Did you improve a default without checking who overrides it?
- Did you run the page or the CLI, not only the tests?
- Can any output you added grow without bound?

`docs/ROADMAP.md` tracks what to build. This file governs how it is built, and why it is
written down the way it is.
