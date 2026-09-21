/**
 * A +Drive listing is the drive only when all of it arrived.
 *
 * On 2026-09-14 the library showed a preset bank as **35 of 256** with Elektron Transfer open on the
 * same USB port, and nothing on screen said the other 221 existed. The manager already refused a
 * short listing; the library, `listProjects` and the backup each took whatever arrived. These tests
 * are the refusal, applied to every caller that decides what is on an instrument.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "../src/device/api.js";
import { listLibraryBank } from "../src/device/library.js";
import { listProjects } from "../src/device/drive.js";
import { ShortListingError, wholeListing } from "../src/device/storage.js";
import { type ApiTransport } from "../src/device/storagesession.js";

/** A listing reply that declares `declared` entries and carries the named ones. */
function page(declared: number, names: string[]): Uint8Array {
  const out: number[] = [1];
  push32(out, 0);
  push32(out, declared + 1);
  push32(out, declared);
  names.forEach((name, i) => {
    for (const ch of name) out.push(ch.charCodeAt(0));
    out.push(0, 0x00, 0x02);
    push32(out, i + 1);
    push32(out, 359);
    out.push(0x00, 0x7e, 0x01, 0x01);
  });
  return Uint8Array.from(out);
}

function push32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function answering(body: Uint8Array, terminated = true): ApiTransport {
  return {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const code = decodeMessage(request).code;
      return Promise.resolve({
        msgId, respId: msgId, code: code | RESPONSE_BIT, body, isResponse: true, terminated,
      });
    },
  };
}

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `PRESET ${i + 1}`);

test("a preset bank that arrived as 35 of 256 is refused, not shown as the bank", async () => {
  /*
   * **The report this file exists for.** Thirty-five presets and a table that looks complete is
   * worse than an error: the next thing somebody does is choose a destination slot from it.
   */
  const io = answering(page(256, names(35)));
  await assert.rejects(listLibraryBank(io, "preset", "A"), (error: unknown) => {
    assert.ok(error instanceof ShortListingError, `got ${String(error)}`);
    assert.match(error.message, /35 of the 256/);
    return true;
  });
});

test("the refusal names the cause that has actually been seen", async () => {
  // Overbridge on 2026-09-06, Transfer on 2026-09-14. A reader can close an application; a reader
  // cannot do anything with "short listing".
  const io = answering(page(256, names(35)));
  await assert.rejects(listLibraryBank(io, "preset", "A"), /close Elektron Transfer and Overbridge/);
});

test("the project list refuses 45 of 128, which is how the manager first met this", async () => {
  const io = answering(page(128, names(45)));
  await assert.rejects(listProjects(io), /45 of the 128/);
});

test("a reply with no end marker is called cut in transit, whatever it happened to parse as", async () => {
  /*
   * A fragment that ends between entries parses cleanly as a short page, and one that ends
   * mid-entry does not parse at all. Both are the same event on the wire, so both get the same
   * sentence, and the counts are included when there are any.
   */
  const body = page(256, names(35));
  await assert.rejects(listLibraryBank(answering(body, false), "preset", "A"), /cut in transit after 35 of the 256/);

  // Cut inside a name, so there is no terminator to find and the page does not parse at all.
  const midName = Uint8Array.from([...page(256, names(34)), ..."PRESE".split("").map((c) => c.charCodeAt(0))]);
  await assert.rejects(
    listLibraryBank(answering(midName, false), "preset", "A"),
    /cut in transit, \d+ bytes with no end marker/,
  );
});

test("a whole listing passes untouched", async () => {
  const bank = await listLibraryBank(answering(page(256, names(256))), "preset", "A");
  assert.equal(bank.entries.length, 256);

  const listing = wholeListing({ body: page(3, names(3)), terminated: true }, "/soundbanks/A");
  assert.deepEqual(listing.entries.map((e) => e.name), ["PRESET 1", "PRESET 2", "PRESET 3"]);
});

test("a frame that does not say whether it was terminated is judged on its entries alone", () => {
  // `terminated` is optional on the argument so a caller holding only a body is not forced to
  // invent one. Absent is not false.
  assert.equal(wholeListing({ body: page(2, names(2)) }, "/projects").entries.length, 2);
});

test("nothing decides what is on an instrument from a listing it has not checked is whole", () => {
  /*
   * **The fence.** Four callers listed a directory and one of them checked. A new one written next
   * month would be the fifth, and the only way to find out would be another bank that looks like a
   * bank. So every `parseListing(` outside `storage.ts` is found here, and the one allowed use is
   * the probe's listing card, whose job is to show a partial page *as* a partial page.
   */
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  walk(join(root, "src"));
  walk(join(root, "web", "src"));

  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel === "src/device/storage.ts") continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bparseListing\(/g)) {
      if (rel === "web/src/probe/drive.ts" && insideFunction(source, match.index, "listPath")) continue;
      offenders.push(`${rel}:${source.slice(0, match.index).split("\n").length}`);
    }
  }

  assert.deepEqual(offenders, [],
    "these read a +Drive listing without `wholeListing`, so a partial page can pass for the drive");
});

/** Whether `at` falls inside `async function <name>(` … its closing brace at column 0. */
function insideFunction(source: string, at: number, name: string): boolean {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0 || at < start) return false;
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  return end !== null && at < start + end.index;
}
