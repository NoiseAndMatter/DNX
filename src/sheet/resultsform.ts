/**
 * Turning a printed check sheet into one that fills itself in.
 *
 * The 2026-07-27 rearrangement session was run off a static HTML table with `☐ ☐` drawn in
 * CSS and an empty cell for notes. It worked, and it cost the tester a second pass typing the
 * results back into a chat window by hand — which is where detail gets lost, because nobody
 * retypes the row that passed.
 *
 * So the sheet is now a form. Every tick is a real control, every note is a real field, and
 * the button at the bottom writes a Markdown file. That file is the deliverable: hand it back
 * and every row, including the boring ones, arrives exactly as it was recorded.
 *
 * ## Three decisions worth keeping
 *
 * **Markdown, not JSON.** The export has two readers — a person skimming what happened, and
 * whatever consumes it next. Markdown serves both; JSON serves only the second, and a results
 * file nobody can read is a results file nobody checks.
 *
 * **Unanswered is a state.** A row left blank exports as `-`, never as a pass. The whole
 * value of a hardware session is in what did not work, and a form that quietly defaults to
 * "fine" would erase exactly that. The export header counts what is still unanswered.
 *
 * **It survives a reload.** Every keystroke goes to `localStorage`, keyed by build stamp. The
 * tester is standing at a machine with the page open for an hour; a stray refresh must not
 * throw the session away.
 *
 * No network, no dependencies, no build step — the file opens from disk on any browser.
 */

/** One thing the tester has to answer. */
export interface ResultField {
  /** Stable id, used for the control name and the localStorage key. */
  id: string;
  /** What is being judged, in the export. */
  label: string;
}

/** Styles for the interactive controls, appended to the sheet's own stylesheet. */
export const RESULTS_FORM_CSS = `
  .rf-pass, .rf-fail { cursor:pointer; user-select:none; font-size:.78rem;
    border:1px solid var(--line); border-radius:5px; padding:.12rem .42rem; display:inline-block;
    margin-right:.2rem; color:var(--muted); background:var(--bg); }
  .rf-radio { position:absolute; opacity:0; width:0; height:0; }
  .rf-radio:checked + .rf-pass { background:#1a7f43; border-color:#1a7f43; color:#fff; }
  .rf-radio:checked + .rf-fail { background:var(--bad); border-color:var(--bad); color:#fff; }
  .rf-radio:focus-visible + label { outline:2px solid var(--accent); outline-offset:1px; }
  td.tick { width:5.6rem; white-space:nowrap; }
  td.tick::before { content:none; }
  .rf-note { width:100%; border:1px solid var(--line); border-radius:5px; background:var(--bg);
    color:var(--fg); padding:.22rem .4rem; font:inherit; font-size:.82rem; }
  .rf-note:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  .rf-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:.7rem; }
  .rf-meta label { display:block; font-size:.72rem; text-transform:uppercase;
    letter-spacing:.05em; color:var(--muted); margin-bottom:.2rem; }
  .rf-check { display:flex; gap:.55rem; align-items:flex-start; margin:.4rem 0; }
  .rf-check input { margin-top:.28rem; width:1rem; height:1rem; accent-color:var(--accent);
    flex:none; }
  textarea.rf-note { min-height:6rem; resize:vertical; }
  .rf-bar { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line);
    padding:.9rem 0; margin-top:2rem; display:flex; gap:.6rem; align-items:center;
    flex-wrap:wrap; }
  .rf-btn { font:inherit; font-weight:600; cursor:pointer; border-radius:7px;
    padding:.5rem .95rem; border:1px solid var(--accent); background:var(--accent); color:#fff; }
  .rf-btn.alt { background:transparent; color:var(--accent); }
  .rf-btn:hover { filter:brightness(1.08); }
  .rf-status { color:var(--muted); font-size:.84rem; }
  @media print { .rf-bar { display:none; } }
`;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The pass/fail pair for one row. Radios, so "not answered yet" stays representable. */
export function verdictCell(id: string): string {
  return (
    `<input class="rf-radio" type="radio" id="${id}-p" name="v-${id}" value="PASS">` +
    `<label class="rf-pass" for="${id}-p" title="worked">OK</label>` +
    `<input class="rf-radio" type="radio" id="${id}-f" name="v-${id}" value="FAIL">` +
    `<label class="rf-fail" for="${id}-f" title="did not work">no</label>`
  );
}

