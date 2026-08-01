/**
 * Rendering concern: turn the sheet model into a self-contained HTML page.
 *
 * No file access, no format knowledge — a pure function of the model, so the wording and
 * layout can change without touching anything that reads bytes.
 */

import { patternName } from "./naming.js";
import { escapeHtml } from "./html.js";
import type { PatternSheet } from "./collect.js";

export interface SheetMeta {
  /** Project name as written in the file — its last four digits are the build time. */
  projectName: string;
  sourceFile: string;
  outputFile: string;
  /** Free-form notes to show at the top: open questions, what changed in this build. */
  callouts?: { title: string; body: string }[];
}

const STYLE = `
:root { color-scheme: light dark;
  --bg:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e6ea; --accent:#6d4aff;
  --expanded:#f4f0ff; --card:#f8f9fb; --warn:#fff8e6; --warnline:#e0a800; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#131519; --fg:#e7e9ed; --muted:#98a0ac; --line:#2a2e35; --accent:#b5a2ff;
  --expanded:#211c33; --card:#191c21; --warn:#2a2312; --warnline:#c99a12; } }
:root[data-theme="dark"] {
  --bg:#131519; --fg:#e7e9ed; --muted:#98a0ac; --line:#2a2e35; --accent:#b5a2ff;
  --expanded:#211c33; --card:#191c21; --warn:#2a2312; --warnline:#c99a12; }
:root[data-theme="light"] {
  --bg:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e6ea; --accent:#6d4aff;
  --expanded:#f4f0ff; --card:#f8f9fb; --warn:#fff8e6; --warnline:#e0a800; }
body { background:var(--bg); color:var(--fg); margin:0 auto; padding:2rem 1.25rem 5rem; max-width:64rem;
  font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size:1.65rem; margin:0 0 .3rem; letter-spacing:-.02em; }
h2 { font-size:1.05rem; margin:2.5rem 0 .8rem; padding-bottom:.35rem; border-bottom:2px solid var(--accent);
  text-transform:uppercase; letter-spacing:.06em; }
h3 { font-size:1.05rem; margin:0; }
.lede { color:var(--muted); margin:0 0 1.5rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:.85rem 1.1rem; margin:0 0 .9rem; }
.card.warn { background:var(--warn); border-left:4px solid var(--warnline); }
.card h4 { margin:0 0 .35rem; font-size:.95rem; }
.card p { margin:.35rem 0 0; }
.meta { color:var(--muted); font-size:.82rem; margin:.15rem 0 .55rem; }
section.pattern { margin:0 0 1.9rem; break-inside:avoid; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.85rem; min-width:44rem; }
th,td { text-align:left; padding:.38rem .55rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; }
td.t { font-weight:700; white-space:nowrap; }
tr.expanded { background:var(--expanded); }
.mono { font:12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
details { margin-top:.55rem; } summary { cursor:pointer; color:var(--muted); font-size:.8rem; }
code { font:12px ui-monospace, SFMono-Regular, Consolas, monospace; background:var(--card);
  border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; }
ol li, ul li { margin:.32rem 0; }
@media print { body { max-width:none; } .card.warn { border-left-color:#000; } }
`;

