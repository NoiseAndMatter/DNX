/**
 * Whether the probe should ask which instrument it is talking to, held without a DOM.
 *
 * **The bug this pins.** Found on hardware 2026-09-15, release test PROBE-TWO-PORTS: a Digitone 1
 * and a Digitone II were both connected, `PortPicker.render()` preselected `bestPair` regardless,
 * and reads went to the wrong instrument with nothing on screen saying so. `needsPortChoice` is
 * the decision `render()` now makes before guessing, extracted as a pure function of plain
 * `{ id, name }` objects so the ambiguity rule can be checked without a browser or a device.
 *
 * Imported from `portchoice.ts` rather than `ports.ts`: `ports.ts` reaches into `MIDIAccess`'s
 * port maps with methods that only typecheck under the web build's `lib`, and importing anything
 * from it here would pull that whole file into this suite's program and fail to typecheck under
 * the root `tsconfig.json`, on code this file never touches.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { needsPortChoice, type PortLike } from "../web/src/probe/portchoice.js";

/** A minimal port, named like the real MIDI interface entries this all exists to disambiguate. */
const port = (name: string): PortLike => ({ id: name, name });

test("one Digitone: no choice needed, and the pair is still preselected", () => {
  // Exactly one plausible pair. Today's behaviour — guess it — must hold.
  const inputs = [port("Elektron Digitone")];
  const outputs = [port("Elektron Digitone")];
  assert.equal(needsPortChoice(inputs, outputs), false);
});

test("a Digitone and a Digitone II together: a choice is needed", () => {
  // The reported bug. Two confident pairs — each end named identically to its own instrument —
  // is the actual ambiguity, not a stray extra port beside one real device.
  const inputs = [port("Elektron Digitone"), port("Elektron Digitone II")];
  const outputs = [port("Elektron Digitone"), port("Elektron Digitone II")];
  assert.equal(needsPortChoice(inputs, outputs), true);
});

test("no Elektron ports: no choice needed, because there is no guess to make either", () => {
  // Unrelated names give `bestPair` nothing to guess and must not trip the ambiguity check either
  // — a stray interface with no name in common with anything is not "another instrument".
  const inputs = [port("Launchpad")];
  const outputs = [port("Some Audio Interface")];
  assert.equal(needsPortChoice(inputs, outputs), false);
});

test("one real instrument beside an unrelated port: still no choice needed", () => {
  // The common case a stricter rule (any candidate pair at all) would have broken: one genuine
  // instrument plus one unconnected output that merely exists.
  const inputs = [port("Elektron Digitone"), port("Launchpad")];
  const outputs = [port("Elektron Digitone"), port("Some Audio Interface")];
  assert.equal(needsPortChoice(inputs, outputs), false);
});

// --- source-scan: renderPorts must disable Probe (and Listen) when a choice is needed ----------

const mainSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "probe", "main.ts"),
  "utf8",
);

test("renderPorts disables probe when a choice is needed, not only when ports are empty", () => {
  // Pinned by reading the source rather than exercising the page: the probe is DOM and MIDI end
  // to end, and this is the property that regressed once already — a control left enabled with
  // nothing stopping it from sending to whichever port happened to be first.
  const start = mainSource.indexOf("function updateControls(");
  assert.ok(start > 0, "updateControls has been renamed or inlined; this fence no longer guards anything");
  const end = /\r?\n\}\r?\n/.exec(mainSource.slice(start));
  assert.ok(end, "updateControls has no closing brace at column 0");
  const body = mainSource.slice(start, start + end.index);

  assert.match(body, /needsChoice/, "the disable decision must consult whether a choice is needed");
  assert.match(
    body,
    /\$<HTMLButtonElement>\("probe"\)\.disabled = .*blocked/,
    "Probe must be disabled while a choice is outstanding",
  );
  assert.match(
    body,
    /\$<HTMLButtonElement>\("listen"\)\.disabled = .*blocked/,
    "Listen must be disabled while a choice is outstanding",
  );
});

test("probe() itself refuses when either select is empty", () => {
  // Defence beneath the disabled button: a stale click already queued, or any other call path,
  // must not fall through to whichever port the selects happen to hold.
  const start = mainSource.indexOf("async function probe(");
  assert.ok(start > 0, "probe has been renamed; this fence no longer guards anything");
  const end = /\r?\n\}\r?\n/.exec(mainSource.slice(start));
  assert.ok(end, "probe has no closing brace at column 0");
  const body = mainSource.slice(start, start + end.index);

  assert.match(body, /value === ""/, "probe must check for an unchosen select");
});
