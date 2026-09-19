/**
 * A project's songs, as tabs and a table of rows.
 *
 * ## Why a panel of its own, beside the patterns
 *
 * A song is an arrangement **of patterns**, so the two have to be visible together: the question a
 * person asks of this panel is *"which pattern is row 7, and where is it in the grid"*. Putting the
 * songs behind a tab that replaces the pattern grid would answer that by making you remember.
 *
 * It lands in the main column below the grid because `main.split` is a two-column layout and a third
 * child flows to column 1, row 2 — full width, which a nine-column table needs and the 20rem side
 * column could never give it.
 *
 * ## Sixteen tabs, one per song
 *
 * The same `.tabs` / `.tab` markup the bank tabs use, so the gesture is the one already learned. A
 * tab shows its row count the way a bank tab shows its pattern count, which makes "which of these
 * sixteen has anything in it" answerable without clicking through all of them.
 *
 * ## Read-only, deliberately, for now
 *
 * `deviceproject.ts` says songs are "the one thing this project has always refused to risk", and a
 * song row references a pattern **by slot** — the reference a rearrangement invalidates. So this
 * shows before it touches. Editing needs a whole-project +Drive write, because the tail a song lives
 * in cannot go over the dump protocol at all.
 *
 * ## Everything here draws; nothing here decides
 *
 * Reading is `src/project/dn2song.ts`, which is pure and tested against hardware captures. This
 * module renders what it is handed, which is what lets it be tested without a browser.
 */

import { type Song, type SongRow, LABELS, LIMITS, mutedTracks } from "../../../src/project/dn2song.js";
import { patternName } from "../../../src/project/naming.js";

/**
 * The drag controller, reduced to what a song row needs.
 *
 * Structural rather than an import of `GridDrag`, the same way `DeviceIo` is a two-method view of a
 * MIDI port. `grid.ts` is a browser module — it iterates a `NodeList` — and importing it here would
 * drag the DOM's iterable lib into the Node typecheck that runs over this file's tests, for the sake
 * of one method.
 */
export interface RowDragBinder {
  bind(element: HTMLElement, grid: string, index: number): void;
}

/**
 * The drag "grid" a song row belongs to.
 *
 * `GridDrag` routes by name, so a song row is a third grid alongside patterns and tracks. Named here
 * rather than spelled as a string at each end: the manager compares against it in two places, and a
 * typo in either would make rows silently undroppable rather than raise anything.
 */
export const SONG_GRID = "song";

export interface SongTab {
  index: number;
  /** 1-based, as the device numbers them. */
  label: string;
  name: string;
  rowCount: number;
  selected: boolean;
}

/** What the tab strip should show, given every song in the project. */
export function songTabs(songs: readonly Song[], selected: number): SongTab[] {
  return songs.map((s) => ({
    index: s.index,
    label: String(s.index + 1),
    name: s.name,
    rowCount: s.rowCount,
    selected: s.index === selected,
  }));
}

/**
 * How a row's mutes read.
 *
 * Track numbers rather than a hex mask: somebody can check `T2, T3, T5` against the instrument and
 * cannot check `0x0016`. **`T`-prefixed** because that is what the manager's own track grid calls
 * them, and a bare `1` in a table of numbers reads as a count rather than a track.
 *
 * "none" rather than an empty cell, so an unmuted row is distinguishable from one this build failed
 * to read.
 */
export function describeMutes(row: SongRow): string {
  const tracks = mutedTracks(row);
  return tracks.length === 0 ? "none" : tracks.map((t) => `T${t}`).join(", ");
}

/** A label for display, falling back to the raw number for a value this build does not know. */
export function describeLabel(row: SongRow): string {
  return row.labelName ?? `? (${row.label})`;
}

/**
 * A one-line summary of a song, for the panel heading.
 *
 * Names the END behaviour, because a song that loops and one that stops are different pieces of
 * music and the difference is invisible in the row table.
 */
