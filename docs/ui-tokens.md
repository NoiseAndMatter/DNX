# Size and colour tokens

The names are in the `:root` block of `web/dnx.css`. `toolnav.css` and `viz.css` use them too.

## Type sizes

A rule takes one of seven steps. There were 21 `rem` sizes before 2026-11-15, and many were a third of a pixel apart.

| Token | Size | It replaced |
|---|---|---|
| `--fs-xs` | .64rem | .62, .64, .66 |
| `--fs-s` | .7rem | .67, .68, .7, .72 |
| `--fs-m` | .76rem | .74, .75, .76, .78 |
| `--fs-base` | .8125rem, the body's 13px | .8, .84, 13px |
| `--fs-l` | .9rem | .88, .9, .95 |
| `--fs-xl` | 1.1rem | 1.05 |
| `--fs-xxl` | 1.3rem | 1.25, 1.35 |

An `em` size stays as it is. It follows the text that it is in.

## Control height

`--control-h` is 2rem. A button, a list and a text box in a `.bar` or in `.libfind` have this height. The small buttons of a table row keep their own size.

## Colours

A colour that two or more rules use has a name.

| Token | Use |
|---|---|
| `--btn-bg` | the face of a button |
| `--field-bg` | the face of a list or a text box |
| `--row-hover` | a table row under the pointer |
| `--status-bg` | the status line |
| `--sunk` | a surface below the page |
| `--teal-wash` | a teal surface |
| `--on-accent`, `--white` | text on an accent, and the brightest text |
| `--warn-strong`, `--danger-strong`, `--info-strong` | the signal colours of the top bar |

A colour that one rule uses stays in that rule. There are 12 of them in `dnx.css`.

The front page and the Probe have a `<style>` block of their own. Those blocks do not use the tokens yet.
