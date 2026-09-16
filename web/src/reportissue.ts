/**
 * Reporting a problem, from whichever tool you were in.
 *
 * ## DNX sends nothing
 *
 * **There is no anonymous way to file a GitHub issue.** Every create is authenticated, and the two
 * ways round that are both wrong here: a server holding a bot token would make DNX a spam relay
 * pointed at its own repository and would falsify the sentence on its own front page — *nothing
 * leaves this machine* — and OAuth from a static page needs a client secret it cannot hold.
 *
 * So this **hands the reader a filled-in issue** rather than sending one. It builds a
 * `issues/new?title=…&body=…&labels=…` URL and opens it in a new tab; GitHub asks who they are,
 * they read what they are about to post, and they press the button. DNX stores no credential, has
 * no account, and never talks to GitHub itself.
 *
 * **The wording matters.** The control says *Open a report on GitHub*, not *Send*. Somebody who
 * closes that tab has not reported anything, and a button that said "Send" would have told them
 * they had.
 *
 * ## The label is the tool, and the title says so too
 *
 * `labels=expander` needs the label to exist in the repository, and the four were created for
 * this on 2026-09-16. The title carries `[expander]` as well, which costs nothing and survives a
 * fork whose labels are different.
 *
 * ## The context block is shown before it is sent
 *
 * A report without a version is a report nobody can act on: DNX is a page with no release
 * cadence, so two people on the same version can be a fortnight apart. The block carries the
 * version and commit, the tool, the browser, and the instrument when a page has lent one.
 *
 * **What it deliberately does not carry**: no project names, no file names, no folder names, no
 * preset names. It is in the preview because it is the reader's own data and they are about to
 * publish it — nobody should discover afterwards what was attached.
 */

import { DNX_BUILD } from "./version.js";
import { mdToHtml } from "./markdown.js";
import { openOverlay, type Overlay } from "./overlay.js";
import type { PageId } from "./toolnav.js";

/** Where reports go. The same repository the source link names. */
const REPO = "https://github.com/NoiseAndMatter/DNX";

/**
 * How long a prefilled URL may get.
 *
 * Browsers take far more, but a URL is a GET and intermediaries have their own ceilings; a report
 * that arrives truncated is worse than one the reader pastes. Past this the dialog copies the
 * whole thing and opens an empty issue instead, which loses nothing but a paste.
 */
export const URL_LIMIT = 6_000;

/**
 * What a page can lend: how to describe the instrument it is talking to.
 *
 * The same shape as `registerBackup` in `settings.ts`, and for the same reason — this module is
 * shared by every page and three of them have no device at all. A page that has one registers it;
 * a page that has not contributes no line rather than an empty one.
 */
export type DeviceNote = () => string | undefined;

let describeDevice: DeviceNote | undefined;

/** Called by a page that can reach an instrument. */
export function registerDeviceNote(note: DeviceNote): void {
  describeDevice = note;
}

/** The lines DNX attaches to a report, in the order they are most use to a reader. */
export function contextLines(tool: PageId, device = describeDevice?.()): string[] {
  const lines = [`DNX ${DNX_BUILD}`, `Tool: ${tool}`];
  if (device) lines.push(`Instrument: ${device}`);
  // The user agent is the one fact a reader cannot supply accurately from memory.
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    lines.push(`Browser: ${navigator.userAgent}`);
  }
  return lines;
}

/** The whole issue body: what they wrote, then what DNX knows. */
export function issueBody(description: string, context: readonly string[]): string {
  const written = description.trim();
  return `${written || "_No description given._"}\n\n---\n\n${context.map((l) => `- ${l}`).join("\n")}\n`;
}

/** The prefilled URL, or `undefined` when it would be too long to trust. */
export function issueUrl(tool: PageId, subject: string, body: string): string | undefined {
  const title = `[${tool}] ${subject.trim()}`.trim();
  const url =
    `${REPO}/issues/new?title=${encodeURIComponent(title)}` +
    `&body=${encodeURIComponent(body)}` +
    (tool === "landing" ? "" : `&labels=${encodeURIComponent(tool)}`);
  return url.length > URL_LIMIT ? undefined : url;
}