export function describeSong(song: Song): string {
  if (song.rowCount === 0) return `Song ${song.index + 1} — empty`;
  const name = song.name.trim() === "" ? "(unnamed)" : song.name;
  return (
    `Song ${song.index + 1} · ${name} · ${song.rowCount} row${song.rowCount === 1 ? "" : "s"} · ` +
    `${song.tempo} BPM · ends by ${song.loops ? "looping" : "stopping"}`
  );
}

export interface SongViewHooks {
  /** A tab was clicked. */
  onSelect: (index: number) => void;
}

/** The fields a row exposes for editing, all of them plain numbers. */
export type EditableField = "repeats" | "length" | "tempo" | "swing" | "label";

/** The song itself, as opposed to one of its rows. */
export interface SongLevelHooks {
  onRename: () => void;
  onToggleEnd: () => void;
  onClear: () => void;
  onTempo: (bpm: number) => void;
  /** Start a song in an empty slot: one action, not "add a row" followed by "and now name it". */
  onNewSong: () => void;
}

export interface SongEditHooks {
  /**
   * The name of the pattern in a slot, or `undefined` when it has none.
   *
   * Passed in rather than read here. This module draws and decides nothing — resolving a name means
   * summarising a pattern record, which is the librarian's job and needs the device.
   */
  patternNameFor: (slot: number) => string | undefined;
  /** So a row can be a drop target for a pattern, and a drag source for reordering. */
  drag: RowDragBinder;
  onField: (row: number, field: EditableField, value: number) => void;
  onInsert: (row: number) => void;
  onDelete: (row: number) => void;
  onMove: (from: number, to: number) => void;
  onToggleMute: (row: number, track: number) => void;
}

const cell = (text: string, className?: string): HTMLTableCellElement => {
  const td = document.createElement("td");
  // Every string here reaches the DOM through `textContent`. A song name and a pattern name both
  // come out of a project file, which is not ours and may contain anything.
  td.textContent = text;
  if (className) td.className = className;
  return td;
};

/** Draw the tab strip. */
export function renderSongTabs(host: HTMLElement, tabs: readonly SongTab[], hooks: SongViewHooks): void {
  host.textContent = "";
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.className = "tab";
    button.type = "button";
    button.setAttribute("aria-selected", String(tab.selected));
    button.append(document.createTextNode(tab.label));

    // The row count, the way a bank tab carries its pattern count — so "which of these sixteen
    // holds anything" is answerable without clicking through all of them.
    if (tab.rowCount > 0) {
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(tab.rowCount);
      button.append(n);
    }
    button.title = tab.name.trim() === ""
      ? `Song ${tab.label}${tab.rowCount ? ` — ${tab.rowCount} rows` : " — empty"}`
      : `Song ${tab.label} — ${tab.name}`;

    button.addEventListener("click", () => hooks.onSelect(tab.index));
    host.append(button);
  }
}

const COLUMNS = ["Row", "Pattern", "Label", "Plays", "Length", "Tempo", "Swing", "Mutes", ""] as const;

/**
 * The pattern a row plays: its slot, then its name.
 *
 * `A5` alone is enough to find it in the grid and tells you nothing about what it *is*, which is the
 * question somebody reading an arrangement is actually asking. The two are styled apart so the slot
 * stays scannable down the column while the name reads as prose beside it.
 *
 * An unnamed pattern gets nothing rather than a placeholder — every factory pattern is unnamed, and
 * a column of "—" would be sixteen rows of noise.
 */
function patternCell(slot: number, name: string | undefined): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "ptn";

  const id = document.createElement("span");
  id.className = "ptnid";
  id.textContent = patternName(slot);
  td.append(id);

  if (name !== undefined && name.trim() !== "" && name !== "—") {
    const label = document.createElement("span");
    label.className = "ptnname";
    label.textContent = name;
    td.append(label);
  }
  return td;
}

