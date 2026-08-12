/**
 * The web UI has to be publishable as static files, so nothing it reaches may need Node.
 *
 * That is easy to break by accident: adding one import to a shared module drags `node:zlib`
 * into the browser, and the page fails at load with an unhelpful error. These tests walk the
 * actual import graph from the app entry point and check the boundary holds, and exercise the
 * browser ZIP implementation against the library's own reader.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NO_CORPUS, corpusPath, requireCorpusFile, DN1_PROJECTS } from "./corpus.js";
import { parseProject } from "../src/node/projectfile.js";
import { buildZip, crc32, readZip } from "../web/src/zip.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Every page's entry point. Each gets its own graph walk, because the boundary can only rot
 * one page at a time — the expander was safe long before the manager existed, and a Node-only
 * import added to either would fail at runtime in the browser and nowhere else.
 */
const ENTRIES: [string, string][] = [
  ["expander", resolve(HERE, "../web/src/expander/main.ts")],
  ["manager", resolve(HERE, "../web/src/manager/main.ts")],
  ["library", resolve(HERE, "../web/src/library/main.ts")],
  ["probe", resolve(HERE, "../web/src/probe/main.ts")],
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
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
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

/**
 * The Node boundary, checked from the other side.
 *
 * The walk above asks "does this page reach Node?", which is the question that matters at runtime.
 * This asks "does anything in `src/` depend on Node where it should not?", which is the question
 * that matters *while writing code* — a new `node:fs` import in `src/librarian/` is a mistake the
 * moment it is typed, not when a page fails to load a week later.
 *
 * Three modules used to be named one by one in `tsconfig.web.json`, so the boundary was a list
 * somebody had to remember to update. They are in `src/node/` now, the config excludes the
 * directory, and this makes the rule enforceable rather than remembered.
 */
test("only src/node and src/cli may depend on Node", () => {
  const SRC = resolve(HERE, "../src");
  const allowed = ["node", "cli"];
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!allowed.includes(entry.name) || dirname(path) !== SRC) walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/from\s+"(node:[^"]+)"/g)) {
        offenders.push(`${relative(SRC, path).split(sep).join("/")} -> ${match[1]}`);
      }
    }
  };
  walk(SRC);

  assert.deepEqual(
    offenders,
    [],
    "these are shared with the browser and must stay platform-free. Move the module to src/node/ " +
      `and give it a path-free counterpart, or take the dependency out:\n  ${offenders.join("\n  ")}`,
  );
});

test("the three Node-only modules are where the config says they are", () => {
  // The move is only worth anything while the config and the directory agree. A file put back
  // under src/project/ would compile, ship to the browser, and fail at page load.
  const config = readFileSync(resolve(HERE, "../tsconfig.web.json"), "utf8");
  assert.match(config, /"src\/node\/\*\*\/\*\.ts"/, "tsconfig.web.json must exclude the directory");
  for (const file of ["zip.ts", "projectfile.ts", "open.ts"]) {
    assert.ok(existsSync(resolve(HERE, "../src/node", file)), `src/node/${file} is missing`);
  }
});

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
  ["expander", resolve(HERE, "../web/src/expander/main.ts"), resolve(HERE, "../web/index.html")],
  ["manager", resolve(HERE, "../web/src/manager/main.ts"), resolve(HERE, "../web/manager.html")],
  ["library", resolve(HERE, "../web/src/library/main.ts"), resolve(HERE, "../web/library.html")],
  ["probe", resolve(HERE, "../web/src/probe/main.ts"), resolve(HERE, "../web/probe.html")],
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

/**
 * The chrome bar is the same bar on every page, and only `toolnav.css` describes it.
 *
 * Reported as *"the DNX title and the tools navigation buttons move depending on the tool
 * selected"*. Three causes, one shape: `.topbar` lived in `dnx.css`, the probe built its own
 * `<header>`, and `dnx.css` indented `body.page > .topbar` to match a centred content column — so
 * the brand and the tool row sat ~330px further right on the expander than on the manager at
 * 1920px, and switching tools moved the thing you were aiming at.
 *
 * The row's whole design is that each tool is a permanent screen position. A guard on the size
 * already exists; this one guards the position, which is the other half of the same promise.
 */
