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
import { type ApiGroup, type CaptureSummary } from "@noiseandmatter/dnx-core/device/capture.js";
import { describeMessages, hex } from "@noiseandmatter/dnx-core/device/capabilities.js";
import { type DirEntry } from "@noiseandmatter/dnx-core/device/api.js";

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

/**
 * The capture, drawn as cards.
 *
 * Moved here with the other renderers because that is what it is — it takes a summary and an
 * element and produces markup. It used to reach for `#results`, the module-level capture and the
 * page's `listening` flag, which is what made a presentation function look like page wiring.
 *
 * It returns the summary it was given, so the status line beneath it can use the parse that has
 * already happened rather than starting another. That is not tidiness: the second parse, once per
 * arriving MIDI message, is what blocked the main thread for 56 seconds during a write.
 */
export function renderCapture(
  results: HTMLElement,
  summary: CaptureSummary,
  state: { listening: boolean; issuedIds: ReadonlySet<number> },
): CaptureSummary {
  results.innerHTML = "";

  const rows: [string, string][] = [
    ["Bytes", summary.bytes.toLocaleString()],
    ["Messages", String(summary.messages)],
  ];
  if (summary.foreign > 0) rows.push(["Not Elektron", `${summary.foreign} — ignored`]);
  if (summary.unparsed > 0) rows.push(["Unreadable", String(summary.unparsed)]);
  // A transfer stopped mid-message is normal, and saying so beats a summary that quietly
  // describes a truncated capture as a complete one.
  if (summary.trailingBytes > 0) {
    rows.push(["Incomplete tail", `${summary.trailingBytes} bytes — a message was cut short`]);
  }
  card(results, state.listening ? "Listening…" : "Capture", rows);

  for (const group of summary.groups) {
    const objects =
      group.objects.length === 0
        ? "—"
        : group.objects.length <= 12
          ? group.objects.join(", ")
          : `${group.objects.length} objects, ${group.objects[0]}…${group.objects[group.objects.length - 1]}`;
    card(results, `${group.product} — ${group.name} (${hex(group.dumpType)})`, [
      ["Messages", String(group.count)],
      ["Bytes", group.bytes.toLocaleString()],
      ["Object numbers", objects],
      // Said plainly, because "128 objects" against 182 messages reads as lost data. It is not:
      // the field is one 7-bit byte, and the device reports 0 once it runs out.
      // Observed, then both causes named — because the bytes genuinely cannot tell them apart.
      // This used to assert saturation, and said so on a capture of 129 patternKits where the
      // extra one was our own verification re-read. A confident wrong explanation is worse than
      // an honest ambiguous one.
      ...(group.numbersExhausted
        ? ([[
            "Note",
            `${group.count} messages, ${group.objects.length} distinct numbers. Either the object ` +
              `number saturated — it is a 7-bit field, so a bank of more than 128 reports 0 for ` +
              `the rest and only send order identifies those — or some objects simply arrived ` +
              `twice, which is what a re-read or a verification does. Nothing is lost either way.`,
          ]] as [string, string][])
        : []),
      ["Checksums", group.badChecksum === 0 ? "all good" : `${group.badChecksum} BAD`],
    ]);
  }

  // The other protocol, kept visibly apart. Before this existed, API traffic went through the dump
  // parser and came out as "product 16 — unknown (0x04)" with every checksum BAD, which is a
  // convincing description of a broken device rather than of a working one speaking a second
  // language. Both machines produce some, so this is the *normal* case.
  if (summary.api.length > 0) {
    const total = summary.api.reduce((n, g) => n + g.count, 0);
    card(results, `API traffic — ${total} message${total === 1 ? "" : "s"}`, [
      ...summary.api.map(
        (group) =>
          [
            `${hex(group.code)} ${group.name}`,
            `${group.count} × ${group.bytes.toLocaleString()} B` +
              (group.replies === group.count ? "" : `, ${group.replies} answering a request`) +
              (group.respIds.length > 0 ? ` — answers ${group.respIds.join(", ")}` : ""),
          ] as [string, string],
      ),
      ["Whose", whose(summary.api, state.issuedIds)],
    ]);
  }

  return summary;
}

/**
 * Say whose requests this traffic answers, which the summariser deliberately will not.
 *
 * `capture.ts` reports the response ids and stops, because a capture is bytes off an input port and
 * has no record of what was sent. **This page does have that record** — it allocated every id it
 * ever sent — so the knowledge lives here, where it exists, rather than in a module that would have
 * to be told.
 *
 * Worth the trouble because the ambiguity is not academic: a flood of Transfer's replies was once
 * read as our answer and a wrong finding was recorded on it. "Answers an id we never sent" ends
 * that argument in one line.
 */
function whose(groups: readonly ApiGroup[], issuedIds: ReadonlySet<number>): string {
  const seen = groups.flatMap((g) => g.respIds);
  if (seen.length === 0) return "Nothing here answers a request — these were volunteered.";

  const ours = seen.filter((id) => issuedIds.has(id));
  const theirs = seen.filter((id) => !issuedIds.has(id));

  if (theirs.length === 0) return `Ours — every id (${ours.join(", ")}) is one this page sent.`;
  if (ours.length === 0) {
    return (
      `NOT ours. ${theirs.join(", ")} ${theirs.length === 1 ? "is an id" : "are ids"} this page ` +
      `never sent, so ${theirs.length === 1 ? "it answers" : "they answer"} another application — ` +
      `Elektron Transfer, or an earlier session on this port. Do not read this as a reply to us.`
    );
  }
  return `Mixed. Ours: ${ours.join(", ")}. Not ours: ${theirs.join(", ")}.`;
}
