/**
 * The instrument's own settings (PERSONALIZE, USB CONFIG and the like), from the saved state header.
 *
 * **One job: turn the header a diagnostic build serves into a settings file, read one back, and
 * say what each byte means.** The read is `devslots.ts`. The page that saves and shows is
 * `web/src/devsettings.ts`.
 *
 * ## Where the settings live
 *
 * In the first 256 bytes of the saved working state, which sits in two raw eMMC slots outside the
 * file system. Stock firmware has no route to them. Diagnostic builds serve the first 272 bytes of
 * each slot as `/devslots/0` and `/1`, and the running copy in RAM as `/devslots/2`. Each comes in
 * the transfer container, so header offset N is file offset 31 + N.
 *
 * The map is the firmware side's, measured on stock 1.11 (OS build 0059) on 2026-10-29: an
 * emulator write-watch, with a screen capture after each change. An option not in the table is
 * shown as a raw byte. Where the manual lists more values than were measured (TRK SELECT has four,
 * NOTE PREVIEW three), only the measured ones are named.
 *
 * ## Not in the header
 *
 * The rest of MIDI CONFIG. Only CLOCK RECEIVE (+0x3e) is here. CLOCK SEND, TRANSPORT and PROG CH
 * are in the working project's settings block, so a project backup keeps them. The page says so.
 *
 * ## No restore
 *
 * A slot holds the whole 12.9 MB state, and a bad slot affects boot. A write is new firmware code
 * that calls stock's setters. Until then a restore is the values, shown, to set by hand.
 */

import { type CapturedFile, DEVSLOTS_FILES, devslotsPath } from "./devslots.js";

/** The transfer container's header. The body starts here. */
const CONTAINER_HEADER = 31;

/** The settings header. */
export const SETTINGS_HEADER_BYTES = 256;

/** `/devslots/2`: the copy the instrument is running. The backup is this one. */
export const RAM_FILE = 2;

/** The slots, `/devslots/0` and `/1`, kept beside it. */
export const SLOT_FILES = [0, 1] as const;

/** The files a settings backup reads. */
export const SETTINGS_FILES: readonly number[] = [...SLOT_FILES, RAM_FILE];

/** The OS build the map was measured on (1.11). */
export const MAPPED_OS_BUILD = "0059";

const MAGIC = "COKi";

export class SettingsFileError extends Error {}

/** One option the header holds, with the values that were seen on screen. */
export interface SettingField {
  offset: number;
  /** The menu path, as the instrument shows it. */
  option: string;
  /** Measured values. Any other value is shown as a number. */
  values?: Readonly<Record<number, string>>;
  /** Bytes, little-endian. 1 when not given. */
  length?: number;
  /** Not something a person sets: shown, never listed as a step. */
  info?: boolean;
  /** Counted from 0 in the byte, from 1 on the screen. */
  fromOne?: boolean;
}

const OFF_ON = { 0: "OFF", 1: "ON" } as const;

/**
 * In the instrument's menu order, so a person setting them by hand goes down the list once.
 * SYSTEM first, then CLOCK RECEIVE, then PERSONALIZE as the manual orders it (OS 1.10D, 13.7).
 */
export const SETTING_FIELDS: readonly SettingField[] = [
  { offset: 0x3c, option: "SYSTEM > USB CONFIG", values: { 0: "USB MIDI", 1: "OVERBRIDGE", 2: "USB AUDIO/MIDI" } },
  { offset: 0x40, option: "SYSTEM > MASTER TUNE (probably, not checked)", length: 4 },
  { offset: 0x3e, option: "MIDI CONFIG > SYNC > CLOCK RECEIVE", values: OFF_ON },
  { offset: 0x3f, option: "PERSONALIZE > LED INTENSITY", values: { 0: "LOW", 1: "MID" } },
  { offset: 0x45, option: "PERSONALIZE > LED BACKLIGHT", values: OFF_ON },
  { offset: 0x44, option: "PERSONALIZE > REMEMBER SUBPAGE", values: OFF_ON },
  { offset: 0x46, option: "PERSONALIZE > U/D KEY MODE", values: { 0: "KB OCT", 1: "NAV" } },
  { offset: 0x47, option: "PERSONALIZE > PAGE AUTOCOPY", values: OFF_ON },
  { offset: 0x48, option: "PERSONALIZE > NOTE PARAM", values: { 0: "CHRO", 1: "SCALE" } },
  { offset: 0x4a, option: "PERSONALIZE > LIVE REC OVERDUB", values: OFF_ON },
  { offset: 0x4b, option: "PERSONALIZE > PARAM LIVE REC", values: { 0: "ALL", 1: "TRIG" } },
  { offset: 0x4d, option: "PERSONALIZE > TRK SELECT", values: { 0: "NORMAL", 1: "SILENT" } },
  { offset: 0x4e, option: "PERSONALIZE > NOTE PREVIEW", values: { 0: "ALWAYS", 1: "PAUSED" } },
  { offset: 0x50, option: "PERSONALIZE > NOTE EDIT MENU", values: { 0: "ANY", 1: "REC" } },
  { offset: 0x3d, option: "Current project slot", info: true, fromOne: true },
  ...[0x49, 0x4c, 0x4f, 0x51].map((offset) => ({
    offset,
    option: "Not named yet",
    info: true,
  })),
  // Past stock's record (+0x00..+0x51): no stock 1.10E, 1.11 or 1.12 instruction reads them.
  { offset: 0x52, option: "Mod toggle (reloadconfirm)", values: OFF_ON },
  { offset: 0x53, option: "Mod toggle (arpscale)", values: OFF_ON },
];