for (const [name, , html] of PAGES) {
  test(`the ${name}'s chrome bar is the shared one`, () => {
    const source = readFileSync(html, "utf8");
    const bar = /<(\w+)([^>]*\bclass="topbar"[^>]*)>/.exec(source);

    assert.ok(bar, `${name} must carry the shared .topbar, not a bar of its own`);
    // The brand and the tool row have to be inside it, or they are positioned by something else.
    const after = source.slice(bar.index);
    assert.match(after.slice(0, 400), /class="brand"/, `${name}'s brand belongs in the bar`);
    assert.match(after.slice(0, 400), /id="toolnav"/, `${name}'s tool row belongs in the bar`);
  });

  test(`the ${name} does not restyle the chrome bar`, () => {
    // A page with its own `<style>` may lay out its own content freely. The bar is not its content
    // — it is the same object on four pages, and a second rule for it is how they drift apart.
    const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(html, "utf8"))?.[1] ?? "";
    for (const selector of [/^\s*\.topbar\s*[,{]/m, /^\s*header\s*[,{]/m, /^\s*\.spacer\s*[,{]/m]) {
      assert.doesNotMatch(style, selector, `${name} restyles the shared bar; ${"toolnav.css"} owns it`);
    }
  });
}

/**
 * **Commands are not chrome**, and this is what keeps them out.
 *
 * Reported as *"the height of the navigation bar"* differing between tools, which was the third
 * complaint about this row in as many days — after its font size and its leading edge. Same shape
 * every time: something a page controlled was allowed to move a thing that must not move. Here it
 * was the contents. A button is taller than a badge, so a page that put ten buttons in the bar had
 * a taller bar, and the brand and the tool row sat lower on it.
 *
 * `min-height` alone would not hold: it sets a floor, and content still raises the ceiling. The
 * rule that actually holds is that the bar carries identity and navigation and nothing you can
 * press. A comment saying so lasts until the next hurried addition; this does not.
 */
/*
 * No allowlist any more. The probe was the last page with controls in its chrome bar — about thirty
 * of them — and ROADMAP 10d moved them into cards grouped by usage. The exemption existed to say
 * "known, scheduled" rather than to widen the rule, and it is gone because the work is done.
 */

for (const [name, , html] of PAGES) {
  test(`the ${name}'s chrome bar holds no commands`, () => {
    const source = readFileSync(html, "utf8");
    const open = source.indexOf('<div class="topbar">');
    const bar = source.slice(open, source.indexOf("</div>", open));

    const commands = [...bar.matchAll(/<(button|select|input|label)\b/g)].map((m) => m[1]!);
    assert.deepEqual(
      commands,
      [],
      `${name} puts ${commands.join(", ")} in the chrome bar; commands belong in a .bar below it`,
    );
  });
}

/**
 * The arrival slide's first half must run before the browser paints.
 *
 * It did not, which is why the slide never appeared: `slideIn` lived in the page's module, and
 * **module scripts are always deferred**, so the offset was applied to a page the browser had
 * already drawn at rest. `arrival.js` is a classic script in the head for exactly this reason, and
 * the ordering is the whole fix — so it is the thing worth asserting.
 */
for (const [name, , html] of PAGES) {
  test(`the ${name} applies the arrival offset before its module runs`, () => {
    const source = readFileSync(html, "utf8");
    const arrival = source.indexOf("arrival.js");
    const module = source.indexOf('type="module"');

    assert.ok(arrival >= 0, `${name} must load arrival.js, or it cannot slide`);
    assert.ok(module >= 0, `${name} should have a module entry point`);
    assert.ok(arrival < module, `${name} loads arrival.js after its module — too late to be seen`);
    // A classic script. `type="module"` on this one would defer it and reintroduce the bug in the
    // one file whose entire purpose is to run early.
    assert.doesNotMatch(
      source.slice(arrival - 60, arrival + 20),
      /type="module"/,
      `${name} loads arrival.js as a module, which defers it`,
    );
  });
}

test("the slide never transforms an ancestor of the fixed status bar", () => {
  /*
   * A transformed element becomes the containing block for every `position: fixed` descendant, so
   * transforming the body re-anchored the status bar to the body box: it arrived mid-screen and
   * snapped to the bottom when the transform came off. Visible on the expander and the library —
   * the two pages that fix their status bar — and invisible on the other two, which is exactly the
   * kind of "works on my page" difference a guard is for.
   *
   * The coupling is between two stylesheets, so the assertion checks both halves: `dnx.css` still
   * fixes the bar, and `toolnav.css` still excludes it from everything it moves.
   */
  const strip = (path: string) =>
    readFileSync(resolve(HERE, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const nav = strip("../web/toolnav.css");
  const dnx = strip("../web/dnx.css");

  const fixesStatus = /\.status\s*\{[^}]*position:\s*fixed/.test(dnx);
  assert.ok(fixesStatus, "dnx.css is expected to fix the status bar; if that changed, re-read this");

  const moving = [...nav.matchAll(/^(.*(?:slide-from-|sliding).*)\{[^}]*transform:/gm)].map(
    (m) => m[1]!.trim(),
  );
  assert.ok(moving.length >= 3, `expected the slide rules, found ${moving.length}`);
  for (const selector of moving) {
    assert.match(
      selector,
      /:not\(\.status\)/,
      `"${selector}" transforms an ancestor of the fixed status bar, which re-anchors it`,
    );
  }
});

test("only one thing decides whether the page animates", () => {
  // `arrival.js` weighs the stored preference against the system's and decides once. A CSS media
  // query that also flattened the transition would cancel that decision *after* it was made, and
  // the opt-in would look broken with nothing to point at — the same two-places-decide-one-thing
  // failure this row has already had over its size, its position and its height.
  // Comments stripped first: the file *explains* why the media query was removed, and an assertion
  // that cannot tell a rule from prose about that rule fails on its own documentation.
  const css = readFileSync(resolve(HERE, "../web/toolnav.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const arrival = readFileSync(resolve(HERE, "../web/arrival.js"), "utf8");

  assert.doesNotMatch(
    css,
    /@media[^{]*prefers-reduced-motion/,
    "the stylesheet must not overrule the decision arrival.js already made",
  );
  assert.match(arrival, /prefers-reduced-motion/, "arrival.js is where the system is consulted");
  // Honouring the system stays the default; the stored preference is what outranks it.
  assert.match(arrival, /dnx-motion/, "the override has to be readable before paint, so: storage");
});

test("the slide's start state is stamped where it can be stamped early", () => {
  // `arrival.js` runs before `<body>` exists, so `documentElement` is the only thing it can mark.
  // A rule written against `body.slide-from-*` would silently never match.
  const css = readFileSync(resolve(HERE, "../web/toolnav.css"), "utf8");
  assert.match(css, /html\.slide-from-right\s*>\s*body/);
  assert.doesNotMatch(css, /^body\.slide-from-/m, "the body cannot be marked before it exists");
});

/**
 * How much a page's own `<style>` re-declares from the shared stylesheet.
 *
 * `docs/UI-CONSISTENCY.md` measured this once and found the probe re-declaring **18** selectors
 * that `dnx.css` already defines, **ten of which disagree** — 13px against 14px, `#232a2c` against
 * `#232b2d`, `.3rem` against `.34rem`. None of those is a decision anybody made; they are what
 * happens when one component is described twice, months apart.
 *
 * Bounded rather than forbidden, because the fix is a migration and this is not it. The number may
 * fall and must not rise: a study in a document is re-read never, and a budget in a test is checked
 * on every run. Same pattern as the parity allowance in `convert.test.ts`.
 */
test("no page's own stylesheet grows its overlap with the shared one", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = (css: string): Set<string> => {
    const found = new Set<string>();
    for (const rule of strip(css).matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      const head = rule[1]!.trim();
      if (!head || head.startsWith("@")) continue;
      for (const one of head.split(",")) if (one.trim()) found.add(one.trim());
    }
    return found;
  };

  const shared = selectors(readFileSync(resolve(HERE, "../web/dnx.css"), "utf8"));
  // **Zero, for every page.** The budget was 18 while the probe kept its own copy of `.btn`,
  // `select`, `table`, `.status` and the rest; it links `dnx.css` now and keeps only the 28
  // selectors that are genuinely its own. Nothing may re-declare a shared rule again.
  const budgets: Record<string, number> = {};

  for (const [name, , html] of PAGES) {
    const own = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(html, "utf8"))?.[1];
    const overlap = own ? [...selectors(own)].filter((s) => shared.has(s)) : [];
    const budget = budgets[name] ?? 0;

    assert.ok(
      overlap.length <= budget,
      `the ${name} re-declares ${overlap.length} selector(s) dnx.css already defines, budget is ` +
        `${budget}: ${overlap.join(", ")}`,
    );
  }
});

// The name used to end "because the probe does not link dnx.css". It does — `probe.html:7` — and
// has since it stopped carrying its own copy of `.btn`, `select` and `.status`. The assertions
// below were always about something else and are unchanged; only the reason was stale.
test("only toolnav.css describes the bar, so it cannot differ between pages", () => {
  const dnx = readFileSync(resolve(HERE, "../web/dnx.css"), "utf8");
  const nav = readFileSync(resolve(HERE, "../web/toolnav.css"), "utf8");

  assert.match(nav, /^\.topbar\s*\{/m, "toolnav.css is the bar's home");
  assert.doesNotMatch(dnx, /^\.topbar\s*\{/m, "dnx.css must not define the bar as well");
  // The status line keeps its indent — it is the page's own commentary. The bar must not have it.
  assert.doesNotMatch(dnx, /body\.page\s*>\s*\.topbar/, "indenting the bar is what moved it");
});

/**
 * **A page does not explain itself in its own layout.**
 *
 * The probe opened with a 1,109-character paragraph between the controls and the results, and it
 * cost 30% of the results window at 1600x876, 41% at 1280x800, and all of it at 900x800 — where
 * `#results` was entirely below the fold before a single byte had arrived. It was not sticky
 * either: it scrolled away after 188px, so it taxed the screenful that mattered and was gone by
 * the time anyone wanted to read it.
 *
 * Nothing about that paragraph was wrong, which is the point. It was accurate, hard-won and
 * growing, and no reviewer was ever going to argue for deleting a sentence of it. A ceiling is
 * what stops the *next* one, because the pressure that produced this one has not gone anywhere —
 * the answer is a `?` and a `<template>`, and the template is exempt.
 *
 * 120 characters is roughly a sentence. The longest paragraph on any other page is 81.
 */
const PROSE_LIMIT = 120;

for (const [name, , html] of PAGES) {
  test(`the ${name} does not explain itself in its own layout`, () => {
    const source = readFileSync(html, "utf8")
      // Where the explaining is supposed to happen, and comments are for us, not for the layout.
      .replace(/<template[\s\S]*?<\/template>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");

    const long: string[] = [];
    for (const paragraph of source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const text = paragraph[1]!
        .replace(/<[^>]*>/g, "")
        .replace(/&\w+;/g, "-") // an entity is one character on screen, not seven
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > PROSE_LIMIT) long.push(`${text.length} chars: ${text.slice(0, 60)}…`);
    }

    assert.deepEqual(
      long,
      [],
      `the ${name} carries prose in its layout, over ${PROSE_LIMIT} chars. Move it into the ` +
        `<template id="help"> and reach it from a data-help "?" — see web/src/help.ts`,
    );
  });

  /**
   * `data-help` and `data-topic` are a pairing nothing else checks.
   *
   * A renamed topic leaves a `?` that opens the panel on no section at all, and a renamed
   * `data-help` leaves a section nothing can reach. Both typecheck, both render, and the page
   * looks entirely correct until somebody presses the button. Same silent-pairing shape as the
   * legend swatches that rendered as empty boxes for want of a `.sw` rule.
   */
  test(`every ? on the ${name} opens onto a topic, and every topic has a ?`, () => {
    const source = readFileSync(html, "utf8");
    const asked = [...source.matchAll(/\bdata-help="([^"]*)"/g)].map((m) => m[1]!);
    const offered = [...source.matchAll(/\bdata-topic="([^"]*)"/g)].map((m) => m[1]!);

    assert.deepEqual(
      asked.filter((topic) => !offered.includes(topic)),
      [],
      `the ${name} has a "?" for a topic its help template does not define`,
    );
    assert.deepEqual(
      offered.filter((topic) => !asked.includes(topic)),
      [],
      `the ${name}'s help template defines a topic nothing on the page opens`,
    );
    // A page with help at all needs the template `installHelp` is handed, and `$("help")` throws
    // at load if it is missing — but only on the page that asks, and only once it is opened.
    if (asked.length) assert.match(source, /<template id="help">/, `${name} has ? but no template`);
  });
}

for (const [name, entry, html] of PAGES) {
  test(`the ${name}'s status bar is a status bar`, () => {
    // `statusbar.ts` styles everything off the `status` class: panel background, top border, and on
    // a flowing page the pinning that keeps it in view. A page that spells the element differently
    // gets an unstyled line of text at the left edge — which is exactly what the expander showed
    // for as long as its status writer rebuilt `className` from an empty base.
    const uses = reachableFiles(entry).some((f) => f.endsWith(`statusbar.ts`));
    if (!uses) return;

    const markup = readFileSync(html, "utf8");
    const element = /<div[^>]*id="status"[^>]*>/.exec(markup)?.[0];
    assert.ok(element, `the ${name} writes status messages but its page has no #status`);

    const classes = (/class="([^"]*)"/.exec(element)?.[1] ?? "").split(/\s+/);
    assert.ok(classes.includes("status"), `#status on the ${name} lacks the status class: ${element}`);
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

test("patterns and tracks are laid out on the same grid", () => {
  // Both are drag targets, and a drag that behaves the same should look the same. The track grid
  // was four across while patterns were eight, which the user reported as harder to drag around.
  //
  // Asserted as an *absence*: the track grid must not restate the column count, because two
  // numbers that have to agree are two numbers that can disagree. If a future layout genuinely
  // needs them to differ, rewrite this test with the reason rather than deleting it.
  // The stylesheet is shared by every page now, so this reads the file rather than one page's
  // inline block — which is also why it is worth asserting: a layout every tool inherits.
  const markup = readFileSync(resolve(HERE, "../web/dnx.css"), "utf8");

  const base = /\.grid\s*\{[^}]*grid-template-columns:\s*repeat\((\d+)/.exec(markup);
  assert.ok(base, ".grid no longer sets grid-template-columns");
  assert.equal(base[1], "8", "a bank of 16 patterns should read as two rows of eight");

  const tracks = /\.grid\.tracks\s*\{([^}]*)\}/.exec(markup);
  if (tracks) {
    assert.ok(
      !/grid-template-columns/.test(tracks[1]!),
      "the track grid overrides the column count again — it should inherit the pattern grid's",
    );
  }
});

test("every state the grid paints on a cell has a rule in the shared stylesheet", () => {
  // The grid adds classes; the stylesheet colours them. Neither side fails when the other is
  // missing — the cell simply renders as though nothing happened, which is precisely how a drop
  // that worked came to look like a drop that did not.
  const grid = readFileSync(resolve(HERE, "../web/src/grid.ts"), "utf8");
  const css = readFileSync(resolve(HERE, "../web/dnx.css"), "utf8");

  const added = [...grid.matchAll(/classList\.add\("([a-z-]+)"\)/g)].map((m) => m[1]!);
  assert.ok(added.length >= 3, `found ${added.length} classes the grid adds, expected several`);

  // A plain substring rather than a built regex: the class names are literals, and escaping dots
  // into a template string is how this test first reported `.slot.dragging` as missing while it sat
  // in the stylesheet.
  const unstyled = [...new Set(added)].filter((name) => !css.includes(`.slot.${name}`));
  assert.deepEqual(unstyled, [], "these grid states have no `.slot.<state>` rule and render as nothing");
});

test("every drop action has a colour in the shared stylesheet", () => {
  // `dropHint` puts the action's own name on the cell as a class, so its hue comes from a rule
  // named after it. A fourth action would typecheck, name itself correctly, draw its label — and
  // be styled like nothing at all, silently, because a missing CSS rule is not an error.
  //
  // The actions are read out of the module that declares them rather than listed here. A copy of
  // the list is a copy that goes stale, and going stale is the thing this test exists to catch —
  // which is also why this reads `dropaction.ts` now: the union moved there precisely so a shared
  // grid would stop depending on one page's folder for how it paints itself.
  const rules = readFileSync(resolve(HERE, "../web/src/dropaction.ts"), "utf8");
  const union = /export type DropAction =([^;]+);/.exec(rules);
  assert.ok(union, "DropAction is no longer a string union — rewrite this test, do not delete it");

  const actions = [...union[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(actions.length >= 3, `found ${actions.length} drop actions, expected at least 3`);

  const css = readFileSync(resolve(HERE, "../web/dnx.css"), "utf8");

  const unstyled = actions.filter(
    (action) => !new RegExp(`\\.slot\\.target\\.${action}\\b`).test(css),
  );
  assert.deepEqual(unstyled, [], "these drop actions have no `.slot.target.<action>` rule");
});

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
  const path = requireCorpusFile(DN1_PROJECTS, "002 MORNING_JAM.dnprj");

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
  const path = requireCorpusFile(DN1_PROJECTS, "002 MORNING_JAM.dnprj");

  const bytes = new Uint8Array(readFileSync(path));
  const entries = await readZip(bytes);
  const library = parseProject(bytes);

  assert.deepEqual(entries.get(library.manifest.Payload), library.payload.raw);
});

test("crc32 matches the known ZIP checksum of a known string", () => {
  // "123456789" has a documented CRC-32 of 0xCBF43926 — a standard check value.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
