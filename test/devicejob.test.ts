/**
 * One job holds the instrument per page.
 *
 * The rule is small, and it only works if every long +Drive job uses it, so the second half of
 * this file checks the three that must: the backup, the erase, and the library panes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimDevice, deviceJob, deviceJobRefusal, onDeviceJobChange } from "../web/src/devicejob.js";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src");

test("a second job is refused while the first holds the instrument, and named", () => {
  const changes: (string | undefined)[] = [];
  const off = onDeviceJobChange(() => changes.push(deviceJob()));

  const release = claimDevice("A backup");
  assert.ok(release);
  assert.equal(claimDevice("The wavetable erase"), undefined, "the erase must wait for the backup");
  assert.equal(deviceJobRefusal(), "A backup is using the instrument. Try again when it finishes.");

  release();
  release(); // twice is harmless and must not release somebody else's claim
  const next = claimDevice("The library");
  assert.ok(next, "released, the instrument is free again");
  release(); // the old release must not free the library's claim
  assert.equal(deviceJob(), "The library");
  next();

  off();
  assert.deepEqual(changes, ["A backup", undefined, "The library", undefined]);
});

test("the backup, the erase and the library panes all take the instrument", () => {
  const source = (file: string): string => readFileSync(join(WEB_SRC, file), "utf8");
  assert.match(source("backupjob.ts"), /claimDevice\("A backup"\)/);
  assert.match(source("wavetableerase.ts"), /claimDevice\("The wavetable erase"\)/);
  assert.match(source("library/wavetables.ts"), /claimDevice\("The library"\)/);
  // And Settings draws from the page's holder, not from a flag of its own sheet.
  assert.match(source("settings.ts"), /onDeviceJobChange\(/);
});
