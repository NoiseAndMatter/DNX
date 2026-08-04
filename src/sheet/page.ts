/**
 * The page a hardware check sheet is printed on.
 *
 * ## Why this exists
 *
 * `src/sheet/resultsform.ts` owns the *fillable* half — verdict chips, note boxes, the export
 * button and the script that keeps answers in the browser. That extraction was done once and
 * stopped, so the **page around the form** stayed written out twice, in `cli/hardwaretest.ts` and
 * `cli/trackhwtest.ts`: the same doctype, the same design tokens, the same forty lines of CSS.
 *
 * And they had drifted, exactly as two copies do:
 *
 * | | pattern sheet | track sheet |
 * |---|---|---|
 * | the tick glyph | `content:"☐ ☐"` | `content:"\2610 \2610"` |
 * | `td.num` / `th.num` | absent | present |
 * | `td.note` | 12rem, with a rule under it | 11rem, without |
 * | `.scope` | absent | present |
 *
 * None of that was decided. The two glyph spellings render the same box — the CSS escape is the
 * more robust of the two, because it survives a file served without a charset, so that is the one
 * kept. The rest is now simply present for both: **a rule for a class a sheet does not use costs
 * nothing, and a class with no rule is the bug that rendered every legend chip as an empty box.**
 *
 * ## What stays a parameter
 *
 * Two lengths, because the difference is real: the track sheet has more columns, so it needs a
 * wider measure and a wider table before the horizontal scroller is worth having. Everything else
 * is the same sheet.
 */

import { type ExportSpec, RESULTS_FORM_CSS, exportBar, resultsFormScript } from "./resultsform.js";

export interface SheetPage {
  /** The browser tab and the file it gets saved as — where a sheet is *filed*. */
  documentTitle: string;
  /** The `<h1>` — what the sheet *is*, read at the top of the page. */
  heading: string;
  /** The line under the heading. HTML: the caller escapes what needs escaping. */
  lede: string;
  /**
   * Everything between the lede and the export button. HTML.
   *
   * Trimmed on the way in, so the spacing of the emitted page does not depend on how a caller
   * happened to lay out its own template literal.
   */
  body: string;
  /** What the export button writes out. */
  spec: ExportSpec;
  /** The measure. Default suits a sheet of six columns or fewer. */
  maxWidth?: string;
  /** How wide the table gets before it scrolls sideways instead of squeezing. */
  tableMinWidth?: string;
}

/** The design tokens and layout every hardware sheet is drawn with. */
export function sheetCss(maxWidth: string, tableMinWidth: string): string {
  return `  :root { color-scheme: light dark;
    --bg:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e6ea; --accent:#6d4aff;
    --card:#f8f9fb; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#131519; --fg:#e7e9ed; --muted:#98a0ac; --line:#2a2e35; --accent:#b5a2ff;
    --card:#191c21; --bad:#ff8a80; } }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--fg); margin:0 auto; padding:2rem 1.25rem 4rem;
    max-width:${maxWidth}; font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:1.5rem; margin:0 0 .2rem; letter-spacing:-.02em; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
    margin:2.2rem 0 .6rem; }
  .lede { color:var(--muted); margin:0 0 1.2rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:.9rem 1.1rem; margin:.8rem 0; }
  .card strong { color:var(--accent); }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.88rem; min-width:${tableMinWidth}; }
  th, td { text-align:left; padding:.45rem .55rem; border-bottom:1px solid var(--line);
    vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:.72rem; text-transform:uppercase;
    letter-spacing:.05em; }
  td.n { font-weight:700; width:2rem; }
  td.num, th.num { text-align:right; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.85rem; }
  td.tick { width:3.5rem; }
  /* U+2610 BALLOT BOX as a CSS escape rather than the literal character: it renders the same and
     survives a file opened without a charset, which a sheet mailed around eventually will be. */
  td.tick::before { content:"\\2610 \\2610"; letter-spacing:.4rem; color:var(--muted); }
  td.note { width:12rem; border-bottom:1px solid var(--line); }
  tr.grp td { border-top:2px solid var(--line); }
  .nm { background:var(--card); border:1px solid var(--line); border-radius:4px;
    padding:.05rem .3rem; font-weight:600; }
  .empty { color:var(--muted); font-style:italic; }
  .hint { color:var(--muted); font-size:.8rem; margin-top:.3rem; }
  .scope { color:var(--accent); font-size:.78rem; margin-top:.2rem; }
  ul { padding-left:1.1rem; }
  li { margin:.35rem 0; }
  .warn { border-left:3px solid var(--bad); padding-left:.9rem; }
  .warn strong { color:var(--bad); }
  @media print { body { max-width:none; padding:0; } .card { break-inside:avoid; } }
${RESULTS_FORM_CSS}`;
}

/**
 * Wrap a sheet's own content in the page every sheet shares.
 *
 * The export bar and its script always come last and always in that order — the script reads the
 * fields the body wrote, so a sheet that emitted them itself could get it wrong once and nobody
 * would notice until a tester pressed the button at the end of an hour's work.
 */
export function renderSheetPage(page: SheetPage): string {
  const css = sheetCss(page.maxWidth ?? "62rem", page.tableMinWidth ?? "44rem");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.documentTitle}</title>
<style>
${css}</style>
</head>
<body>

<h1>${page.heading}</h1>
<p class="lede">${page.lede}</p>

${page.body.trim()}

${exportBar()}
${resultsFormScript(page.spec)}

</body>
</html>
`;
}