/** The free-text cell beside it. */
export function noteCell(id: string, placeholder = "what happened"): string {
  return (
    `<input class="rf-note" type="text" id="n-${id}" data-note="${id}" ` +
    `placeholder="${esc(placeholder)}">`
  );
}

/** A tickable item for checklists that are not table rows. */
export function checkItem(id: string, label: string): string {
  return (
    `<div class="rf-check"><input type="checkbox" id="c-${id}" data-check="${id}">` +
    `<label for="c-${id}">${esc(label)}</label></div>`
  );
}

/** A labelled single-line field for the session metadata. */
export function metaField(id: string, label: string, value = ""): string {
  return (
    `<div><label for="m-${id}">${esc(label)}</label>` +
    `<input class="rf-note" type="text" id="m-${id}" data-meta="${id}" value="${esc(value)}"></div>`
  );
}

/** The free-text block at the end, where the useful surprises usually land. */
export function observationsField(): string {
  return (
    `<textarea class="rf-note" id="m-observations" data-meta="observations" ` +
    `placeholder="Anything unexpected — including things this sheet did not ask about. ` +
    `A surprise here is worth more than nine ticks."></textarea>`
  );
}

/** The sticky export bar. */
export function exportBar(): string {
  return `<div class="rf-bar">
  <button class="rf-btn" type="button" id="rf-download">Export results</button>
  <button class="rf-btn alt" type="button" id="rf-copy">Copy to clipboard</button>
  <button class="rf-btn alt" type="button" id="rf-reset">Clear</button>
  <span class="rf-status" id="rf-status"></span>
</div>`;
}

/** Where a row's answers end up in the exported table. */
export interface ExportRow {
  id: string;
  /** Leading cells, already plain text, reproduced verbatim in the export. */
  cells: string[];
}

export interface ExportSpec {
  title: string;
  stamp: string;
  /** Column headings for the results table, before the Result and Notes columns. */
  columns: string[];
  rows: ExportRow[];
  /** Metadata fields, in export order. */
  meta: ResultField[];
  /** Checklist items, in export order. */
  checks: ResultField[];
}

/**
 * The script that saves, restores and exports.
 *
 * Emitted as a string rather than a separate file because the sheet has to work when it is
 * the only thing on the machine — opened from disk, moved to a phone, mailed to someone.
 * A single self-contained file is the property that makes that true.
 */
