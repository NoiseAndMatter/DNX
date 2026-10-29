/**
 * The device settings backup: the header out of a devslots file, the settings file, and the table.
 *
 * The headers are written byte by byte here, at the offsets the firmware side measured, so a wrong
 * offset in the module cannot agree with itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type CapturedFile } from "@noiseandmatter/dnx-core/device/devslots.js";
import {
  SETTING_FIELDS,
  SettingsFileError,
  checksumMatches,
  fieldValue,
  otherDifferences,
  readSettingsFile,
  savedMatchesRunning,
  settingsFileName,
  settingsFromCapture,
} from "@noiseandmatter/dnx-core/device/devsettings.js";

/** A 256-byte header with the magic, the build and the device name, and the given bytes. */
function header(set: Record<number, number>, active = true): Uint8Array {
  const h = new Uint8Array(256);
  h.set([...(active ? "COKi" : "\0OKi")].map((c) => c.charCodeAt(0)), 0);
  h.set([0x0d, 0x6f, 0x57, 0xe8], 4);
  h[0x0b] = 6;
  h.set([..."0059"].map((c) => c.charCodeAt(0)), 0x10);
  h.set([..."Digitone II"].map((c) => c.charCodeAt(0)), 0x1c);
  for (const [at, value] of Object.entries(set)) h[Number(at)] = value;
  return h;
}

/** The file the route serves: 31 bytes of container, 272 of body, 12 of trailer. */
function served(path: string, body: Uint8Array): CapturedFile {
  const bytes = new Uint8Array(31 + 272 + 12);
  bytes.set(body, 31);
  return { path, bytes, ms: 10, closed: true };
}

const SOURCE = { taken: new Date(2026, 9, 29, 14, 7), dnx: "test", instrument: { name: "Digitone II", os: "1.11" } };

const option = (name: string) => {
  const field = SETTING_FIELDS.find((f) => f.option.endsWith(name));
  assert.ok(field, name);
  return field;
};

test("the backup keeps the running header, and the slots beside it", () => {
  const ram = header({ 0x3c: 2, 0x3d: 0x1c, 0x3f: 1 });
  const file = settingsFromCapture([
    served("/modinfo/0", new Uint8Array(272)),
    served("/devslots/0", ram),
    served("/devslots/1", header({}, false)),
    served("/devslots/2", ram),
  ], SOURCE);
  assert.equal(file.osBuild, "0059");
  assert.equal(file.header.length, 512);
  assert.equal(file.header.slice(0x3c * 2, 0x40 * 2), "021c0001");
  assert.deepEqual(file.slots.map((s) => s.name), ["slot-40000", "slot-48000"]);
  assert.equal(savedMatchesRunning(file), true);

  const back = readSettingsFile(JSON.stringify(file));
  assert.equal(fieldValue(back.header, option("USB CONFIG")).text, "USB AUDIO/MIDI");
  assert.equal(fieldValue(back.header, option("LED INTENSITY")).text, "MID");
  assert.equal(fieldValue(back.header, option("Current project slot")).text, "29");
});

test("a running header the active slot does not hold is said", () => {
  const file = settingsFromCapture([
    served("/devslots/0", header({ 0x45: 0 })),
    served("/devslots/1", header({}, false)),
    served("/devslots/2", header({ 0x45: 1 })),
  ], SOURCE);
  assert.equal(savedMatchesRunning(file), false);
});

test("no RAM header refuses the backup", () => {
  assert.throws(
    () => settingsFromCapture([served("/devslots/2", header({}, false))], SOURCE),
    SettingsFileError,
  );
});

test("a value nobody measured is shown as a number, and a long field as its bytes", () => {
  const h = header({ 0x3f: 2, 0x40: 0x12, 0x41: 0x34 });
  assert.equal(fieldValue(h, option("LED INTENSITY")).text, "2 (not named yet)");
  assert.equal(fieldValue(h, option("MASTER TUNE (probably, not checked)")).raw, "12340000");
});

test("differences outside the table are grouped by the header part they sit in", () => {
  const a = header({ 0x46: 0 });
  const b = header({ 0x46: 1, 0x05: 0x00, 0x07: 0x01, 0x90: 3 });
  const other = otherDifferences(a, b);
  assert.deepEqual(other.map((d) => [d.offset, d.name]), [[0x04, "Checksum"], [0x90, "Not named yet"]]);
  assert.deepEqual(other[0]!.raw, ["0d6f57e8", "0d005701"]);
});

test("a file that is not a settings file, or a damaged one, is refused", () => {
  assert.throws(() => readSettingsFile("not json"), /not a settings file/);
  assert.throws(() => readSettingsFile(JSON.stringify({ kind: "other" })), /not a settings file/);
  assert.throws(
    () => readSettingsFile(JSON.stringify({ kind: "dn2-device-settings", version: 1, header: "00" })),
    /damaged/,
  );
});

test("the file name carries the local time and the OS build", () => {
  assert.equal(settingsFileName(new Date(2026, 9, 29, 14, 7), "0059"), "dn2-settings_20261029-1407_0059.json");
});

test("the checksum: a header whose words sum to it matches, and a changed setting does not", () => {
  // Words from +0x08, each XORed with its number from 1, summed by hand: the format version word
  // 0x00000006 ^ 1 = 7, the length word 0x00000042 ^ 2 = 0x40, and 16 zero words ^ 3..18.
  const h = header({});
  h.fill(0, 0x10, 0x50);
  h[0x0f] = 0x42;
  let rest = 0;
  for (let i = 3; i <= 18; i++) rest += i;
  const sum = 7 + 0x40 + rest;
  h.set([0, 0, (sum >> 8) & 0xff, sum & 0xff], 4);
  assert.equal(checksumMatches(h), true);
  h[0x45] = 1;
  assert.equal(checksumMatches(h), false);
  h[0x45] = 0;
  h[0x50] = 1;
  assert.equal(checksumMatches(h), true, "+0x50 is outside the sum");
});

test("the mod toggles are named past stock's record", () => {
  const h = header({ 0x52: 1 });
  assert.equal(fieldValue(h, option("Mod toggle (reloadconfirm)")).text, "ON");
  assert.equal(fieldValue(h, option("Mod toggle (arpscale)")).text, "OFF");
});
