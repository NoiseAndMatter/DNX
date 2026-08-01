/**
 * How the probe draws a result. **Presentation only — no ports, no protocol, no state.**
 *
 * ## Why these came out of `main.ts`
 *
 * `probe/main.ts` was 2,600 lines doing eleven jobs, and the audit in `docs/STRUCTURE-AUDIT.md`
 * named it the one genuine god file in the repository. This is the first piece to leave, and it is
 * deliberately the safest: every function here takes what it needs and returns markup or appends an
 * element. None of them can be broken by a device, and none of them can break one.
 *
 * The transports are a separate job and move separately, because those *can* break a device and
 * deserve their own change with its own hardware pass.
 *
 * ## The one rule these follow
 *
 * **A card owns its element.** `verdictCard` exists because the first two attempts at a write
 * verdict appended to `#results` and were wiped by the next incoming MIDI message — first
 * unguarded, then guarded by a flag that could not work, because the flag is only true *during* the
 * write while the destroying redraw happens after it. Separate elements, not coordination.
 */

import { escapeHtml } from "../../../src/sheet/html.js";
import { describeMessages } from "../../../src/device/capabilities.js";
import { type DirEntry } from "../../../src/device/api.js";

/** A titled block of key/value rows — the probe's whole visual vocabulary. */
export function card(into: HTMLElement, title: string, rows: [string, string][]): void {
  const section = document.createElement("section");
  section.className = "card";
  section.innerHTML =
    `<h2>${escapeHtml(title)}</h2>` +
    rows
      .map(
        ([k, v]) =>
          `<div class="row"><span class="k">${escapeHtml(k)}</span>` +
          `<span class="v">${escapeHtml(v) || "&mdash;"}</span></div>`,
      )
      .join("");
  into.append(section);
}

/**
 * What the device says it supports, with what sending each one would do.
 *
 * The safety column is the point of the table. **`unknown` is not `read`** — it means nobody has
 * shown it does not write, and those are different claims about somebody's instrument.
 */
export function messageCard(into: HTMLElement, codes: readonly number[], hex: (code: number) => string): void {
  const rows = describeMessages(codes)
    .map(
      (m) =>
        `<tr><td class="mono">${hex(m.code)}</td>` +
        `<td class="mono">${m.kind}</td>` +
        `<td>${m.known ? escapeHtml(m.name) : `<em>unknown</em>`}</td>` +
        `<td class="mono ${m.safety}">${m.safety}</td></tr>`,
    )
    .join("\n  ");

  const section = document.createElement("section");
  section.className = "card";
  section.innerHTML =
    `<h2>Supported messages (${codes.length})</h2>` +
    `<p class="hint">The probe only ever sends <span class="mono read">read</span>. A
     <span class="mono write">write</span> changes the instrument; an
     <span class="mono unknown">unknown</span> has never been shown not to, and those are
     different things worth keeping apart.</p>` +
    `<table><thead><tr><th>Code</th><th>Kind</th><th>Message</th><th>Sending it</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
  into.append(section);
}

/** A +Drive directory listing. An empty directory says so rather than drawing an empty table. */
export function listing(into: HTMLElement, path: string, entries: DirEntry[]): void {
  const section = document.createElement("section");
  section.className = "card";
  section.innerHTML =
    `<h2>+Drive ${escapeHtml(path)}</h2>` +
    (entries.length === 0
      ? `<p class="hint">Empty.</p>`
      : `<table><thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th>Locked</th></tr></thead><tbody>` +
        entries
          .map(
            (e) =>
              `<tr><td class="mono">${escapeHtml(e.name)}</td>` +
              `<td class="mono">${escapeHtml(e.type)}</td>` +
              `<td class="mono num">${e.size.toLocaleString()}</td>` +
              `<td>${e.locked ? "yes" : ""}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`);
  into.append(section);
}

/**
 * The write verdict, in **its own element**.
 *
 * **Third attempt, and the first structural one.** The first version appended to `#results` and was
 * cleared by the next incoming message. The second guarded that with a `writing` flag — which still
 * lost, because the flag is only true *during* the write and any message arriving afterwards redraws
 * the area: a reply that beat the timeout, a late one that missed it, anything at all.
 *
 * Flags cannot fix this. The verdict lives somewhere the capture renderer does not know about, so
 * nothing that redraws the capture can destroy it, whatever the ordering.
 */
export function verdictCard(into: HTMLElement, title: string, rows: [string, string][]): void {
  into.innerHTML = "";
  card(into, title, rows);
  into.scrollIntoView({ block: "start" });
}

/** Eight hex digits, for a 32-bit field. */
export function hex8(v: number): string {
  return v.toString(16).padStart(8, "0");
}

/** Two hex digits, for a byte. */
export function hex2(b: number): string {
  return b.toString(16).padStart(2, "0");
}