/** The rest of the header, for naming a byte that differs outside the table. */
const HEADER_PARTS: readonly { offset: number; length: number; name: string }[] = [
  { offset: 0x00, length: 4, name: "Magic" },
  { offset: 0x04, length: 4, name: "Checksum" },
  { offset: 0x08, length: 4, name: "Format version" },
  { offset: 0x0c, length: 4, name: "Payload length" },
  { offset: 0x10, length: 4, name: "OS build" },
  { offset: 0x1c, length: 12, name: "Device name" },
];

/** The settings header in a devslots file, or undefined when the file is too short. */
export function headerOf(file: Uint8Array): Uint8Array | undefined {
  if (file.length < CONTAINER_HEADER + SETTINGS_HEADER_BYTES) return undefined;
  return file.slice(CONTAINER_HEADER, CONTAINER_HEADER + SETTINGS_HEADER_BYTES);
}

/** Whether a header starts with `COKi`. A slot the last save retired has its `C` zeroed. */
export function isActive(header: Uint8Array): boolean {
  return ascii(header, 0, 4) === MAGIC;
}

/** The OS build at +0x10, as four ASCII digits. */
export function osBuildOf(header: Uint8Array): string {
  return ascii(header, 0x10, 4);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length)).replace(/\0+$/, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) return undefined;
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/**
 * Whether the checksum at +0x04 matches: the sum of each big-endian word from +0x08 to +0x4f,
 * XORed with its number counted from 1. Stock 1.11's routine at 0x400bb34c, read by the firmware
 * side, and checked here against the unit's slot and RAM headers of 2026-10-29. It does not cover
 * +0x50 onwards, so NOTE EDIT MENU and the mod toggles can change without it.
 */
export function checksumMatches(header: Uint8Array): boolean {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let sum = 0;
  for (let i = 1; i <= 18; i++) sum = (sum + ((view.getUint32(0x08 + 4 * (i - 1)) ^ i) >>> 0)) >>> 0;
  return sum === view.getUint32(0x04);
}

/** What a settings file holds. */
export interface SettingsFile {
  kind: "dn2-device-settings";
  version: 1;
  /** ISO 8601. */
  taken: string;
  dnx: string;
  instrument: { name: string; os: string | null };
  osBuild: string;
  /** The running header, `/devslots/2`, as hex. */
  header: string;
  /** Each slot's header as hex, or null when the read gave too little. */
  slots: { file: number; name: string; header: string | null }[];
}

export interface SettingsSource {
  taken: Date;
  dnx: string;
  instrument: { name: string; os: string | null };
}

/** The settings file from a capture of `SETTINGS_FILES`. Throws when the RAM header is not there. */
export function settingsFromCapture(files: readonly CapturedFile[], source: SettingsSource): SettingsFile {
  const at = (file: number): Uint8Array | undefined =>
    files.find((f) => f.path === devslotsPath(file))?.bytes;
  const ramFile = at(RAM_FILE);
  const ram = ramFile && headerOf(ramFile);
  if (!ram || !isActive(ram)) {
    throw new SettingsFileError(`${devslotsPath(RAM_FILE)} did not hold a settings header.`);
  }
  return {
    kind: "dn2-device-settings",
    version: 1,
    taken: source.taken.toISOString(),
    dnx: source.dnx,
    instrument: source.instrument,
    osBuild: osBuildOf(ram),
    header: hex(ram),
    slots: SLOT_FILES.map((file) => {
      const bytes = at(file);
      const header = bytes && headerOf(bytes);
      return {
        file,
        name: DEVSLOTS_FILES.find((f) => f.file === file)?.name ?? String(file),
        header: header ? hex(header) : null,
      };
    }),
  };
}