export function resultsFormScript(spec: ExportSpec): string {
  return `<script>
(function () {
  var SPEC = ${JSON.stringify(spec)};
  var KEY = "dnx-results-" + SPEC.stamp;

  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function status(msg) { document.getElementById("rf-status").textContent = msg; }

  // --- persistence: the tester is standing at a machine, a stray refresh must not cost them
  function save() {
    var state = { v: {}, n: {}, c: {}, m: {} };
    all("input.rf-radio").forEach(function (el) {
      if (el.checked) state.v[el.name.slice(2)] = el.value;
    });
    all("[data-note]").forEach(function (el) { if (el.value) state.n[el.dataset.note] = el.value; });
    all("[data-check]").forEach(function (el) { if (el.checked) state.c[el.dataset.check] = true; });
    all("[data-meta]").forEach(function (el) { if (el.value) state.m[el.dataset.meta] = el.value; });
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function restore() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var state;
    try { state = JSON.parse(raw); } catch (e) { return; }
    Object.keys(state.v || {}).forEach(function (id) {
      var el = document.getElementById(id + (state.v[id] === "PASS" ? "-p" : "-f"));
      if (el) el.checked = true;
    });
    Object.keys(state.n || {}).forEach(function (id) {
      var el = document.getElementById("n-" + id);
      if (el) el.value = state.n[id];
    });
    Object.keys(state.c || {}).forEach(function (id) {
      var el = document.getElementById("c-" + id);
      if (el) el.checked = true;
    });
    Object.keys(state.m || {}).forEach(function (id) {
      var el = document.getElementById("m-" + id);
      if (el) el.value = state.m[id];
    });
    status("restored your answers from this browser");
  }

  function verdictOf(id) {
    var checked = document.querySelector('input[name="v-' + id + '"]:checked');
    return checked ? checked.value : "-";
  }
  function noteOf(id) {
    var el = document.getElementById("n-" + id);
    return el && el.value ? el.value.replace(/\\|/g, "\\\\|") : "";
  }

  // --- the export. Markdown, so a person and a machine can both read it.
  function build() {
    var out = [];
    out.push("# " + SPEC.title);
    out.push("");

    SPEC.meta.forEach(function (f) {
      var el = document.getElementById("m-" + f.id);
      if (f.id === "observations") return;
      out.push("- " + f.label + ": " + ((el && el.value) || "-"));
    });
    out.push("");

    var unanswered = SPEC.rows.filter(function (r) { return verdictOf(r.id) === "-"; }).length;
    var failed = SPEC.rows.filter(function (r) { return verdictOf(r.id) === "FAIL"; });
    out.push("**" + (SPEC.rows.length - unanswered) + " of " + SPEC.rows.length +
      " answered, " + failed.length + " failing"  +
      (unanswered ? ", " + unanswered + " left blank" : "") + ".**");
    out.push("");

    if (failed.length) {
      out.push("## What did not work");
      out.push("");
      failed.forEach(function (r) {
        out.push("- **" + r.cells.join(" / ") + "** — " + (noteOf(r.id) || "no note given"));
      });
      out.push("");
    }

    out.push("## Every row");
    out.push("");
    out.push("| " + SPEC.columns.concat(["Result", "What happened"]).join(" | ") + " |");
    out.push("|" + SPEC.columns.concat(["Result", "What happened"]).map(function () {
      return "---";
    }).join("|") + "|");
    SPEC.rows.forEach(function (r) {
      out.push("| " + r.cells.concat([verdictOf(r.id), noteOf(r.id)]).join(" | ") + " |");
    });
    out.push("");

    if (SPEC.checks.length) {
      out.push("## Beyond \\"it plays\\"");
      out.push("");
      SPEC.checks.forEach(function (f) {
        var el = document.getElementById("c-" + f.id);
        out.push("- [" + (el && el.checked ? "x" : " ") + "] " + f.label);
      });
      out.push("");
    }

    var obs = document.getElementById("m-observations");
    out.push("## Observations");
    out.push("");
    out.push((obs && obs.value) || "_none recorded_");
    out.push("");
    return out.join("\\n");
  }

  document.getElementById("rf-download").addEventListener("click", function () {
    var blob = new Blob([build()], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "DNX_RESULTS_" + SPEC.stamp + ".md";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    status("exported DNX_RESULTS_" + SPEC.stamp + ".md — hand that file over as it is");
  });

  document.getElementById("rf-copy").addEventListener("click", function () {
    var text = build();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); status("copied"); }
      catch (e) { status("could not copy — use Export instead"); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { status("copied"); }, fallback);
    } else { fallback(); }
  });

  document.getElementById("rf-reset").addEventListener("click", function () {
    if (!confirm("Clear every answer on this sheet?")) return;
    try { localStorage.removeItem(KEY); } catch (e) {}
    all("input.rf-radio").forEach(function (el) { el.checked = false; });
    all("[data-check]").forEach(function (el) { el.checked = false; });
    all("[data-note], [data-meta]").forEach(function (el) { el.value = ""; });
    status("cleared");
  });

  document.addEventListener("input", save);
  document.addEventListener("change", save);
  restore();
})();
</script>`;
}
