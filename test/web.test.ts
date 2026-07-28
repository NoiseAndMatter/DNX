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
/**
 * Every page's entry point. Each gets its own graph walk, because the boundary can only rot
 * one page at a time — the expander was safe long before the manager existed, and a Node-only
 * import added to either would fail at runtime in the browser and nowhere else.
 */
const ENTRIES: [string, string][] = [
  ["expander", resolve(HERE, "../web/src/app.ts")],
  ["manager", resolve(HERE, "../web/src/manager/main.ts")],
];

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

for (const [name, entry] of ENTRIES) {
  test(`nothing the ${name} page imports depends on Node`, () => {
    const external = importGraph(entry);
    assert.deepEqual(
      external,
      [],
      `the ${name} page must reach only relative modules, but found:\n  ${external.join("\n  ")}`,
    );
  });
}

/** Every module reachable from an entry point, as file paths — the graph, not just its edges. */
function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) queue.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return [...seen];
}

const PAGES: [string, string, string][] = [
  ["expander", resolve(HERE, "../web/src/app.ts"), resolve(HERE, "../web/index.html")],
  ["manager", resolve(HERE, "../web/src/manager/main.ts"), resolve(HERE, "../web/manager.html")],
];

for (const [name, entry, html] of PAGES) {
  test(`every element the ${name} asks for exists in its page`, () => {
    // `$("id")` throws at load when the id is missing, so a typo or a half-wired feature takes
    // the whole page down — and nothing else catches it, because the module typechecks
    // perfectly. Same class as the `/manager` 404: correct code, wrong wiring.
    const declared = new Set(
      [...readFileSync(html, "utf8").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!),
    );

    const missing: string[] = [];
    for (const file of reachableFiles(entry)) {
      for (const match of readFileSync(file, "utf8").matchAll(/\$(?:<[^>]*>)?\("([^"]+)"\)/g)) {
        if (!declared.has(match[1]!)) missing.push(`${match[1]!} (in ${file})`);
      }
    }

    assert.deepEqual(missing, [], `the ${name} references ids its page does not define`);
  });
}

for (const [name, , html] of PAGES) {
  test(`nothing on the ${name} page overrides its own hidden attribute`, () => {
    // `hidden` works by a UA rule of `display: none`, which **any** author rule setting
    // `display` beats. `label.file { display: inline-block }` did exactly that, so a control
    // marked hidden in the markup rendered anyway — visible on load, before there was a
    // project to use it on. It typechecks, the id exists, and the test above passes.
    const markup = readFileSync(html, "utf8");
    const css = markup.slice(markup.indexOf("<style"), markup.indexOf("</style>"));

    // A blanket `[hidden] { display: none !important }` settles it for the whole page, which
    // is the fix rather than a loophole — nothing an author rule can say outranks it.
    if (/\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/.test(css)) return;

    /** Class selectors the stylesheet gives an explicit `display`, and those it exempts. */
    const displays = new Set<string>();
    const exempted = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = rule[1]!;
      if (!/(^|[^-\w])display\s*:/.test(rule[2]!)) continue;
      for (const cls of selector.matchAll(/\.([\w-]+)/g)) {
        (selector.includes("[hidden]") ? exempted : displays).add(cls[1]!);
      }
    }

    const unprotected: string[] = [];
    for (const tag of markup.matchAll(/<[a-z]+[^>]*\bhidden\b[^>]*>/g)) {
      const classes = /class="([^"]+)"/.exec(tag[0]!)?.[1]?.split(/\s+/) ?? [];
      for (const cls of classes) {
        if (displays.has(cls) && !exempted.has(cls)) {
          unprotected.push(`.${cls} — ${tag[0]!.slice(0, 60)}`);
        }
      }
    }

    assert.deepEqual(
      [...new Set(unprotected)],
      [],
      `these hidden elements carry a class whose CSS sets display, so they render anyway. ` +
        `Add a \`[hidden]\` rule restoring display:none`,
    );
  });
}

test("the manager reaches the librarian rather than reimplementing it", () => {
  // The UI holds no rules: shuffle says what a move means, rearrange plans and verifies it,
  // session holds the history. If that stops being true the browser and the CLI can disagree
  // about what a move *is*, which is the one kind of drift the existing tests cannot catch.
  const source = readFileSync(ENTRIES[1]![1], "utf8");
  for (const module of ["librarian/shuffle.js", "librarian/rearrange.js", "librarian/session.js"]) {
    assert.ok(source.includes(module), `the manager should use ${module}, not its own version`);
  }
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
