/**
 * The front page: how long the boot screen runs, and whether this browser can run DNX at all.
 *
 * (`landing.test.ts` is about where merged patterns land, which is a different landing.)
 *
 * Both subjects here carry an owner's decision, and both are easy to get subtly wrong in a way
 * nothing notices: a first run that is never a first run, or a browser check that passes on a
 * browser with no Web MIDI.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { browserSupport, folderNote, unsupportedMessage } from "../web/src/landing/browsercheck.js";
import { FIRST_RUN_MS, RETURN_MS } from "../web/src/landing/seen.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the two boot lengths are the owner's", () => {
  // Chosen on the tuning bench, 2026-09-16: long the first time anybody opens DNX, short after.
  assert.equal(FIRST_RUN_MS, 7_000);
  assert.equal(RETURN_MS, 3_500);
  assert.ok(FIRST_RUN_MS > RETURN_MS, "the first run is the long one");
});

test("the animation runs on the owner's numbers, not on the renderer's defaults", () => {
  /*
   * `idleGlitch` and `glow` are visibly different from the renderer's own 0.12 and 0.65, and were
   * set by eye against the real thing. Pinned because a later reader tidying "odd" constants back
   * towards the defaults would be undoing a decision rather than fixing a mistake.
   */
  const main = readFileSync(join(ROOT, "web/src/landing/main.ts"), "utf8");
  const chosen: [string, string][] = [
    ["idleGlitch", "0.89"], ["glow", "0.86"], ["seed", "26"], ["maxDpr", "2.5"], ["fps", "60"],
  ];
  for (const [key, value] of chosen) {
    assert.match(main, new RegExp(`${key}:\\s*${value.replace(".", "\\.")}`), `${key} is ${value}`);
  }
  assert.match(main, /respectReducedMotion:\s*true/, "reduced motion is honoured");
});

test("a browser without Web MIDI is told, not left to find out", () => {
  const none = browserSupport({} as Navigator, {} as Window);
  assert.equal(none.usable, false);
  assert.match(unsupportedMessage(none), /Chromium/);
  assert.match(unsupportedMessage(none), /Web MIDI/);
});

test("Web MIDI is what decides, because without it there is no instrument", () => {
  // A browser with MIDI and no directory picker can still do the whole job; files just download.
  const midiOnly = browserSupport(
    { requestMIDIAccess: () => undefined } as unknown as Navigator,
    {} as Window,
  );
  assert.equal(midiOnly.usable, true);
  assert.equal(unsupportedMessage(midiOnly), "", "nothing to stop them with");
  assert.match(folderNote(midiOnly), /downloads/, "but the folder is worth a word");

  const both = browserSupport(
    { requestMIDIAccess: () => undefined } as unknown as Navigator,
    { showDirectoryPicker: () => undefined } as unknown as Window,
  );
  assert.equal(folderNote(both), "", "and nothing to say when it works");
});

test("the check asks the browser what it can do, never what it calls itself", () => {
  /*
   * The user agent string has lied by design for twenty years, and a Chromium fork that renames
   * itself would be refused for no reason. Feature detection is the only honest question.
   */
  const source = readFileSync(join(ROOT, "web/src/landing/browsercheck.ts"), "utf8");
  assert.doesNotMatch(source, /userAgent/, "no sniffing");
  assert.match(source, /requestMIDIAccess/);
});

test("whether the folder is set is asked of the browser, not of a flag", () => {
  /*
   * **The trap this avoids.** A folder is a directory handle whose permission the browser can
   * withdraw. Keying the setup card off "we asked once" would mean a revoked folder is never
   * offered again while every file quietly goes to downloads instead.
   */
  const main = readFileSync(join(ROOT, "web/src/landing/main.ts"), "utf8");
  assert.match(main, /folderState\(\)/, "the card asks the browser what is true now");
  assert.doesNotMatch(main, /setupDone|hasSetUp/, "and never a flag saying it was done");
});

test("the front page is the site root and the expander is not", () => {
  const nav = readFileSync(join(ROOT, "web/src/toolnav.ts"), "utf8");
  assert.match(nav, /href: "expander\.html"/, "the expander moved off the root");
  const landing = readFileSync(join(ROOT, "web/index.html"), "utf8");
  assert.match(landing, /landing\/main\.js/, "and the root is the landing page");
});

test("the version shown is generated, never typed into a page", () => {
  // One source in package.json, written out by scripts/version.mjs before every build and every
  // verify. A hand-edited version string is wrong the first time somebody forgets.
  const main = readFileSync(join(ROOT, "web/src/landing/main.ts"), "utf8");
  assert.match(main, /DNX_BUILD/);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string; scripts: Record<string, string>;
  };
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, "a version anyone can read");
  for (const script of ["build:web", "verify"]) {
    assert.match(pkg.scripts[script]!, /scripts\/version\.mjs/, `${script} writes it first`);
  }
});
