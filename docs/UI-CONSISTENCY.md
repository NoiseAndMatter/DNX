# Why the four tools look like four utilities

Raised by the user, 2026-08-11:

> *"Later in the development we will need to do a consistency study to try to unify all tools width
> so they look part of the same app and not disconnected utilities."*

Measured 2026-08-12, **before** deciding anything. The instruction in `ROADMAP` §10b was explicit
about that order, and it was right: the measurement changes the answer.

---

## 1. The palette is already identical

Every colour the probe declares is the same as `dnx.css`'s, exactly:

| | |
|---|---|
| variables in `dnx.css` `:root` | 15 |
| variables in the probe's `:root` | 11 |
| shared | 11 |
| **differing** | **0** |
| colours only the probe has | none |

The four extra in `dnx.css` — `--focus`, `--panel-2`, `--steel`, `--teal-dim` — are ones the probe
has no rule for, not ones it disagrees about.

**So the tools do not look different because of colour.** That matters, because colour is what
anybody would have reached for first.

## 2. They look different because of size, in amounts nobody chose

The probe re-declares **18 selectors** that `dnx.css` already defines. Ten of them disagree:

| selector | property | `dnx.css` | probe |
|---|---|---|---|
| `body` | `font` | **13px**/1.45 | **14px**/1.5 |
| `.btn` | `background` | `#232a2c` | `#232b2d` |
| `.btn` | `padding` | `.34rem .7rem` | `.3rem .7rem` |
| `.btn.primary` | `color` | `#eafffb` | `var(--teal)` |
| `.btn:disabled` | `opacity` | `.35` | `.45` |
| `.hint` | `font-size` | `.72rem` | `.8rem` |
| `.status` | `background` | `#1a1f21` | `var(--panel)` |
| `.status` | `font-size` | `.76rem` | `.78rem` |
| `.status` | `padding` | `.45rem .9rem` | `.4rem .9rem` |
| `select` | `border` | `var(--line)` | `var(--line-soft)` |
| `select` | `color` | `inherit` | `var(--fg)` |
| `select` | `max-width` | `18rem` | `16rem` |
| `select` | `padding` | `.22rem .4rem` | `.25rem .4rem` |
| `table` | `font-size` | `.78rem` | `.8rem` |
| `td`, `th` | `padding` | `.3rem .5rem` | `.22rem .5rem` |
| `th` | `font-size` | `.66rem` | `.68rem` |
| `th` | `letter-spacing` | `.07em` | `.06em` |

**Not one of these is a decision.** `#232a2c` against `#232b2d` is a colour nobody could name the
difference of; `.3rem` against `.34rem` is under half a pixel. They are what happens when the same
component is described twice, months apart, by someone reading neither copy.

The other eight shared selectors — `*`, `:root`, `[hidden]`, `.btn:hover`, `.btn.danger:hover`,
`.status.ok`/`.warn`/`.error` — agree exactly, and are pure duplication.

Two more are duplicates the exact-selector comparison misses: the probe writes `label.lbl` where
`dnx.css` writes `.lbl`, and `.btn.danger` where `dnx.css` has only `.btn.danger:hover`.

> **The size drift is the whole finding.** Three of the four chrome-bar defects fixed this week —
> the tool row's font size (§8c), its height (§10c) — were this same drift in a place people
> happened to look at. The others are still there, unlooked at.

## 3. What the probe genuinely owns

28 selectors nothing else declares, and they are the real page: `.card`, `.row`, `.crow`,
`.controls`, `.note`, `.mono`, `.num`, `.read`, `.write`, `.unknown`, `.build`, `.danger-card`.

That is a small, coherent stylesheet. It is not what makes the probe an outlier.

---

## 4. Why the probe has its own stylesheet at all

It was built first, as a self-contained diagnostic, before `dnx.css` existed. Nothing decided it
should stay that way; nothing revisited it either. The comment at the top of `toolnav.css` records
the consequence — a shared row could not live in `dnx.css` **because the probe does not link it** —
so the exception has already cost one file its natural home.

---

## 5. The decision

### 5a. The probe links `dnx.css` — recommended

It costs the probe nothing it wants. Its palette is already identical, its own 28 selectors are
unaffected, and the 18 duplicates go — taking the ten disagreements with them.

The visible change is the probe adopting a 13px body and slightly tighter tables. That *is* the
point: it is the page becoming the same size as its neighbours.

**Risk is low and bounded**, because the probe's own rules come after the link and win on order.
Worth doing in one PR with a screenshot check, not blind.

### 5b. There is no single content width, and there should not be

Three layouts exist today:

| page | body | content |
|---|---|---|
| expander, library | `.page` | flowing, **78rem centred** |
| manager | `.app` | full height, grid `1fr / 20rem` |
| probe | its own | full height, scrolling results |

The instinct is to pick one width. **Do not.** A full-height tool with its own scroll regions and a
flowing document are different shapes for good reasons: the manager's grid must fill the window
because it is a workspace, and the expander's 78rem measure exists because long explanatory text at
1920px is unreadable.

The honest unification is **two named layout modes rather than one width**:

- **`app`** — full height, full width, panels with their own scrolling. The manager, and the probe.
- **`page`** — flowing, 78rem measure, centred. The expander and the library.

Both already exist in `dnx.css` as `body.app` and `body.page`. The work is to say so, make the probe
one of them, and stop the third unnamed variant existing.

### 5c. Do not unify the status bar's position

`body.page > .status` is fixed to the viewport; the other two are in flow. That difference is
load-bearing — a flowing page needs its status pinned or it scrolls away — and it is what #170 was
about. Leave it.

---

## 6. Order

| | | why | |
|---|---|---|---|
| 1 | the probe links `dnx.css`, keeps its 28 own rules | removes ten disagreements at a stroke | **done 2026-08-12** |
| 2 | the probe adopts `body.app` | kills the third unnamed layout | **done 2026-08-12** |
| 3 | a guard: no page's `<style>` may re-declare a `dnx.css` selector | this drifted back once already | **done — budget is 0** |
| 4 | split `probe/main.ts`, still 2,156 lines | easier once its stylesheet is small | started |

## 7. What steps 1–3 actually did — 2026-08-12

The probe's `<style>` went from **19 duplicated rules to none**, and from 14px to the shared 13px.
Its own 28 selectors are untouched: `.card`, `.row`, `.crow`, `.controls`, `.note`, `.mono`,
`.num`, `.read`, `.write`, `.unknown`, `.build`, `.danger-card`.

`body.app` was almost free — the probe was already declaring `height: 100%; display: flex;
flex-direction: column`, which is `body.app` written out by hand. `html, body { height: 100% }`
went too: `dnx.css` says `html:has(body.app), body.app { height: 100% }`, which is the same rule
now that the probe *is* one.

**Measured in Firefox, not reasoned about.** The probe and the library now report the same
chrome bar to two decimal places — height **40.8**, tool row **22.2**, nav left **58.37** — and the
probe's `main` scrolls with the status bar pinned at the viewport foot, exactly as the manager's
does.

A caution about the earlier figures in this document: the "40 against 41" reading that started
this was `Math.round` on sub-pixel values, and looked more precise than it was. The two-decimal
comparison above is the one to trust.

**Still true:** there is no single content width, and there should not be. `body.app` and
`body.page` remain two named modes; the probe is now an `app` rather than a third unnamed thing.

Step 3 is the one that makes this stick. The measurement in §2 is a script
(`web/dnx.css` against each page's `<style>`) and it belongs in `test/web.test.ts` rather than in a
document nobody re-runs.