/** `dn2-settings_20261029-1412_0059.json`, in local time. */
export function settingsFileName(taken: Date, osBuild: string): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${taken.getFullYear()}${two(taken.getMonth() + 1)}${two(taken.getDate())}-` +
    `${two(taken.getHours())}${two(taken.getMinutes())}`;
  return `dn2-settings_${stamp}_${osBuild.replace(/[^0-9A-Za-z]/g, "") || "unknown"}.json`;
}

/** A settings file read back, checked. */
export interface ReadSettings {
  file: SettingsFile;
  header: Uint8Array;
}

/** Reads a settings file. Throws `SettingsFileError` on anything that is not one. */
export function readSettingsFile(text: string): ReadSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsFileError("This is not a settings file.");
  }
  const file = parsed as Partial<SettingsFile> | null;
  if (file?.kind !== "dn2-device-settings" || file.version !== 1 || typeof file.header !== "string") {
    throw new SettingsFileError("This is not a settings file.");
  }
  const header = unhex(file.header);
  if (!header || header.length !== SETTINGS_HEADER_BYTES || !isActive(header)) {
    throw new SettingsFileError("This settings file is damaged.");
  }
  return { file: file as SettingsFile, header };
}

/**
 * The running header against the slot the instrument would start from. Different means the
 * running settings are not saved yet, or the save went to a slot read before it. Undefined when
 * no slot is active.
 */
export function savedMatchesRunning(file: SettingsFile): boolean | undefined {
  const active = file.slots
    .map((slot) => (slot.header === null ? undefined : unhex(slot.header)))
    .find((header) => header !== undefined && isActive(header));
  return active === undefined ? undefined : hex(active) === file.header;
}

/** One field's value: as the menu shows it, and as the bytes are. */
export interface FieldValue {
  text: string;
  raw: string;
}

export function fieldValue(header: Uint8Array, field: SettingField): FieldValue {
  const length = field.length ?? 1;
  const bytes = header.subarray(field.offset, field.offset + length);
  const raw = hex(bytes);
  if (length > 1) return { text: raw, raw };
  const value = bytes[0] ?? 0;
  // 0xff in the slot byte: an emulator with an empty card, with no project loaded.
  if (field.fromOne && value === 0xff) return { text: raw, raw };
  if (field.info) return { text: String(field.fromOne ? value + 1 : value), raw };
  const name = field.values?.[value];
  return { text: name ?? `${value} (not named yet)`, raw };
}

/** A byte run outside the table that differs between two headers. */
export interface OtherDifference {
  offset: number;
  length: number;
  name: string;
  raw: [string, string];
}

/** Whether a field differs between two headers. */
export function fieldDiffers(a: Uint8Array, b: Uint8Array, field: SettingField): boolean {
  return fieldValue(a, field).raw !== fieldValue(b, field).raw;
}

/** The bytes that differ and the table does not cover, grouped by the header part they sit in. */
export function otherDifferences(a: Uint8Array, b: Uint8Array): OtherDifference[] {
  const covered = new Set<number>();
  for (const field of SETTING_FIELDS) {
    for (let i = 0; i < (field.length ?? 1); i++) covered.add(field.offset + i);
  }
  const found: OtherDifference[] = [];
  for (let offset = 0; offset < SETTINGS_HEADER_BYTES; offset++) {
    if (covered.has(offset) || a[offset] === b[offset]) continue;
    const part = HEADER_PARTS.find((p) => offset >= p.offset && offset < p.offset + p.length);
    const start = part?.offset ?? offset;
    const length = part?.length ?? 1;
    if (found.some((d) => d.offset === start)) continue;
    found.push({
      offset: start,
      length,
      name: part?.name ?? "Not named yet",
      raw: [hex(a.subarray(start, start + length)), hex(b.subarray(start, start + length))],
    });
  }
  return found;
}

/** `+0x3c`, the way the firmware side writes an offset. */
export function offsetLabel(offset: number): string {
  return `+0x${offset.toString(16).padStart(2, "0")}`;
}