/**
 * A number a person can type into.
 *
 * Committed on `change` rather than `input`, so an edit is one undo step when the field is left
 * rather than one per keystroke. Typing `135` through an `input` listener would be three steps, two
 * of them values nobody asked for.
 */
function numberCell(
  row: number,
  field: EditableField,
  value: number,
  range: { min: number; max: number },
  step: number,
  onCommit: (value: number) => void,
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "num";
  const input = document.createElement("input");
  input.type = "number";
  input.className = "rowedit";
  // Named so focus can be put back on the same control after the table is rebuilt. Editing a row
  // re-renders the whole song, which replaces every element in it — see `focusKey`.
  input.dataset["row"] = String(row);
  input.dataset["field"] = field;
  input.value = String(value);
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(step);
  input.addEventListener("change", () => {
    const next = Number(input.value);
    // Reverted rather than sent: the operations refuse an out-of-range value, and letting that
    // round-trip would leave the box showing a number the project does not hold.
    if (!Number.isFinite(next) || next < range.min || next > range.max) {
      input.value = String(value);
      return;
    }
    if (next !== value) onCommit(next);
  });
  td.append(input);
  return td;
}

/** The label picker, offering exactly the vocabulary the device offers. */
function labelCell(rowIndex: number, row: SongRow, onCommit: (value: number) => void): HTMLTableCellElement {
  const td = document.createElement("td");
  const select = document.createElement("select");
  select.className = "rowedit";
  select.dataset["row"] = String(rowIndex);
  select.dataset["field"] = "label";
  for (const [i, name] of LABELS.entries()) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = name;
    option.selected = i === row.label;
    select.append(option);
  }
  // A label this build does not know still has to be shown as itself, rather than silently
  // becoming (EMPTY) the moment the row is drawn.
  if (LABELS[row.label] === undefined) {
    const option = document.createElement("option");
    option.value = String(row.label);
    option.textContent = describeLabel(row);
    option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => onCommit(Number(select.value)));
  td.append(select);
  return td;
}

/**
 * The sixteen mute toggles.
 *
 * Chips rather than a text field, because a mute mask is sixteen independent facts and typing
 * `2, 3, 5` would need parsing, validating and explaining. Clicking a numbered chip needs none of
 * that, and it matches the instrument, where muting a track is pressing its [TRIG] key.
 */
function muteCell(row: SongRow, rowIndex: number, hooks: SongEditHooks): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "mutes";
  for (let track = 1; track <= 16; track++) {
    const on = (row.mute & (1 << (track - 1))) !== 0;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = on ? "mutechip on" : "mutechip";
    chip.textContent = String(track);
    chip.title = `${on ? "Unmute" : "Mute"} track ${track} on row ${rowIndex + 1}`;
    chip.addEventListener("click", () => hooks.onToggleMute(rowIndex, track));
    td.append(chip);
  }
  return td;
}

/** Insert, delete and reorder, per row. */
function rowActions(rowIndex: number, song: Song, hooks: SongEditHooks): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "rowacts";
  const button = (text: string, title: string, enabled: boolean, run: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost tiny";
    b.textContent = text;
    b.title = title;
    b.disabled = !enabled;
    b.addEventListener("click", run);
    return b;
  };
  // **No up/down arrows.** Reordering is dragging, which the row already supports and which every
  // other grid in this app uses. Two ways to do one thing, one of them worse, is how a vocabulary
  // stops being a vocabulary.
  td.append(
    button("+", "Insert a copy of this row below it", song.rowCount < 99, () => hooks.onInsert(rowIndex)),
    button("\u2715", "Delete this row", true, () => hooks.onDelete(rowIndex)),
  );
  return td;
}

/**
 * Draw one song's rows.
 *
 * An empty song gets a sentence rather than an empty table: a table with headers and no rows reads
 * as a failure to load, and "this song has no rows" is a different fact.
 */