function renderPattern(sheet: PatternSheet): string {
  const rows = sheet.tracks
    .map(
      (row) => `<tr class="${row.expanded ? "expanded" : ""}">
      <td class="t">T${row.track}</td>
      <td>${escapeHtml(row.sound)}</td>
      <td>${row.length}</td>
      <td>${row.level}</td>
      <td>${row.trigCount}</td>
      <td class="mono">${escapeHtml(row.steps)}</td>
      <td class="mono">${row.notes.map(escapeHtml).join("<br>") || "—"}</td>
    </tr>`,
    )
    .join("\n    ");

  const source = sheet.source
    .map(
      (row) => `<tr><td class="t">T${row.track}</td><td>${row.length}</td>
      <td class="mono">${escapeHtml(row.steps)}</td>
      <td class="mono">${row.soundLocks.map(escapeHtml).join("<br>") || "—"}</td></tr>`,
    )
    .join("\n    ");

  return `<section class="pattern">
  <h3>${patternName(sheet.index)} <span style="color:var(--muted);font-weight:400">"${escapeHtml(sheet.name)}"</span></h3>
  <p class="meta">${sheet.tempo} BPM · RESET ${sheet.reset} · CHNG ${sheet.changeLength === 1 ? "off" : sheet.changeLength}
    · scale ${sheet.perTrackScale ? "PER TRK" : "PER PTN"} · MIDI mask 0x${sheet.midiMask.toString(16).padStart(4, "0")}
    · <strong>${sheet.expandedCount}</strong> expanded track${sheet.expandedCount === 1 ? "" : "s"}</p>
  <div class="scroll"><table>
    <thead><tr><th>Track</th><th>Sound</th><th>LEN</th><th>Level</th><th>Trigs</th><th>Steps</th><th>Watch for</th></tr></thead>
    <tbody>
    ${rows}
    </tbody>
  </table></div>
  <details><summary>Digitone 1 original</summary><div class="scroll"><table>
    <thead><tr><th>Track</th><th>LEN</th><th>Steps</th><th>Sound locks</th></tr></thead>
    <tbody>
    ${source}
    </tbody>
  </table></div></details>
</section>`;
}

export function renderSheet(sheets: readonly PatternSheet[], meta: SheetMeta): string {
  const callouts = (meta.callouts ?? [])
    .map((c) => `<div class="card warn"><h4>${escapeHtml(c.title)}</h4><p>${c.body}</p></div>`)
    .join("\n");

  return `<title>Hardware test sheet — ${escapeHtml(meta.projectName)}</title>
<style>${STYLE}</style>

<h1>Hardware test sheet</h1>
<p class="lede"><strong>${escapeHtml(meta.projectName)}</strong> · from <code>${escapeHtml(meta.sourceFile)}</code>
 · file <code>${escapeHtml(meta.outputFile)}</code> · ${sheets.length} patterns with content</p>

<div class="card"><h4>Check the build before anything else</h4>
<p>The device shows the project name as <code>${escapeHtml(meta.projectName)}</code>. The last four digits are
the build time — if they do not match, you are testing an older file.</p></div>

${callouts}

<h2>How to read this</h2>
<ul>
  <li>Patterns are named as the device names them: <strong>A1</strong>, <strong>B5</strong>, <strong>D1</strong>.</li>
  <li>Trigs are <strong>page · step</strong>, both 1-16. <code>p3·14</code> means page 3, step 14 — never "step 46".</li>
  <li><strong>Highlighted rows are expanded tracks</strong> (T9-T16): sounds that were sound-locked on the
      Digitone 1 and now own a track.</li>
  <li>Every pattern folds out its Digitone 1 original, for A/B against the source project.</li>
</ul>

<h2>What matters most</h2>
<ol>
  <li><strong>Do T9-T16 play at all?</strong> No Elektron file ever writes those tracks, so this is the one
      genuinely unproven assumption in the tool.</li>
  <li><strong>Track lengths.</strong> These patterns are PER TRK: an expanded track must run its own LEN, not
      the master RESET. A track looping early is the scale-mode bug returning.</li>
  <li><strong>Levels.</strong> An expanded track inherits the level of the DN1 track its sound came from.
      Every expanded track sitting at 100 means levels are being inherited from the template.</li>
  <li><strong>Trigs still sound-locked</strong> (listed under "watch for") must still play the locked sound.</li>
  <li><strong>Per-trig detail</strong> — conditions, probability, micro timing, chords, p-locks — must travel
      with a trig that changed track.</li>
</ol>

${sheets.map(renderPattern).join("\n")}

<h2>Provenance</h2>
<p class="lede">Generated by <code>npm run sheet</code> from the output file's own bytes — not from the
expansion plan, so a field the writer never wrote shows up here as whatever it really is.</p>
`;
}