/** The empty form, for when the report has to be pasted instead. */
export function blankIssueUrl(): string {
  return `${REPO}/issues/new`;
}

/* ---- the dialog ------------------------------------------------------------------------- */

let sheet: Overlay | undefined;

export function openReport(tool: PageId, opener?: HTMLElement): void {
  if (sheet) return;
  sheet = openOverlay({
    className: "sheet report-sheet",
    label: "Report a problem",
    ...(opener === undefined ? {} : { opener }),
    // Escape and a click outside close it without going through the button, and a stale reference
    // here makes the guard above refuse every later open. The same trap settings.ts records.
    onClose: () => { sheet = undefined; },
  });
  build(sheet.panel, tool);
}

/** The button in the tool row, on every page. */
export function renderReportLink(container: HTMLElement, tool: PageId): HTMLElement {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "reportlink";
  link.textContent = "report";
  link.title = "Report a problem with this tool";
  link.addEventListener("click", () => openReport(tool, link));
  container.append(link);
  return link;
}

function build(panel: HTMLElement, tool: PageId): HTMLElement {
  panel.id = "report-sheet";

  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = "Report a problem";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sheet-close";
  close.textContent = "Close";
  close.addEventListener("click", () => sheet?.close());
  header.append(title, close);

  const form = document.createElement("div");
  form.className = "report-form";

  const subjectLabel = document.createElement("label");
  subjectLabel.htmlFor = "report-subject";
  subjectLabel.textContent = "Subject";
  const subject = document.createElement("input");
  subject.id = "report-subject";
  subject.type = "text";
  subject.maxLength = 120;
  subject.placeholder = "What happened, in a line";

  const bodyLabel = document.createElement("label");
  bodyLabel.htmlFor = "report-body";
  bodyLabel.textContent = "Description — Markdown";
  const body = document.createElement("textarea");
  body.id = "report-body";
  body.rows = 9;
  body.placeholder =
    "What you did, what you expected, and what happened instead.\n\n" +
    "Markdown works: **bold**, `code`, - lists.";

  const previewTitle = document.createElement("p");
  previewTitle.className = "report-heading";
  previewTitle.textContent = "What will be posted";

  const preview = document.createElement("div");
  preview.className = "report-preview";

  const note = document.createElement("p");
  note.className = "report-note";
  note.textContent =
    "This opens a filled-in issue on GitHub in a new tab. Nothing is sent from here — you read it " +
    "there and press the button yourself, signed in to your own account.";

  const actions = document.createElement("div");
  actions.className = "report-actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn primary";
  open.textContent = "Open a report on GitHub";
  const said = document.createElement("span");
  said.className = "report-said";
  actions.append(open, said);

  const render = (): void => {
    const context = contextLines(tool);
    const text = issueBody(body.value, context);
    preview.innerHTML = mdToHtml(`### [${tool}] ${subject.value.trim() || "…"}\n\n${text}`);
    open.disabled = subject.value.trim().length === 0;
    said.textContent = open.disabled ? "A subject is needed." : "";
  };

  subject.addEventListener("input", render);
  body.addEventListener("input", render);

  open.addEventListener("click", () => {
    const text = issueBody(body.value, contextLines(tool));
    const url = issueUrl(tool, subject.value, text);
    if (url) {
      window.open(url, "_blank", "noopener");
      said.textContent = "Opened on GitHub. It is not reported until you press the button there.";
      return;
    }
    /*
     * Too long to put in a URL. The report is copied and an empty form opened, which costs one
     * paste and never truncates — a report that arrives half-written is worse than one that asks.
     */
    void navigator.clipboard.writeText(text).then(
      () => {
        window.open(blankIssueUrl(), "_blank", "noopener");
        said.textContent = "Too long for a link, so it is on your clipboard. Paste it into the form.";
      },
      () => {
        said.textContent = "Too long for a link, and the browser would not let the page copy it. " +
          "Select the preview and copy it by hand.";
      },
    );
  });

  form.append(subjectLabel, subject, bodyLabel, body, previewTitle, preview, note, actions);
  panel.append(header, form);
  render();
  queueMicrotask(() => subject.focus());
  return panel;
}
