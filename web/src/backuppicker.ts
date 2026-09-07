/**
 * Choosing one thing out of a backup.
 *
 * Markup and nothing else. Every judgement it draws — the grouping, which kinds can be acted on,
 * what is worth warning about — is `backupsummary.ts`, which has no DOM in it and is tested. This
 * file's job is to put that on screen and hand back what was picked.
 *
 * ## A backup is opened before it is trusted
 *
 * The caller opens the file with `openBackup`, which refuses anything that would make a bad write,
 * and passes the result here. So this never sees a file it has to be suspicious of, and it can
 * spend its attention on the thing a reader actually has to decide: **which one**.
 *
 * ## Warnings lead
 *
 * A backup that lost three slots still opens, and the reader is told at the top rather than left to
 * notice a shorter list than they expected. `openBackup` reports damage instead of throwing
 * precisely so somebody can be told, and burying it under a list would waste that.
 */

import { openOverlay } from "./overlay.js";
import { summariseBackup, type BackupGroup, type BackupSummary } from "./backupsummary.js";
import type { OpenedBackup, OpenedEntry } from "./dnxopen.js";

export interface PickOptions {
  /** Kinds whose entries can be chosen. Everything else is shown as a count. */
  actionable: readonly string[];
  /** The file's own name, so the reader can see which backup they opened. */
  fileName: string;
  /** Returned to when the picker closes. */
  opener?: HTMLElement;
}

function line(text: string, className: string): HTMLElement {
  const el = document.createElement("p");
  el.className = className;
  el.textContent = text;
  return el;
}

/** One choosable entry, as a row that says what it is and where it came from. */
function entryRow(entry: OpenedEntry, onPick: (entry: OpenedEntry) => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pick-row";

  const slot = document.createElement("b");
  // The slot leads for the same reason it leads in a backup's file names: two projects on one
  // +Drive may share a name, and two cannot share a slot.
  slot.textContent = String(entry.entry.slot).padStart(3, "0");

  const name = document.createElement("span");
  name.className = "pick-name";
  name.textContent = entry.entry.name;

  const where = document.createElement("span");
  where.className = "pick-where";
  where.textContent = entry.entry.source;

  button.append(slot, name, where);
  button.addEventListener("click", () => onPick(entry));
  return button;
}

function groupBlock(group: BackupGroup, onPick: (entry: OpenedEntry) => void): HTMLElement {
  const section = document.createElement("section");
  section.className = "pick-group";

  const heading = document.createElement("h4");
  const banks = group.banks.length === 0 ? ""
    : ` · ${group.banks.length === 1 ? "bank" : "banks"} ${group.banks.join(" ")}`;
  heading.textContent = `${group.label} — ${group.count}${banks}`;
  section.append(heading);

  if (group.entries.length > 0) {
    const list = document.createElement("div");
    list.className = "pick-list";
    for (const entry of group.entries) list.append(entryRow(entry, onPick));
    section.append(list);
    return section;
  }

  section.append(line(
    // Said plainly rather than left as a greyed-out row somebody clicks at. Placing a sound is
    // the next stage of this work, and a reader is owed the difference between "not here" and
    // "not yet".
    `Listed, and not something this can place yet.`,
    "pick-note",
  ));
  return section;
}

function head(summary: BackupSummary, fileName: string, onClose: () => void): HTMLElement {
  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = fileName;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "sheet-close";
  close.textContent = "Close";
  close.addEventListener("click", onClose);

  // `.pick-from` is full width, so it wraps to its own line and the close button stays on the
  // title's, where the settings sheet puts it.
  const from = line(`${summary.device} · taken ${summary.taken}`, "pick-from");
  header.append(title, close, from);
  return header;
}

/**
 * Show what a backup holds and resolve with what the reader chose.
 *
 * Resolves `undefined` when they close it without choosing, which is an ordinary outcome and not
 * an error: opening a backup to look at what is in it is a reason to open one.
 */
export function pickFromBackup(
  backup: OpenedBackup, options: PickOptions,
): Promise<OpenedEntry | undefined> {
  const summary = summariseBackup(backup, options.actionable);

  return new Promise((resolve) => {
    let picked: OpenedEntry | undefined;

    const overlay = openOverlay({
      className: "sheet pick-sheet",
      label: `What is in ${options.fileName}`,
      ...(options.opener === undefined ? {} : { opener: options.opener }),
      // Whatever route it closed by, the caller gets one answer. Without this, closing on Escape
      // would leave a promise nobody resolves and a caller waiting forever.
      onClose: () => resolve(picked),
    });

    const onPick = (entry: OpenedEntry): void => {
      picked = entry;
      overlay.close();
    };

    overlay.panel.append(head(summary, options.fileName, () => overlay.close()));
    for (const warning of summary.warnings) overlay.panel.append(line(warning, "pick-warn"));
    for (const group of summary.groups) overlay.panel.append(groupBlock(group, onPick));

    if (summary.groups.length === 0) {
      overlay.panel.append(line("This backup holds nothing at all.", "pick-note"));
    } else if (summary.empty) {
      overlay.panel.append(line(
        "Nothing in this backup is something this can place yet.", "pick-note",
      ));
    }

    overlay.panel.querySelector<HTMLElement>("button")?.focus();
  });
}
