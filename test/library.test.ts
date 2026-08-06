/**
 * The +Drive library listing.
 *
 * Checked against a **real capture** rather than a synthetic listing, because the shape of an entry
 * is the thing most likely to be wrong and a fixture built from our own reader would agree with our
 * own reader by construction.
 *
 * `API_10msg_2355.syx` is a probe session on a Digitone II that includes a kit bank holding 14 saved
 * kits — which is exactly the interesting case: occupied and empty entries side by side, with
 * different permission masks.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";
import { decodeMessage } from "../src/device/api.js";
import { parseListing } from "../src/device/storage.js";
import { BANKS, BANK_SIZE, LIBRARY_ROOT, bankPath, describeBank, slotPath } from "../src/device/library.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

test("paths are built the way the device addresses them", () => {
  assert.equal(bankPath("preset", "A"), "/soundbanks/A");
  assert.equal(bankPath("kit", "A"), "/kits/A");
  // The last segment is the index from a listing, never the name — the mistake that produced
  // `invalid project id` and was read three ways before being understood.
  assert.equal(slotPath("kit", "A", 1), "/kits/A/1");
  assert.equal(slotPath("preset", "H", 256), "/soundbanks/H/256");
});

test("the two collections have the sizes the instrument reported", () => {
  // Not guesses: /soundbanks/A listed 256 entries and /kits/A listed 128, both on hardware.
  assert.equal(BANK_SIZE.preset, 256);
  assert.equal(BANK_SIZE.kit, 128);
  assert.equal(BANKS.length, 8);
  assert.equal(2048, BANK_SIZE.preset * BANKS.length, "the manual's 2,048 presets");
  assert.equal(1024, BANK_SIZE.kit * BANKS.length);
  assert.equal(LIBRARY_ROOT.preset, "/soundbanks");
  assert.equal(LIBRARY_ROOT.kit, "/kits");
});

test("a captured kit bank decodes to occupied and empty entries", { skip }, () => {
  const bytes = new Uint8Array(
    readFileSync(join(CORPUS!, "..", "99_HardwareTest", "API_10msg_2355.syx")),
  );
  const msgs: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const s = bytes.indexOf(0xf0, at);
    if (s === -1) break;
    const e = bytes.indexOf(0xf7, s);
    if (e === -1) break;
    msgs.push(bytes.subarray(s, e + 1));
    at = e + 1;
  }
  // The last message of that session is the kit bank with 14 kits saved in it.
  const entries = parseListing(decodeMessage(msgs[msgs.length - 1]!).body).entries;

  assert.equal(entries.length, BANK_SIZE.kit, "a kit bank holds 128 slots");
  const occupied = entries.filter((e) => e.occupied);
  assert.equal(occupied.length, 14);
  assert.equal(occupied[0]!.name, "SOLID");

  // **Size does not distinguish them**, which is the trap this listing exists to document.
  assert.equal(new Set(entries.map((e) => e.size)).size, 1, "every slot lists the same size");
  assert.equal(occupied[0]!.size, 10_752);

  // Permissions do. An occupied kit reads as protected, so `writable` is not the inverse of empty.
  assert.equal(occupied[0]!.writable, false, "the device protects a saved kit");
  assert.equal(entries.find((e) => !e.occupied)!.writable, true);
});

test("a bank describes itself by what is in it, and says nothing when empty", () => {
  assert.equal(describeBank({ kind: "kit", bank: "A", path: "/kits/A", entries: [], used: 0 }), "A — empty");
  assert.match(
    describeBank({ kind: "kit", bank: "A", path: "/kits/A", entries: new Array(128).fill(0).map(() => ({} as never)), used: 14 }),
    /A — 14 of 128/,
  );
});