export function renderSongRows(host: HTMLElement, song: Song, hooks?: SongEditHooks): void {
  host.textContent = "";

  if (song.rowCount === 0) {
    // No "add the first row" button here. `renderSongControls` offers **New song…**, which makes
    // the row *and* names it — and an empty slot with two ways to start a song is the same fault as
    // the up/down arrows that reordering already had a gesture for.
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = hooks
      ? `Song ${song.index + 1} has no rows yet.`
      : `Song ${song.index + 1} has no rows. Build one on the instrument, in SONG mode.`;
    host.append(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "libtable songtable";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const c of COLUMNS) {
    const th = document.createElement("th");
    th.textContent = c;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const [i, row] of song.rows.entries()) {
    const tr = document.createElement("tr");
    tr.dataset["row"] = String(i);
    // The pattern always reads in the manager's own vocabulary — `A1`, `H16` — never a raw slot
    // number, so a row can be found in the grid above without arithmetic.
    if (hooks) {
      // The row is both a drop target for a pattern and a drag source for reordering, exactly as a
      // grid cell is. `GridDrag.bind` takes any element, which is why the table could gain the
      // gesture without inventing a second one.
      hooks.drag.bind(tr, SONG_GRID, i);
      tr.append(
        cell(String(i + 1), "num"),
        patternCell(row.pattern, hooks.patternNameFor(row.pattern)),
        labelCell(i, row, (value) => hooks.onField(i, "label", value)),
        numberCell(i, "repeats", row.repeats, LIMITS.repeats, 1, (v) => hooks.onField(i, "repeats", v)),
        numberCell(i, "length", row.length, LIMITS.length, 1, (v) => hooks.onField(i, "length", v)),
        numberCell(i, "tempo", row.tempo, LIMITS.tempo, 0.1, (v) => hooks.onField(i, "tempo", v)),
        numberCell(i, "swing", row.swing, LIMITS.swing, 1, (v) => hooks.onField(i, "swing", v)),
        muteCell(row, i, hooks),
        rowActions(i, song, hooks),
      );
    } else {
      tr.append(
        cell(String(i + 1), "num"),
        cell(patternName(row.pattern)),
        cell(describeLabel(row)),
        cell(`${row.repeats}x`, "num"),
        cell(String(row.length), "num"),
        cell(`${row.tempo}`, "num"),
        cell(`${row.swing}%`, "num"),
        cell(describeMutes(row), row.mute === 0 ? "dim" : ""),
        cell(""),
      );
    }
    tbody.append(tr);
  }
  table.append(tbody);

  const wrap = document.createElement("div");
  wrap.className = "libtablewrap";
  wrap.append(table);
  host.append(wrap);
}

/** Every label the device offers, for anything that needs the vocabulary. */
export const LABEL_NAMES = LABELS;

/**
 * Which editor a person is in, so it can be handed back after a re-render.
 *
 * Editing a field re-renders the song, which replaces every element in the table — so the input
 * being typed into stops existing, and focus falls to the document. **Bumping a number with the
 * arrow keys twice in a row was impossible**: the first press committed, the table was rebuilt, and
 * the second press went nowhere.
 *
 * Restoring focus by row and field rather than by element identity, because the element is gone. The
 * caret goes to the end, which is where a number input wants it.
 */
export function focusKey(): { row: string; field: string; selectionStart: number | null } | undefined {
  const active = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
  const row = active?.dataset?.["row"];
  const field = active?.dataset?.["field"];
  if (row === undefined || field === undefined) return undefined;
  return {
    row,
    field,
    selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
  };
}

/** Put focus back where `focusKey` found it, if that control still exists. */
export function restoreFocus(
  host: HTMLElement,
  key: { row: string; field: string; selectionStart: number | null } | undefined,
): void {
  if (!key) return;
  const selector = `[data-row="${key.row}"][data-field="${key.field}"]`;
  const target = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!target) return;
  target.focus();
  if (target instanceof HTMLInputElement && key.selectionStart !== null) {
    // `setSelectionRange` throws on a number input in some browsers, and a lost caret is a far
    // smaller problem than a thrown error mid-render.
    try {
      target.setSelectionRange(key.selectionStart, key.selectionStart);
    } catch {
      /* the caret is a nicety; focus is the point */
    }
  }
}

