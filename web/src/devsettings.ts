/**
 * Back up the instrument's own settings, and show or compare settings files.
 *
 * Two rows in the hidden Diagnostics group (`devslotscapture.ts` registers them), because the read
 * needs a diagnostic build: stock firmware has no route to the saved state header.
 *
 * - **Back up** reads `/devslots/0`, `/1` and `/2`, saves the running header as a settings file in
 *   the Backups folder, and shows it.
 * - **Show or compare** opens one settings file and shows it, or two side by side with the
 *   differing rows marked. The firmware side found a reported unit's settings that way.
 *
 * **No restore.** The table is what somebody sets by hand. Why: `device/devsettings.ts`.
 */

import { captureDevslots } from "@noiseandmatter/dnx-core/device/devslots.js";
import {
  MAPPED_OS_BUILD,
  checksumMatches,
  SETTING_FIELDS,
  SETTINGS_FILES,
  type ReadSettings,
  fieldDiffers,
  fieldValue,
  offsetLabel,
  otherDifferences,
  readSettingsFile,
  savedMatchesRunning,
  settingsFileName,
  settingsFromCapture,
} from "@noiseandmatter/dnx-core/device/devsettings.js";
import { type ConnectedDevice } from "./devicesource.js";
import { claimDevice, deviceJobRefusal } from "./devicejob.js";
import { showContent } from "./dialog.js";
import { saveFile, whereSaved } from "./dnxfolder.js";
import { connectInstrument } from "./instrument.js";
import { pageMessageIds } from "./messageids.js";
import { foreignReplyCount } from "./othertraffic.js";
import { row } from "./formrow.js";
import { type BackupRunner, type DiagnosticsJobs } from "./settings.js";
import { DNX_BUILD } from "./version.js";

const PORT_IN_USE =
  "Another application is using the instrument's MIDI port. Close Elektron Transfer and " +
  "Overbridge, then try again.";

const WITH_PROJECT = "The rest of MIDI CONFIG is saved with the project.";
const BY_HAND = "To restore, set each value on the instrument by hand.";

/** One file in the view: what the column is called, and its header. */
interface Column {
  label: string;
  read: ReadSettings;
}

