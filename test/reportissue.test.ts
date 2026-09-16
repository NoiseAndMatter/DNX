/**
 * Reporting a problem.
 *
 * The parts worth pinning are the ones a reader cannot check by looking: that DNX never posts
 * anything itself, that the report is tagged with the tool it came from, that a long one is not
 * silently truncated into a URL, and that the context block carries no project data.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  URL_LIMIT, blankIssueUrl, contextLines, issueBody, issueUrl,
} from "../web/src/reportissue.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source with its comments removed, for rules that are about code rather than prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("the tool tags the report twice: the label and the title", () => {
  /*
   * The label is what sorts the issue list, and the four were created in the repository for this.
   * The title prefix costs nothing and survives a fork whose labels are different — or a
   * repository where somebody has renamed them.
   */
  const url = issueUrl("expander", "Patterns land in the wrong slot", "body")!;
  assert.ok(url.includes("labels=expander"), "the label is set");
  assert.ok(url.includes(encodeURIComponent("[expander] ")), "and the title says it too");
});

test("the front page carries no label, because it is not a tool", () => {
  // `labels=landing` would need a label nobody created, and the front page is where the tools are
  // listed rather than one of them.
  const url = issueUrl("landing", "The boot screen never finishes", "body")!;
  assert.ok(!url.includes("labels="), "no label");
  assert.ok(url.includes(encodeURIComponent("[landing] ")), "the title still says where from");
});

test("a report too long for a URL is refused rather than truncated", () => {
  /*
   * **A report that arrives half-written is worse than one that asks for a paste.** Browsers take
   * far more than this, but a prefill is a GET and intermediaries have their own ceilings.
   */
  const short = issueUrl("manager", "s", "a short body");
  assert.ok(short && short.length <= URL_LIMIT);

  const huge = issueUrl("manager", "s", "x".repeat(URL_LIMIT));
  assert.equal(huge, undefined, "no URL rather than a clipped one");
  assert.match(blankIssueUrl(), /issues\/new$/, "and an empty form to paste into");
});

test("the context says which version, because a version is what makes a report actionable", () => {
  const lines = contextLines("library", "Digitone II · 1.11");
  assert.match(lines[0]!, /^DNX v\d+\.\d+\.\d+/, "the version leads");
  assert.ok(lines.some((l) => l === "Tool: library"));
  assert.ok(lines.some((l) => l === "Instrument: Digitone II · 1.11"));
});

test("a page with no instrument contributes no line, rather than an empty one", () => {
  const lines = contextLines("expander", undefined);
  assert.ok(!lines.some((l) => l.startsWith("Instrument:")), "nothing rather than 'Instrument: '");
});

test("the body keeps what was written, and marks where DNX's part begins", () => {
  const body = issueBody("  It **crashed**.  ", ["DNX v0.9.0-beta.1", "Tool: probe"]);
  assert.ok(body.startsWith("It **crashed**."), "trimmed, and the Markdown is untouched");
  assert.ok(body.includes("\n---\n"), "a rule before the context");
  assert.ok(body.includes("- Tool: probe"));

  const empty = issueBody("   ", ["DNX v0.9.0-beta.1"]);
  assert.match(empty, /No description given/, "an empty description says so rather than vanishing");
});

test("DNX never posts a report itself, and never holds a credential", () => {
  /*
   * **The whole design rests on this.** There is no anonymous GitHub issue API, and the two ways
   * round that — a server with a bot token, or OAuth from the page — would need either a backend
   * DNX does not have or a secret a static page cannot hold. The first would also falsify the
   * front page's own sentence, that nothing leaves this machine.
   */
  const source = readFileSync(join(ROOT, "web/src/reportissue.ts"), "utf8");
  // Comments stripped: the module explains why it holds no token, and the word in that
  // sentence is not a credential. The rule is about code.
  const code = stripComments(source);
  assert.doesNotMatch(code, /\bfetch\s*\(/, "no request is made from here");
  assert.doesNotMatch(code, /token|Authorization|client_secret/i, "and no credential exists");
  assert.match(code, /window\.open\(/, "the reader's own browser goes to GitHub");
});

test("the context block carries nothing about the reader's music", () => {
  /*
   * Project names, file names, folder names and preset names are the reader's own and they are
   * about to publish this. The block is in the preview for the same reason.
   */
  const source = readFileSync(join(ROOT, "web/src/reportissue.ts"), "utf8");
  const start = source.indexOf("export function contextLines");
  const block = source.slice(start, source.indexOf("export function issueBody"));
  for (const forbidden of ["projectName", "fileName", "folder", "preset", "slot"]) {
    assert.ok(!block.includes(forbidden), `the context must not reach for ${forbidden}`);
  }
});

test("the control says it opens a report, never that it sent one", () => {
  // Somebody who closes the GitHub tab has not reported anything. A button saying "Send" would
  // have told them they had.
  const source = readFileSync(join(ROOT, "web/src/reportissue.ts"), "utf8");
  assert.match(source, /Open a report on GitHub/);
  assert.ok(!/textContent = "Send/.test(source), "nothing here claims to send");
});

test("the button is in the shared row, so no page can be without it", () => {
  const nav = readFileSync(join(ROOT, "web/src/toolnav.ts"), "utf8");
  assert.match(nav, /renderReportLink\(nav, current\)/);
});