/**
 * The controls that act on the song rather than on a row.
 *
 * In the body beside the tabs, **not in the heading** — the heading is itself a button, and putting
 * controls inside it would nest interactive elements and make the fold target unpredictable.
 *
 * These were implemented and tested in `songedit.ts` for a whole release before anything could
 * reach them. A song could gain rows but never a name, which made a new song feel broken in a way
 * the row editing never did.
 */
export function renderSongControls(
  host: HTMLElement,
  song: Song,
  hooks: SongLevelHooks,
): void {
  host.textContent = "";

  const button = (text: string, title: string, run: () => void, cls = "btn"): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", run);
    return b;
  };

  if (song.rowCount === 0) {
    // An empty slot has nothing to rename, loop or clear. Offering those would be four disabled
    // controls where one enabled one is the whole story.
    host.append(button("New song…", `Start song ${song.index + 1} with one row and a name`, hooks.onNewSong));
    return;
  }

  host.append(
    button("Rename…", "Rename this song", hooks.onRename),
    // The label says what the song does now, and pressing it changes that. A button reading "Stop"
    // on a song that stops would be ambiguous about whether it describes or commands.
    button(
      song.loops ? "Ends: loop" : "Ends: stop",
      song.loops ? "Ends by looping — press to make it stop" : "Ends by stopping — press to make it loop",
      hooks.onToggleEnd,
    ),
  );

  const tempo = document.createElement("label");
  tempo.className = "songtempo";
  tempo.append(document.createTextNode("Song BPM"));
  const input = document.createElement("input");
  input.type = "number";
  input.className = "rowedit";
  input.value = String(song.tempo);
  input.min = String(LIMITS.tempo.min);
  input.max = String(LIMITS.tempo.max);
  input.step = "0.1";
  input.dataset["row"] = "song";
  input.dataset["field"] = "tempo";
  input.title =
    "The song's own tempo. The manual: setting it overrides all previously set row and pattern tempos.";
  input.addEventListener("change", () => {
    const next = Number(input.value);
    if (!Number.isFinite(next) || next < LIMITS.tempo.min || next > LIMITS.tempo.max) {
      input.value = String(song.tempo);
      return;
    }
    if (next !== song.tempo) hooks.onTempo(next);
  });
  tempo.append(input);
  host.append(tempo);

  // Last, and marked, because it is the only one here that destroys work and the only one a
  // re-drag cannot rebuild.
  host.append(button("Clear song", "Empty this song slot", hooks.onClear, "btn danger"));
}

/**
 * Bring a row into view inside the table's own scroll area.
 *
 * The row list scrolls inside a fixed-height wrapper, so a song longer than about nine rows has a
 * bottom you cannot see. Inserting from the last visible row put the new row **below the fold**: the
 * count rose and the card grew to its clamp, but nothing appeared to happen — reported as *"it adds
 * rows as the card grows but no actual rows are visible"*.
 *
 * Called after any edit that adds or moves a row, so the row you just acted on is the row you can
 * see. `nearest` rather than `center`, because scrolling a row that was already visible would make
 * every field edit jump the table under the cursor.
 */
export function revealRow(host: HTMLElement, row: number): void {
  const target = host.querySelector<HTMLElement>(`tbody tr[data-row="${row}"]`);
  // `scrollIntoView` on an element inside a scrollable ancestor moves that ancestor, not the page,
  // as long as the block is `nearest`.
  target?.scrollIntoView({ block: "nearest" });
}
