/**
 * The web UI has to be publishable as static files, so nothing it reaches may need Node.
 *
 * That is easy to break by accident: adding one import to a shared module drags `node:zlib`
 * into the browser, and the page fails at load with an unhelpful error. These tests walk the
 * actual import graph from the app entry point and check the boundary holds, and exercise the
 * browser ZIP implementation against the library's own reader.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NO_CORPUS, corpusPath, DN1_PROJECTS } from "./corpus.js";
import { parseProject } from "../src/project/projectfile.js";
import { buildZip, crc32, readZip } from "../web/src/zip.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "../web/src/app.ts");

/** Every module reachable from the entry point, following relative imports. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const external: string[] = [];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    // Import and export statements only. A looser pattern picks up prose in doc comments —
    // "distinguish copied from ..." reads as an import to a naive regex.
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) {
        external.push(`${file} -> ${specifier}`);
        continue;
      }
      queue.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }

  return external;
}

test("nothing the web UI imports depends on Node", () => {
  const external = importGraph(ENTRY);
  assert.deepEqual(
    external,
    [],
    `the web app must reach only relative modules, but found:\n  ${external.join("\n  ")}`,
  );
});

test("the browser ZIP writer produces something the library can read", { skip: NO_CORPUS }, async () => {
  // A real project is the only honest input: it exercises a multi-megabyte deflate and the
  // exact entry names the device expects.
  const path = join(corpusPath(DN1_PROJECTS), "002 MORNING_JAM.dnprj");
  if (!existsSync(path)) return;

  const original = new Uint8Array(readFileSync(path));
  const entries = await readZip(original);
  assert.ok(entries.has("manifest.json"), "browser reader found no manifest");

  const rebuilt = await buildZip([...entries].map(([name, data]) => ({ name, data })));
  const reread = parseProject(rebuilt);

  const source = parseProject(original);
  assert.equal(reread.manifest.Payload, source.manifest.Payload);
  assert.deepEqual(reread.payload.raw, source.payload.raw, "payload changed through the browser ZIP path");
});

test("the browser reader agrees with the library reader", { skip: NO_CORPUS }, async () => {
  const path = join(corpusPath(DN1_PROJECTS), "002 MORNING_JAM.dnprj");
  if (!existsSync(path)) return;

  const bytes = new Uint8Array(readFileSync(path));
  const entries = await readZip(bytes);
  const library = parseProject(bytes);

  assert.deepEqual(entries.get(library.manifest.Payload), library.payload.raw);
});

test("crc32 matches the known ZIP checksum of a known string", () => {
  // "123456789" has a documented CRC-32 of 0xCBF43926 — a standard check value.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
