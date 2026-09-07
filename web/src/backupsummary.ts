/**
 * What an opened `.dnx` says about itself, worked out before anything is drawn.
 *
 * ## Why this is not in the picker
 *
 * The picker is markup. Everything decided here — how a backup is grouped, which of it a caller
 * can act on, and what is worth warning about — is a judgement, and judgements that live inside DOM
 * assembly cannot be tested without a browser. This codebase has no browser in its tests, so the
 * choice is between testing these decisions and drawing them.
 *
 * ## Grouping, and why entries are not always carried
 *
 * A Digitone II backup holds 1,835 sounds. Rendering all of them to choose one project is a
 * thousand rows nobody asked for, so a group carries its `entries` **only when the caller says it
 * can act on that kind**. Everything else is still counted and named, because a reader deciding
 * whether this is the right backup needs to see that the sounds are in there.
 *
 * ## Warnings are sentences, not counts
 *
 * `openBackup` reports damage rather than throwing, which only helps if somebody is told. A count
 * on its own ("3 damaged") is a number a reader cannot act on; the sentence says which slots they
 * have lost and that the rest is fine.
 */

import type { OpenedBackup, OpenedEntry } from "./dnxopen.js";

export interface BackupGroup {
  /** `projects`, `soundbanks`, `kits`, or whatever a future firmware adds. */
  kind: string;
  /** What to call it in a heading: `Projects`, `Sounds`, `Kits`. */
  label: string;
  count: number;
  /** Bank letters present, for sounds and kits. Empty for projects. */
  banks: string[];
  /** Present only for a kind the caller can act on. */
  entries: OpenedEntry[];
}

export interface BackupSummary {
  /** `Digitone II · firmware 1.10E`, or the name alone when it never answered. */
  device: string;
  /** `2026-09-07 04:21 UTC`, or the raw string when it is not a date. */
  taken: string;
  groups: BackupGroup[];
  /** Sentences a reader can act on. Empty when nothing is wrong. */
  warnings: string[];
  /** True when nothing in the backup can be acted on, which is worth saying out loud. */
  empty: boolean;
}

/**
 * Names for the directories the +Drive is known to have.
 *
 * A kind not listed here is shown under its own name rather than skipped, for the same reason
 * `dnxopen.ts` carries it through: the directory count has been wrong before.
 */
const LABELS: Record<string, string> = {
  projects: "Projects",
  soundbanks: "Sounds",
  kits: "Kits",
};

function labelFor(kind: string): string {
  return LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * `2026-09-07T04:21:09.000Z` to `2026-09-07 04:21 UTC`.
 *
 * Deliberately not `toLocaleString`: this string is read beside a manifest that stores UTC, and a
 * backup taken at 04:21 that displays as 05:21 invites somebody to conclude they have two.
 */
function whenTaken(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/** The plural of the thing, so a sentence reads as English rather than as a template. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function warningsFor(backup: OpenedBackup): string[] {
  const warnings: string[] = [];

  if (backup.damaged.length > 0) {
    const missing = backup.damaged.filter((d) => d.fault === "missing");
    const wrong = backup.damaged.filter((d) => d.fault === "length");
    // Named, up to a point. Somebody with three bad slots wants to know which three; somebody with
    // three hundred wants the number and a reason to stop reading.
    const name = (list: typeof backup.damaged): string => list.length <= 4
      ? list.map((d) => d.entry.name).join(", ")
      : `${list.slice(0, 3).map((d) => d.entry.name).join(", ")} and ${list.length - 3} more`;

    if (missing.length > 0) {
      warnings.push(
        `${count(missing.length, "entry", "entries")} listed in the manifest ` +
        `${missing.length === 1 ? "is" : "are"} not in the file: ${name(missing)}. ` +
        "Everything else here is intact.",
      );
    }
    if (wrong.length > 0) {
      warnings.push(
        `${count(wrong.length, "file")} ${wrong.length === 1 ? "is" : "are"} not the size the ` +
        `manifest recorded: ${name(wrong)}. Those cannot be restored; the rest can.`,
      );
    }
  }

  if (backup.unlisted.length > 0) {
    warnings.push(
      `${count(backup.unlisted.length, "file")} in this zip ${backup.unlisted.length === 1
        ? "is" : "are"} not in the manifest, so nothing knows where ` +
      `${backup.unlisted.length === 1 ? "it belongs" : "they belong"}. ` +
      `${backup.unlisted.length === 1 ? "It is" : "They are"} ignored.`,
    );
  }

  return warnings;
}

/**
 * Describe an opened backup.
 *
 * `actionable` names the kinds whose entries the caller can do something with. Everything else is
 * counted and named but not carried, because listing 1,835 sounds to pick one project is a
 * thousand rows nobody asked for.
 */
export function summariseBackup(
  backup: OpenedBackup, actionable: readonly string[] = [],
): BackupSummary {
  const order: string[] = [];
  const byKind = new Map<string, OpenedEntry[]>();
  for (const entry of backup.entries) {
    const list = byKind.get(entry.kind);
    if (list) list.push(entry);
    else {
      byKind.set(entry.kind, [entry]);
      order.push(entry.kind);
    }
  }

  const groups: BackupGroup[] = order.map((kind) => {
    const entries = byKind.get(kind) ?? [];
    const banks = [...new Set(entries.map((e) => e.bank).filter((b): b is string => b !== undefined))];
    banks.sort();
    return {
      kind,
      label: labelFor(kind),
      count: entries.length,
      banks,
      entries: actionable.includes(kind) ? entries : [],
    };
  });

  const firmware = backup.manifest.device.firmwareVersion;
  return {
    device: firmware ? `${backup.manifest.device.name} · firmware ${firmware}`
      : backup.manifest.device.name,
    taken: whenTaken(backup.manifest.taken),
    groups,
    warnings: warningsFor(backup),
    empty: groups.every((group) => group.entries.length === 0),
  };
}
