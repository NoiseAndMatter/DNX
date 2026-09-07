/**
 * The help pages, and the three ways they rot.
 *
 * Help goes stale silently. A page describing a control that was renamed still renders, a
 * screenshot slot pointing at a file nobody captured still lays out, and a tool added without a
 * page just has no help. None of that fails a build, so it is checked here.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELP_FOR_TOOL, HELP_PAGES } from "../web/src/helppages.js";
import { mdToHtml } from "../web/src/markdown.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "docs", "help-captures.md");

test("every tool in the row opens onto a page", () => {
  /*
   * The help link opens the page for the tool you are on. A tool with no entry falls back to the
   * overview, which is a reasonable default and a poor answer to "what does this tool do".
   */
  const toolnav = readFileSync(join(ROOT, "web", "src", "toolnav.ts"), "utf8");
  const tools = [...toolnav.matchAll(/\{ id: "([a-z]+)"/g)].map((m) => m[1]!);
  assert.ok(tools.length >= 4, `found ${tools.length} tools; the scan stopped matching`);

  const keys = new Set(HELP_PAGES.map((p) => p.key));
  for (const tool of tools) {
    const page = HELP_FOR_TOOL[tool];
    assert.ok(page, `the ${tool} has no help page`);
    assert.ok(keys.has(page), `the ${tool} points at "${page}", which is not a page`);
  }
});

test("every screenshot slot has a row in the capture manifest", () => {
  /*
   * **The manifest is what says which shots are outstanding.** A slot missing from it is a
   * screenshot nobody knows is missing, and it renders as a placeholder forever without anybody
   * being reminded. CommentLab's help works the same way and for the same reason.
   */
  const manifest = readFileSync(MANIFEST, "utf8");
  const referenced = HELP_PAGES.flatMap((p) => p.sections)
    .map((s) => s.image?.src)
    .filter((src): src is string => src !== undefined);

  assert.ok(referenced.length > 10, `only ${referenced.length} slots found; the pages lost their images`);

  const missing = referenced.filter((src) => !manifest.includes(src.replace("help/", "")));
  assert.deepEqual(missing, [], "these screenshots are referenced by a page and listed nowhere");

  // And the other direction: a manifest row for a slot no page uses is a shot nobody will look at.
  const listed = [...manifest.matchAll(/^\| `([a-z0-9-]+\.png)`/gm)].map((m) => m[1]!);
  const orphans = listed.filter((file) => !referenced.some((src) => src.endsWith(file)));
  assert.deepEqual(orphans, [], "these rows describe screenshots no page references");
});

test("a screenshot on disk has been captured, and the manifest says so", () => {
  /*
   * The manifest carries a count. It is easy to write once and never update, and a stale count is
   * worse than none — somebody reads "33 of 39" and stops checking.
   */
  const present = readdirSync(join(ROOT, "web", "help")).filter((f) => f.endsWith(".png"));
  const referenced = HELP_PAGES.flatMap((p) => p.sections).filter((s) => s.image).length;
  const manifest = readFileSync(MANIFEST, "utf8");

  const stated = /\*\*(\d+) of the (\d+) referenced PNGs exist\.\*\*/.exec(manifest);
  assert.ok(stated, "the manifest must state how many of the referenced PNGs exist");
  assert.equal(Number(stated[1]), present.length,
    `the manifest says ${stated[1]} PNGs exist and web/help holds ${present.length}`);
  assert.equal(Number(stated[2]), referenced,
    `the manifest says ${stated[2]} are referenced and the pages reference ${referenced}`);
});

test("every page has an intro and at least two sections", () => {
  // A page with one section is a paragraph that wanted to be a page, and a page with no intro drops
  // the reader into a heading with no idea what the tool is.
  for (const page of HELP_PAGES) {
    assert.ok(page.intro && page.intro.trim().length > 0, `${page.key} has no intro`);
    assert.ok(page.sections.length >= 2, `${page.key} has ${page.sections.length} section(s)`);
    for (const section of page.sections) {
      assert.ok(section.heading.trim().length > 0, `${page.key} has an unnamed section`);
      assert.ok(section.body.trim().length > 40,
        `${page.key} / ${section.heading} is too short to be worth a section`);
    }
  }
});

test("every body renders, and nothing in one reaches HTML unescaped", () => {
  /*
   * The bodies are written by this project, so nothing here is hostile. They are escaped anyway:
   * the day a body is built from a project name or a device's own error text is the day that stops
   * being true, and a renderer that was safe because of who called it is not safe.
   */
  for (const page of HELP_PAGES) {
    for (const section of page.sections) {
      const html = mdToHtml(section.body);
      assert.ok(html.length > 0, `${page.key} / ${section.heading} rendered to nothing`);
      assert.doesNotMatch(html, /<script/i);
      assert.doesNotMatch(html, /\son\w+=/i, "no inline event handler may reach the page");
    }
  }
});

test("the keys are unique, because the side-nav and the tool link both address them", () => {
  const keys = HELP_PAGES.map((p) => p.key);
  assert.deepEqual([...new Set(keys)], keys, "two pages share a key");
});