/** The table: one row per option, one value column per file. */
function settingsTable(columns: readonly Column[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "settable";
  const compare = columns.length === 2;

  const head = table.createTHead().insertRow();
  for (const title of ["", "Option", "Offset", ...columns.map((c) => c.label)]) {
    const th = document.createElement("th");
    th.textContent = title;
    head.append(th);
  }

  const body = table.createTBody();
  const add = (cells: readonly string[], className: string, differs: boolean): void => {
    const tr = body.insertRow();
    tr.className = className;
    if (differs) tr.classList.add("differs");
    const mark = tr.insertCell();
    mark.className = "mark";
    if (differs) mark.setAttribute("aria-label", "differs");
    cells.forEach((text, index) => {
      const td = tr.insertCell();
      td.textContent = text;
      if (index === 1) td.className = "off";
    });
  };

  for (const field of SETTING_FIELDS) {
    const values = columns.map((c) => fieldValue(c.read.header, field));
    const differs = compare && fieldDiffers(columns[0]!.read.header, columns[1]!.read.header, field);
    add(
      [field.option, offsetLabel(field.offset), ...values.map((v) =>
        v.text === v.raw ? v.raw : `${v.text} (${v.raw})`)],
      field.info ? "info" : "",
      differs,
    );
  }
  if (compare) {
    for (const other of otherDifferences(columns[0]!.read.header, columns[1]!.read.header)) {
      add([other.name, offsetLabel(other.offset), ...other.raw], "info", true);
    }
  }

  const wrap = document.createElement("div");
  wrap.className = "settable-wrap";
  wrap.append(table);
  return wrap;
}

/** The whole header as hex, 16 bytes a line, for whoever needs a byte the table does not name. */
function rawDump(columns: readonly Column[]): HTMLElement {
  const details = document.createElement("details");
  details.className = "setraw";
  const summary = document.createElement("summary");
  summary.textContent = "All 256 bytes";
  details.append(summary);
  for (const column of columns) {
    const pre = document.createElement("pre");
    const lines = [column.label];
    for (let at = 0; at < column.read.header.length; at += 16) {
      const bytes = [...column.read.header.subarray(at, at + 16)]
        .map((b) => b.toString(16).padStart(2, "0")).join(" ");
      lines.push(`${offsetLabel(at).padEnd(6)} ${bytes}`);
    }
    pre.textContent = lines.join("\n");
    details.append(pre);
  }
  return details;
}

/** The sentences above the table: what it does not hold, and what to check. */
function notes(columns: readonly Column[]): string[] {
  const said = [WITH_PROJECT, BY_HAND];
  for (const column of columns) {
    const { file } = column.read;
    if (file.osBuild !== MAPPED_OS_BUILD) {
      said.push(
        `${column.label} is from OS build ${file.osBuild}. The offsets were measured on build ` +
          `${MAPPED_OS_BUILD}, so some values can be wrong.`,
      );
    }
    if (!checksumMatches(column.read.header)) {
      said.push(`In ${column.label}, the checksum at +0x04 does not match the header.`);
    }
    if (savedMatchesRunning(file) === false) {
      said.push(`In ${column.label}, the running settings differ from the copy the instrument starts from.`);
    }
  }
  if (columns.length === 2) {
    const count = SETTING_FIELDS.filter((field) =>
      fieldDiffers(columns[0]!.read.header, columns[1]!.read.header, field)).length;
    said.push(count === 0 ? "No option differs." : count === 1 ? "1 option differs." : `${count} options differ.`);
  }
  return said;
}

function show(columns: readonly Column[]): Promise<void> {
  const content = document.createElement("div");
  content.append(settingsTable(columns), rawDump(columns));
  return showContent({
    title: columns.length === 2 ? "Device settings, compared" : "Device settings",
    body: notes(columns),
    content,
    wide: true,
  });
}

function backupJob(): BackupRunner {
  return async (report) => {
    const release = claimDevice("A settings backup");
    if (!release) {
      report.say(deviceJobRefusal());
      return;
    }
    let device: ConnectedDevice | undefined;
    const foreignBefore = foreignReplyCount();
    let shown: ReadSettings | undefined;
    let name = "";
    try {
      report.say("Looking for an instrument…");
      device = await connectInstrument((message) => report.say(message));
      report.say("Checking the firmware…");
      const captured = await captureDevslots({
        transport: device.api,
        ids: pageMessageIds,
        files: SETTINGS_FILES,
        onFile: (path) => report.say(`Reading ${path}…`),
      });
      const taken = new Date();
      const file = settingsFromCapture(captured, {
        taken,
        dnx: DNX_BUILD,
        instrument: { name: device.name, os: device.firmwareVersion ?? null },
      });
      const text = JSON.stringify(file, null, 2) + "\n";
      name = settingsFileName(taken, file.osBuild);
      const saved = await saveFile(new Blob([text], { type: "application/json" }), name, "backups");
      shown = readSettingsFile(text);
      report.say(`Saved: ${whereSaved(saved)}`);
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      report.say(foreignReplyCount() > foreignBefore ? `${PORT_IN_USE} (${said})` : said);
    } finally {
      device?.close();
      release();
    }
    // After the port is let go: the dialog can stay open as long as somebody reads it.
    if (shown) await show([{ label: name, read: shown }]);
  };
}

function compareJob(files: readonly File[]): BackupRunner {
  return async (report) => {
    if (files.length === 0) return;
    if (files.length > 2) {
      report.say("Choose one settings file to show, or two to compare.");
      return;
    }
    const columns: Column[] = [];
    for (const file of files) {
      try {
        columns.push({ label: file.name, read: readSettingsFile(await file.text()) });
      } catch (error) {
        report.say(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    await show(columns);
  };
}

/** The two rows. */
export function settingsRows(jobs: DiagnosticsJobs): HTMLElement[] {
  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "act";
  backup.id = "devsettingsBackup";
  backup.textContent = "Back up";
  backup.addEventListener("click", () => jobs.start(backupJob()));
  jobs.track(backup);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.multiple = true;
  picker.hidden = true;
  picker.id = "devsettingsFiles";
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])];
    picker.value = "";
    jobs.start(compareJob(files));
  });
  const open = document.createElement("button");
  open.type = "button";
  open.className = "act";
  open.id = "devsettingsOpen";
  open.textContent = "Open…";
  open.addEventListener("click", () => picker.click());
  const holder = document.createElement("span");
  holder.append(open, picker);

  return [
    row(
      "Back up the device settings",
      "Needs the diagnostics firmware. Saves PERSONALIZE, USB CONFIG and CLOCK RECEIVE to a " +
        "file in Backups. The rest of MIDI CONFIG is saved with the project. Nothing on the " +
        "instrument is changed.",
      backup,
    ),
    row(
      "Show or compare settings",
      "Choose one settings file to show it, or two to compare them. To restore, set the values on " +
        "the instrument by hand.",
      holder,
    ),
  ];
}
